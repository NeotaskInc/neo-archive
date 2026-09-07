import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ApplyArchiveImportParams } from "./archive/apply";
import type { ImportWritePhase } from "./archive/types";
import { enqueueExternalDatabaseWrite } from "./database-writer";
import { nativeBinary } from "./native-archive";
import type { Database } from "./sqlite";

export function canImportNativeArchive(db: Database) {
	const backend = process.env.NEO_ARCHIVE_IMPORT_BACKEND;
	if (backend === "sqlite") return false;
	if (backend && backend !== "rust")
		throw new Error("NEO_ARCHIVE_IMPORT_BACKEND must be rust or sqlite");
	if (!existsSync(nativeBinary())) {
		if (backend === "rust")
			throw new Error("Rust import core is missing; run the native build");
		return false;
	}
	return typeof db.writeIdentity === "string" && !db.inTransaction;
}

export function importNativeArchive(params: ApplyArchiveImportParams) {
	return enqueueExternalDatabaseWrite(async () => {
		const { db, plan, onProgress, localProfile, resolveProfileId } = params;
		if (typeof db.writeIdentity !== "string" || db.inTransaction)
			throw new Error(
				"Native import requires an independent file-backed transaction",
			);
		const accountId = params.accountId ?? "acct_primary";
		const counts = {
			profile: plan.profiles.size,
			tweet: plan.tweets.length,
			collection: plan.collections.length,
			conversation: plan.conversations.size,
			message: plan.dmMessages.length,
			followers: Number(params.includeFollowers),
			following: Number(params.includeFollowing),
		};
		function* records(): Generator<string> {
			yield `${JSON.stringify({ kind: "header", protocolVersion: 1, accountId, encodedAccountId: encodeURIComponent(accountId), archivePath: params.archivePath, accountPayload: params.accountPayload, localProfileId: localProfile.id, selected: params.selection !== null, restore: params.restore, includeTweets: params.includeTweets, includeLikes: params.includeLikes, includeBookmarks: params.includeBookmarks, includeDirectMessages: params.includeDirectMessages, includeProfiles: params.includeProfiles, followerEntryCount: params.followerEntryCount, followingEntryCount: params.followingEntryCount, importedAt: new Date().toISOString(), tweetIds: plan.tweets.map((row) => row.id), dmIds: plan.dmMessages.map((row) => row.id), counts })}\n`;
			function* phase(
				kind: string,
				rows: Iterable<unknown>,
				total: number,
				phase?: ImportWritePhase,
			) {
				if (phase && total) onProgress({ kind: "write-start", phase, total });
				let processed = 0;
				for (const row of rows) {
					yield `${JSON.stringify({ kind, row })}\n`;
					processed++;
					if (phase && (processed === total || processed % 1000 === 0))
						onProgress({ kind: "write-progress", phase, processed, total });
				}
			}
			yield* phase(
				"profile",
				plan.profiles.values(),
				counts.profile,
				"profiles",
			);
			function* tweets() {
				for (const tweet of plan.tweets)
					yield {
						...tweet,
						authorProfileId:
							tweet.authorProfileId === "profile_me"
								? localProfile.id
								: resolveProfileId(tweet.authorProfileId),
					};
			}
			yield* phase("tweet", tweets(), counts.tweet, "tweets");
			yield* phase(
				"collection",
				plan.collections,
				counts.collection,
				"collections",
			);
			yield* phase(
				"conversation",
				plan.conversations.values(),
				counts.conversation,
			);
			yield* phase("message", plan.dmMessages, counts.message, "dmMessages");
			if (params.includeFollowers)
				yield `${JSON.stringify({ kind: "followers", row: plan.followers.map((row) => ({ ...row, profileId: resolveProfileId(row.profileId) })) })}\n`;
			if (params.includeFollowing)
				yield `${JSON.stringify({ kind: "following", row: plan.following.map((row) => ({ ...row, profileId: resolveProfileId(row.profileId) })) })}\n`;
			yield `${JSON.stringify({ kind: "end" })}\n`;
		}
		onProgress({ kind: "writing" });
		const child = spawn(nativeBinary(), ["import", "--db", db.writeIdentity], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "",
			stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (data: string) => {
			stdout += data;
		});
		child.stderr.on("data", (data: string) => {
			stderr += data;
		});
		const exited = new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code, signal) => {
				if (code === 0) resolve();
				else
					reject(
						new Error(
							`Rust archive import failed: ${stderr.trim() || signal || String(code)}`,
						),
					);
			});
		});
		// The pipe applies backpressure; archive text is never copied into one giant JSON payload.
		const outcomes = await Promise.allSettled([
			pipeline(Readable.from(records()), child.stdin),
			exited,
		]);
		const failed = [outcomes[1], outcomes[0]].find(
			(result) => result.status === "rejected",
		);
		if (failed?.status === "rejected") throw failed.reason;
		const result = JSON.parse(stdout) as {
			protocolVersion?: number;
			committed?: boolean;
			counts?: Record<string, number>;
		};
		if (
			result.protocolVersion !== 1 ||
			result.committed !== true ||
			Object.entries(counts).some(
				([key, count]) => (result.counts?.[key] ?? 0) !== count,
			)
		)
			throw new Error("Rust archive import returned an incompatible receipt");
	}, params.db);
}
