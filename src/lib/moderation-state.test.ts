// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetNeoArchivePathsForTests } from "./config";
import { getNativeDb, resetDatabaseForTests } from "./db";
import {
	listModerationState,
	pruneRemoteModerationRows,
	recordModeration,
	recordModerationRow,
	recordRemoteModerationRow,
	removeModerationRow,
	searchModerationCandidates,
	type ModerationKind,
} from "./moderation-state";

const contracts = [
	{
		kind: "block",
		table: "blocks",
		timestampKey: "blockedAt",
		predicateKey: "isBlocked",
		recordAction: "record-block",
	},
	{
		kind: "mute",
		table: "mutes",
		timestampKey: "mutedAt",
		predicateKey: "isMuted",
		recordAction: "record-mute",
	},
] as const;

let tempRoot: string;

function insertProfile(id: string, handle: string) {
	getNativeDb()
		.prepare(
			`insert into profiles
        (id, handle, display_name, bio, followers_count, avatar_hue, created_at)
       values (?, ?, ?, 'contract profile', 10, 20, '2026-01-01T00:00:00.000Z')`,
		)
		.run(id, handle, handle);
}

beforeEach(() => {
	tempRoot = mkdtempSync(
		path.join(os.tmpdir(), "neo-archive-moderation-state-"),
	);
	process.env.NEO_ARCHIVE_HOME = tempRoot;
	resetNeoArchivePathsForTests();
	resetDatabaseForTests();
});

afterEach(() => {
	resetDatabaseForTests();
	resetNeoArchivePathsForTests();
	delete process.env.NEO_ARCHIVE_HOME;
	rmSync(tempRoot, { recursive: true, force: true });
});

describe.each(contracts)("$kind moderation state contract", (contract) => {
	it("records, lists, searches, updates, and removes local state", async () => {
		insertProfile("profile_contract", `contract_${contract.kind}`);

		const result = await recordModeration(
			contract.kind,
			"acct_primary",
			`contract_${contract.kind}`,
		);
		expect(result).toMatchObject({
			ok: true,
			action: contract.recordAction,
			accountId: "acct_primary",
			profile: { id: "profile_contract" },
		});
		expect(result[contract.timestampKey]).toEqual(expect.any(String));

		const listed = listModerationState(contract.kind, {
			account: "acct_primary",
			search: `contract_${contract.kind}`,
		});
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({
			accountId: "acct_primary",
			accountHandle: "@steipete",
			source: "manual",
			profile: { id: "profile_contract" },
		});
		expect(listed[0]?.[contract.timestampKey]).toBe(
			result[contract.timestampKey],
		);
		expect(
			listModerationState(contract.kind, { account: "acct_studio" }),
		).toEqual([]);

		const candidates = searchModerationCandidates(contract.kind, {
			accountId: "acct_primary",
			search: `contract_${contract.kind}`,
		});
		expect(candidates[0]?.[contract.predicateKey]).toBe(true);
		expect(candidates[0]?.[contract.timestampKey]).toBe(
			result[contract.timestampKey],
		);

		const replacement = "2026-02-01T00:00:00.000Z";
		recordModerationRow(
			getNativeDb(),
			contract.kind,
			"acct_primary",
			"profile_contract",
			replacement,
		);
		expect(listModerationState(contract.kind)[0]?.[contract.timestampKey]).toBe(
			replacement,
		);

		removeModerationRow(
			getNativeDb(),
			contract.kind,
			"acct_primary",
			"profile_contract",
		);
		expect(listModerationState(contract.kind)).toEqual([]);
		const removedCandidate = searchModerationCandidates(contract.kind, {
			accountId: "acct_primary",
			search: `contract_${contract.kind}`,
		})[0];
		expect(removedCandidate?.[contract.predicateKey]).toBe(false);
		expect(removedCandidate).not.toHaveProperty(contract.timestampKey);
	});

	it("reconciles remote rows without pruning manual state", () => {
		insertProfile("profile_manual", `manual_${contract.kind}`);
		insertProfile("profile_remote_keep", `remote_keep_${contract.kind}`);
		insertProfile("profile_remote_stale", `remote_stale_${contract.kind}`);
		const db = getNativeDb();
		const kind: ModerationKind = contract.kind;

		recordModerationRow(
			db,
			kind,
			"acct_primary",
			"profile_manual",
			"2026-01-01T00:00:00.000Z",
		);
		recordRemoteModerationRow(
			db,
			kind,
			"acct_primary",
			"profile_remote_keep",
			"2026-01-02T00:00:00.000Z",
		);
		recordRemoteModerationRow(
			db,
			kind,
			"acct_primary",
			"profile_remote_keep",
			"2026-02-02T00:00:00.000Z",
		);
		recordRemoteModerationRow(
			db,
			kind,
			"acct_primary",
			"profile_remote_stale",
			"2026-01-03T00:00:00.000Z",
		);

		pruneRemoteModerationRows(db, kind, "acct_primary", [
			"profile_remote_keep",
		]);
		const rows = db
			.prepare(
				`select profile_id, source, created_at from ${contract.table} order by profile_id`,
			)
			.all();
		expect(rows).toEqual([
			{
				profile_id: "profile_manual",
				source: "manual",
				created_at: "2026-01-01T00:00:00.000Z",
			},
			{
				profile_id: "profile_remote_keep",
				source: "remote",
				created_at: "2026-01-02T00:00:00.000Z",
			},
		]);

		pruneRemoteModerationRows(db, kind, "acct_primary", []);
		expect(listModerationState(kind).map((item) => item.profile.id)).toEqual([
			"profile_manual",
		]);
	});
});
