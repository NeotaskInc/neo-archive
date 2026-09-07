// @vitest-environment node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildTestProfile, useTestHome } from "../test/test-home";
import { ArchiveImportPlan } from "./archive-import-plan";
import {
	applyArchiveImportPlanEffect,
	type ApplyArchiveImportParams,
} from "./archive/apply";
import { runEffectPromise } from "./effect-runtime";
import { ImportRepository } from "./import-repository";
import { nativeBinary } from "./native-archive";

const home = useTestHome();
beforeEach(() => {
	process.env.NEO_ARCHIVE_CORE_BINARY ??= path.resolve(
		import.meta.dirname,
		"../../rust/target/release/neoarchive-core",
	);
	if (!existsSync(nativeBinary()))
		throw new Error("Build the native core before integration tests");
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-09-07T12:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

function snapshot() {
	const db = home().db;
	const tables = db
		.prepare(
			"select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name",
		)
		.all() as { name: string }[];
	return Object.fromEntries(
		tables
			.filter(
				({ name }) =>
					!name.startsWith("tweets_fts_") && !name.startsWith("dm_fts_"),
			)
			.map(({ name }) => {
				const rows = db
					.prepare(`select * from "${name.replaceAll('"', '""')}"`)
					.all() as Record<string, unknown>[];
				if (name === "follow_events") for (const row of rows) delete row.id; // Independent UUIDs have no downstream references.
				return [
					name,
					rows.sort((a, b) =>
						JSON.stringify(a).localeCompare(JSON.stringify(b)),
					),
				];
			}),
	);
}
function plan() {
	const plan = new ArchiveImportPlan();
	const profile = buildTestProfile({ id: "owner" });
	plan.profiles.set(profile.id, profile);
	plan.profiles.set("peer", buildTestProfile({ id: "peer", handle: "peer" }));
	for (const [id, history, deletedAt] of [
		["1", ["1", "2"], null],
		["2", ["1", "2"], "2026-01-02"],
		["3", ["3"], null],
	] as const) {
		plan.addTweet({
			id,
			kind: "home",
			authorProfileId: "profile_me",
			text: `café 東京 ${id}`,
			createdAt: "2026-01-01",
			isReplied: 0,
			replyToId: null,
			likeCount: 1,
			mediaCount: 1,
			bookmarked: 1,
			liked: 1,
			entitiesJson: "{}",
			mediaJson: '[{"media_key":"photo"}]',
			quotedTweetId: null,
			deletedAt,
			deletionSource: deletedAt ? "twitter_archive" : null,
			deletionReason: deletedAt ? "explicit_deleted_tweet_record" : null,
			editHistoryIds: [...history],
			rawJson: JSON.stringify({ id }),
		});
		for (const kind of ["likes", "bookmarks"] as const)
			plan.collections.push({
				tweetId: id,
				kind,
				collectedAt: "2026-01-01",
				source: "archive",
				rawJson: "{}",
			});
	}
	plan.conversations.set("conversation", {
		id: "conversation",
		accountId: "account",
		participantProfileId: "peer",
		title: "Messages",
		lastMessageAt: "2026-01-01",
		unreadCount: 1,
		needsReply: 1,
	});
	plan.dmMessages.push({
		id: "message",
		conversationId: "conversation",
		senderProfileId: "peer",
		text: "message café",
		createdAt: "2026-01-01",
		direction: "inbound",
		mediaCount: 0,
	});
	plan.followers.push({ profileId: "peer", externalUserId: "2" });
	plan.following.push({ profileId: "peer", externalUserId: "2" });
	return { plan, profile };
}
function params(): ApplyArchiveImportParams {
	const { plan: archivePlan, profile } = plan();
	const db = home().db;
	return {
		accountId: "account",
		archivePath: "synthetic.zip",
		db,
		repository: new ImportRepository(db),
		selection: null,
		includeTweets: true,
		includeLikes: true,
		includeBookmarks: true,
		includeDirectMessages: true,
		includeProfiles: true,
		includeFollowers: true,
		includeFollowing: true,
		accountPayload: {
			accountId: "1",
			username: "owner",
			displayName: "Owner",
			createdAt: "2020-01-01",
			bio: "",
		},
		localProfile: profile,
		plan: archivePlan,
		resolveProfileId: (id) => id,
		followerEntryCount: 1,
		followingEntryCount: 1,
		onProgress: () => {},
		restore: false,
	};
}

it("preserves every logical table through imports, reimports, and restore", async () => {
	const results = [];
	for (const backend of ["sqlite", "rust"]) {
		home().switchHome();
		process.env.NEO_ARCHIVE_IMPORT_BACKEND = backend;
		const request = params();
		await runEffectPromise(applyArchiveImportPlanEffect(request));
		await runEffectPromise(applyArchiveImportPlanEffect(request));
		const merged = snapshot();
		await runEffectPromise(
			applyArchiveImportPlanEffect({ ...request, restore: true }),
		);
		results.push({ merged, restored: snapshot() });
	}
	expect(results[1]).toEqual(results[0]);
});

it("rolls back incomplete and count-mismatched streams", () => {
	const header = {
		protocolVersion: 1,
		kind: "header",
		accountId: "account",
		importedAt: "2026-01-01",
		localProfileId: "owner",
		tweetIds: [],
		dmIds: [],
		counts: {},
		accountPayload: {
			accountId: "1",
			username: "owner",
			displayName: "Owner",
			createdAt: "2020-01-01",
		},
	};
	const db = home().db;
	const before = snapshot();
	for (const input of [
		JSON.stringify(header) + "\n",
		JSON.stringify({ ...header, counts: { tweet: 1 } }) + '\n{"kind":"end"}\n',
	]) {
		const result = spawnSync(
			nativeBinary(),
			["import", "--db", String(db.writeIdentity)],
			{ input, encoding: "utf8" },
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/incomplete import|count mismatch/);
		expect(snapshot()).toEqual(before);
	}
});
