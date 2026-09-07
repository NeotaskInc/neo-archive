// @vitest-environment node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Effect, Fiber } from "effect";
import { beforeEach, expect, it, vi } from "vitest";
import { useTestHome } from "../test/test-home";
import { runEffectPromise } from "./effect-runtime";
import { nativeBinary } from "./native-archive";

const home = useTestHome();
beforeEach(() => {
	vi.resetModules();
	process.env.NEO_ARCHIVE_CORE_BINARY ??= path.resolve(
		import.meta.dirname,
		"../../rust/target/release/neoarchive-core",
	);
	if (!existsSync(nativeBinary()))
		throw new Error("Build the native core before integration tests");
	process.env.NEO_ARCHIVE_AUTH_BACKEND = "rust";
	delete process.env.NEO_ARCHIVE_XURL_OAUTH2_APP;
	delete process.env.NEO_ARCHIVE_XURL_OAUTH2_USERNAME;
});
function fixture(wait = false) {
	const root = home().makeTempDir("native-xurl-");
	const log = path.join(root, "commands.jsonl");
	const pid = path.join(root, "pid");
	const script = `#!/usr/bin/env node
const fs=require("node:fs");const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+"\\n");
if(args[0]==="auth"){process.stdout.write("app [client_id: synthetic]\\n oauth2: alias\\n");}
else if(args.at(-1)==="/2/users/me"){process.stdout.write(JSON.stringify({data:{id:"42",username:"owner"}}));}
else if(${JSON.stringify(wait)}){fs.writeFileSync(${JSON.stringify(pid)},String(process.pid));setInterval(()=>{},1000);}
else{process.stdout.write(JSON.stringify({data:{id:"42",username:"owner"}}));}
`;
	writeFileSync(path.join(root, "xurl"), script, { mode: 0o755 });
	process.env.PATH = `${root}${path.delimiter}${process.env.PATH}`;
	return { log, pid };
}
async function waitFor(test: () => boolean) {
	const deadline = Date.now() + 3000;
	while (!test()) {
		if (Date.now() > deadline)
			throw new Error("Timed out waiting for fixture process");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
it("verifies an account alias through the real xurl executable boundary", async () => {
	const { log } = fixture();
	const { lookupAuthenticatedOAuth2UserEffect } = await import("./xurl");
	expect(
		await runEffectPromise(lookupAuthenticatedOAuth2UserEffect("owner")),
	).toEqual({ id: "42", username: "owner" });
	expect(
		readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line)),
	).toEqual([
		["auth", "status"],
		["--app", "app", "--auth", "oauth2", "--username", "alias", "/2/users/me"],
		["--app", "app", "--auth", "oauth2", "--username", "alias", "whoami"],
	]);
});
it("interrupts the active xurl process when native authentication is cancelled", async () => {
	const { pid } = fixture(true);
	const { lookupAuthenticatedOAuth2UserEffect } = await import("./xurl");
	const fiber = Effect.runFork(lookupAuthenticatedOAuth2UserEffect("owner"));
	try {
		await waitFor(() => existsSync(pid));
		const childPid = Number(readFileSync(pid, "utf8"));
		await Effect.runPromise(Fiber.interrupt(fiber));
		await waitFor(() => {
			try {
				process.kill(childPid, 0);
				return false;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				return true;
			}
		});
		expect(() => process.kill(childPid, 0)).toThrow(
			expect.objectContaining({ code: "ESRCH" }),
		);
	} finally {
		await Effect.runPromise(Fiber.interrupt(fiber));
	}
});
