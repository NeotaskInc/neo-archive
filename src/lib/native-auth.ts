import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { nativeBinary } from "./native-archive";

export interface NativeAuthCandidate {
	app?: string;
	username?: string;
}
export interface NativeAuthCommand {
	kind: "json" | "text";
	args: string[];
	probe: boolean;
}
export function canUseNativeAuth() {
	const backend = process.env.NEO_ARCHIVE_AUTH_BACKEND;
	if (backend === "typescript") return false;
	if (backend && backend !== "rust")
		throw new Error("NEO_ARCHIVE_AUTH_BACKEND must be rust or typescript");
	if (!existsSync(nativeBinary())) {
		if (backend === "rust")
			throw new Error(
				"Rust authentication core is missing; run the native build",
			);
		return false;
	}
	return true;
}

/** Rust owns account selection; the existing transport retains retries and cancellation. */
export async function routeNativeAuth(
	request: {
		args: string[];
		username?: string;
		configured?: NativeAuthCandidate;
		cached?: NativeAuthCandidate;
	},
	execute: (command: NativeAuthCommand) => Promise<unknown>,
	updateCache: (
		candidate: NativeAuthCandidate | undefined,
		clear: boolean,
	) => void,
	signal: AbortSignal,
): Promise<Record<string, unknown>> {
	if (signal.aborted) throw new Error("Authentication aborted");
	const child = spawn(nativeBinary(), ["auth"], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (data: string) => {
		stderr += data;
	});
	const errors: unknown[] = [];
	const abort = () => {
		child.kill();
	};
	signal.addEventListener("abort", abort, { once: true });
	let spawnError: Error | undefined;
	child.once("error", (error) => {
		spawnError = error;
	});
	const exited = new Promise<void>((resolve) =>
		child.once("close", () => resolve()),
	);
	const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
	// A failed/closed child must not turn an EPIPE into an unhandled process error.
	child.stdin.on("error", (error) => {
		spawnError = error;
	});
	try {
		child.stdin.write(
			`${JSON.stringify({ ...request, protocolVersion: 1, configured: request.configured ?? null, cached: request.cached ?? null })}\n`,
		);
		for await (const line of lines) {
			const message = JSON.parse(line) as {
				kind: string;
				args?: string[];
				probe?: boolean;
				payload?: Record<string, unknown>;
				errorId?: number;
				cache?: NativeAuthCandidate;
				clearCache?: boolean;
			};
			if (message.kind === "done" || message.kind === "error") {
				child.stdin.end();
				await exited;
				if (spawnError) throw spawnError;
				if (child.exitCode !== 0)
					throw new Error(`Rust authentication failed: ${stderr.trim()}`);
				updateCache(message.cache, Boolean(message.clearCache));
				if (message.kind === "error")
					throw (
						errors[message.errorId ?? -1] ??
						new Error("Rust authentication returned an unknown error")
					);
				if (!message.payload || typeof message.payload !== "object")
					throw new Error("Rust authentication returned an invalid payload");
				return message.payload;
			}
			if (
				(message.kind !== "json" && message.kind !== "text") ||
				!Array.isArray(message.args) ||
				message.args.some((arg) => typeof arg !== "string")
			)
				throw new Error(
					"Rust authentication returned an invalid transport request",
				);
			let response: unknown;
			try {
				const result = await execute({
					kind: message.kind,
					args: message.args,
					probe: Boolean(message.probe),
				});
				response =
					message.kind === "text"
						? { ok: true, ...(result as { stdout: string }) }
						: { ok: true, payload: result };
			} catch (error) {
				const errorId = errors.push(error) - 1;
				response = { ok: false, errorId };
			}
			if (signal.aborted) throw new Error("Authentication aborted");
			child.stdin.write(`${JSON.stringify(response)}\n`);
		}
		await exited;
		throw (
			spawnError ??
			new Error(`Rust authentication closed without a result: ${stderr.trim()}`)
		);
	} finally {
		signal.removeEventListener("abort", abort);
		lines.close();
		child.stdin.end();
		if (child.exitCode === null && child.signalCode === null) child.kill();
		await exited;
	}
}
