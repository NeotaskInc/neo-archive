import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Database } from "./sqlite";
import type { TimelineQuery } from "./types";

export interface NativeSearchPage {
	protocolVersion: 1;
	instanceId: string;
	generation: number;
	ids: string[];
	exhausted: boolean;
	rebuilt: boolean;
}

export function nativeBinary() {
	return (
		process.env.NEO_ARCHIVE_CORE_BINARY ||
		fileURLToPath(new URL("../../dist/native/neoarchive-core", import.meta.url))
	);
}

export function canSearchNativeArchive(query: TimelineQuery, db: Database) {
	const backend = process.env.NEO_ARCHIVE_SEARCH_BACKEND;
	if (backend === "sqlite") return false;
	if (backend && backend !== "rust") {
		throw new Error("NEO_ARCHIVE_SEARCH_BACKEND must be rust or sqlite");
	}
	if (!existsSync(nativeBinary())) {
		if (backend === "rust") {
			throw new Error(
				"Rust search core is missing; run the native build or select the sqlite backend",
			);
		}
		return false;
	}
	// These filters retain their existing SQLite execution path until their
	// native equivalents have passed differential and performance checks.
	return (
		typeof db.writeIdentity === "string" &&
		!db.inTransaction &&
		Boolean(query.search?.trim()) &&
		(query.limit ?? 18) > 0 &&
		(query.limit ?? 18) <= 1_000_000 &&
		!query.listId &&
		!query.since?.trim() &&
		!query.until?.trim() &&
		query.includeReplies !== false &&
		(!query.replyFilter || query.replyFilter === "all") &&
		(!query.qualityFilter || query.qualityFilter === "all")
	);
}

export function searchNativeArchive(
	query: TimelineQuery,
	db: Database,
	options: { literalAccountId?: string; offset: number; limit: number },
): NativeSearchPage {
	if (typeof db.writeIdentity !== "string") {
		throw new Error("Native search requires a file-backed archive");
	}
	const accountId =
		options.literalAccountId ??
		(query.account && query.account !== "all" ? query.account : undefined);
	const result = spawnSync(
		nativeBinary(),
		[
			"search",
			"--db",
			db.writeIdentity,
			"--index",
			`${db.writeIdentity}.tantivy`,
		],
		{
			input: JSON.stringify({
				query: query.search ?? "",
				accountId,
				resource: query.resource,
				liked: Boolean(query.likedOnly),
				bookmarked: Boolean(query.bookmarkedOnly),
				limit: options.limit,
				offset: options.offset,
			}),
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		},
	);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`Rust archive search failed: ${result.stderr.trim() || result.signal || String(result.status)}`,
		);
	}
	const parsed = JSON.parse(result.stdout) as NativeSearchPage;
	if (
		parsed.protocolVersion !== 1 ||
		typeof parsed.instanceId !== "string" ||
		!Number.isSafeInteger(parsed.generation) ||
		parsed.generation < 0 ||
		!Array.isArray(parsed.ids) ||
		parsed.ids.some((id) => typeof id !== "string") ||
		parsed.ids.length > options.limit ||
		typeof parsed.exhausted !== "boolean"
	) {
		throw new Error("Rust archive search returned an incompatible response");
	}
	return parsed;
}

export function nativeSearchMatchesSnapshot(
	db: Database,
	page: NativeSearchPage,
) {
	const state = db
		.prepare(
			"select instance_id, generation from neo_archive_search_generation where singleton = 1",
		)
		.get() as { instance_id: string; generation: number } | undefined;
	return (
		state?.instance_id === page.instanceId &&
		state.generation === page.generation
	);
}
