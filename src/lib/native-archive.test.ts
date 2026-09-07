// @vitest-environment node
import { existsSync } from "node:fs";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import * as nativeArchive from "./native-archive";
import {
	insertTestAccount,
	insertTestProfile,
	insertTestTweet,
	useTestHome,
} from "../test/test-home";
import { getReadDb } from "./db";
import { listTimelineItems } from "./timeline-read-model";
import type { TimelineQuery } from "./types";

const home = useTestHome();
beforeEach(() => {
	const binary =
		process.env.NEO_ARCHIVE_CORE_BINARY ??
		path.resolve(
			import.meta.dirname,
			"../../rust/target/release/neoarchive-core",
		);
	if (!existsSync(binary))
		throw new Error(
			"Build the native core before running integration tests: cargo build --release --manifest-path rust/Cargo.toml",
		);
	process.env.NEO_ARCHIVE_CORE_BINARY = binary;
});

function compare(query: TimelineQuery) {
	process.env.NEO_ARCHIVE_SEARCH_BACKEND = "sqlite";
	const expected = listTimelineItems(query, getReadDb({ seedDemoData: false }));
	process.env.NEO_ARCHIVE_SEARCH_BACKEND = "rust";
	const actual = listTimelineItems(query, getReadDb({ seedDemoData: false }));
	expect(actual).toEqual(expected);
	return actual;
}

it("preserves full output and account collection scope through the real Rust process", () => {
	const db = home().db;
	insertTestAccount(db, { id: "a", handle: "@a", externalUserId: "1" });
	insertTestAccount(db, {
		id: "b",
		handle: "@b",
		externalUserId: "2",
		isDefault: 0,
	});
	insertTestProfile(db);
	for (const [id, text] of [
		["1", "café naïve 東京 rust compiler"],
		["2", "rust only"],
		["3", "compiler only"],
		["4", "rust compiler foo_bar"],
	]) {
		insertTestTweet(db, { id, text });
		db.prepare("insert into tweets_fts(tweet_id,text) values (?,?)").run(
			id,
			text,
		);
		for (const account of ["a", "b"]) {
			db.prepare(
				"insert into tweet_account_edges(account_id,tweet_id,kind,first_seen_at,last_seen_at,seen_count,source,raw_json,updated_at) values (?,?,'authored','2026-01-01','2026-01-01',1,'archive','{}','2026-01-01')",
			).run(account, id);
		}
	}
	for (const [account, id, kind] of [
		["a", "1", "likes"],
		["b", "1", "bookmarks"],
		["a", "4", "likes"],
		["a", "4", "bookmarks"],
	]) {
		db.prepare(
			"insert into tweet_collections(account_id,tweet_id,kind,collected_at,source,raw_json,updated_at) values (?,?,?,'2026-01-01','archive','{}','2026-01-01')",
		).run(account, id, kind);
	}
	for (const search of [
		"rust",
		"rust compiler",
		"cafe",
		"東京",
		"foo_bar",
		"missing",
		"_",
	]) {
		compare({ resource: "authored", search, limit: 20 });
		compare({ resource: "authored", search, account: "b", limit: 20 });
	}
	expect(
		compare({
			resource: "home",
			search: "rust",
			likedOnly: true,
			bookmarkedOnly: true,
			limit: 20,
		}).map((row) => row.id),
	).toEqual(["4"]);
	db.prepare(
		"insert into tweet_collections(account_id,tweet_id,kind,collected_at,source,raw_json,updated_at) values ('a','1','bookmarks','2026-01-01','archive','{}','2026-01-01')",
	).run();
	expect(
		compare({
			resource: "home",
			search: "rust",
			likedOnly: true,
			bookmarkedOnly: true,
			limit: 20,
		}).map((row) => row.id),
	).toEqual(["4", "1"]);
	db.prepare("update tweets set deleted_at='2026-02-01' where id='4'").run();
	compare({ resource: "authored", search: "rust", limit: 20 });
});

it("keeps literal account boundaries and the existing advanced filters", () => {
	const db = home().db;
	insertTestAccount(db, { id: "a", handle: "@a" });
	insertTestProfile(db);
	insertTestTweet(db, { id: "1", text: "rust compiler" });
	db.exec(
		"insert into tweets_fts(tweet_id,text) values ('1','rust compiler'); insert into tweet_account_edges(account_id,tweet_id,kind,first_seen_at,last_seen_at,seen_count,source,raw_json,updated_at) values ('a','1','authored','2026-01-01','2026-01-01',1,'archive','{}','2026-01-01')",
	);
	process.env.NEO_ARCHIVE_SEARCH_BACKEND = "rust";
	expect(
		listTimelineItems(
			{ resource: "authored", search: "rust", limit: 20 },
			getReadDb(),
			{ literalAccountId: "all" },
		),
	).toEqual([]);
	compare({
		resource: "authored",
		search: "rust",
		since: "2026-02-01",
		limit: 20,
	});
	compare({
		resource: "authored",
		search: "rust",
		qualityFilter: "summary",
		limit: 20,
	});
});

it("retries when a writer changes the archive between native selection and hydration", () => {
	const db = home().db;
	insertTestAccount(db, { id: "a", handle: "@a" });
	insertTestProfile(db);
	insertTestTweet(db, { id: "1", text: "rust compiler" });
	db.exec(
		"insert into tweets_fts(tweet_id,text) values ('1','rust compiler'); insert into tweet_account_edges(account_id,tweet_id,kind,first_seen_at,last_seen_at,seen_count,source,raw_json,updated_at) values ('a','1','authored','2026-01-01','2026-01-01',1,'archive','{}','2026-01-01')",
	);
	const realSearch = nativeArchive.searchNativeArchive;
	const spy = vi
		.spyOn(nativeArchive, "searchNativeArchive")
		.mockImplementationOnce((...args) => {
			const page = realSearch(...args);
			db.transaction(() => {
				db.exec(
					"update tweets set text='updated unrelated content' where id='1'; delete from tweets_fts where tweet_id='1'; insert into tweets_fts(tweet_id,text) values ('1','updated unrelated content')",
				);
			})();
			return page;
		});
	try {
		process.env.NEO_ARCHIVE_SEARCH_BACKEND = "rust";
		expect(
			listTimelineItems(
				{ resource: "authored", search: "rust", limit: 20 },
				getReadDb(),
			),
		).toEqual([]);
		expect(spy).toHaveBeenCalledTimes(2);
		compare({ resource: "authored", search: "updated", limit: 20 });
	} finally {
		spy.mockRestore();
	}
});

it("keeps uncommitted writes in their owning SQLite transaction", () => {
	const db = home().db;
	const native = vi.spyOn(nativeArchive, "searchNativeArchive");
	try {
		db.transaction(() => {
			insertTestAccount(db);
			insertTestProfile(db);
			insertTestTweet(db, { id: "uncommitted", text: "transactionword" });
			db.prepare("insert into tweets_fts(tweet_id,text) values (?,?)").run(
				"uncommitted",
				"transactionword",
			);
			db.prepare(
				"insert into tweet_account_edges(account_id,tweet_id,kind,first_seen_at,last_seen_at,seen_count,source,raw_json,updated_at) values (?, ?, 'home', '2026-01-01', '2026-01-01', 1, 'archive', '{}', '2026-01-01')",
			).run("account:test", "uncommitted");
			const query = {
				resource: "home" as const,
				search: "transactionword",
				limit: 20,
			};
			expect(nativeArchive.canSearchNativeArchive(query, db)).toBe(false);
			expect(listTimelineItems(query, db).map((item) => item.id)).toContain(
				"uncommitted",
			);
			expect(native).not.toHaveBeenCalled();
		})();
	} finally {
		native.mockRestore();
	}
});
