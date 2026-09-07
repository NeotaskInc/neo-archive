import { canImportNativeArchive, importNativeArchive } from "../native-import";
import archiveSql from "./sql.json";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type {
	ArchiveImportPlan,
	ArchiveProfileRow,
} from "../archive-import-plan";
import { databaseWriteEffect } from "../database-writer";
import type { ImportRepository } from "../import-repository";
import type { Database } from "../sqlite";
import {
	reconcileTweetTombstones,
	recordTweetRevision,
	tombstoneTweetSubordinates,
} from "../tweet-retention";
import type {
	ArchiveAccountPayload,
	ArchiveFollowDirection,
	ArchiveImportSlice,
	ImportProgressEvent,
	ImportWritePhase,
} from "./types";

export interface ApplyArchiveImportParams {
	accountId?: string;
	archivePath: string;
	db: Database;
	repository: ImportRepository;
	selection: Set<ArchiveImportSlice> | null;
	includeTweets: boolean;
	includeLikes: boolean;
	includeBookmarks: boolean;
	includeDirectMessages: boolean;
	includeProfiles: boolean;
	includeFollowers: boolean;
	includeFollowing: boolean;
	accountPayload: ArchiveAccountPayload;
	localProfile: ArchiveProfileRow;
	plan: ArchiveImportPlan;
	resolveProfileId: (profileId: string) => string;
	followerEntryCount: number;
	followingEntryCount: number;
	onProgress: (event: ImportProgressEvent) => void;
	restore: boolean;
}

export function applyArchiveImportPlanEffect(params: ApplyArchiveImportParams) {
	if (canImportNativeArchive(params.db)) {
		return Effect.tryPromise({
			try: () => importNativeArchive(params),
			catch: (error) =>
				error instanceof Error ? error : new Error(String(error)),
		});
	}
	return applyArchiveImportPlanSqliteEffect(params);
}

function applyArchiveImportPlanSqliteEffect({
	accountId = "acct_primary",
	archivePath,
	db,
	repository,
	selection,
	includeTweets,
	includeLikes,
	includeBookmarks,
	includeDirectMessages,
	includeProfiles,
	includeFollowers,
	includeFollowing,
	accountPayload,
	localProfile,
	plan,
	resolveProfileId,
	followerEntryCount,
	followingEntryCount,
	onProgress,
	restore,
}: ApplyArchiveImportParams) {
	const {
		tweets: tweetRows,
		collections: collectionRows,
		profiles,
		conversations,
		dmMessages,
		followers: followerRows,
		following: followingRows,
	} = plan;

	return Effect.gen(function* () {
		const insertAccount = db.prepare(archiveSql.insertAccount);
		const insertAccountIfMissing = db.prepare(
			archiveSql.insertAccountIfMissing,
		);
		const insertProfile = db.prepare(archiveSql.insertProfile);
		const insertProfileIfMissing = db.prepare(
			archiveSql.insertProfileIfMissing,
		);
		const insertTweet = db.prepare(archiveSql.insertTweet);
		const deleteTweetFts = db.prepare(archiveSql.deleteTweetFts);
		const insertTweetFts = db.prepare(archiveSql.insertTweetFts);
		const selectTweetFtsState = db.prepare(archiveSql.selectTweetFtsState);
		const insertTimelineEdge = db.prepare(archiveSql.insertTimelineEdge);
		const insertCollection = db.prepare(archiveSql.insertCollection);
		const insertConversation = db.prepare(archiveSql.insertConversation);
		const insertMessage = db.prepare(archiveSql.insertMessage);
		const insertDmFts = db.prepare(archiveSql.insertDmFts);
		const deleteDmFts = db.prepare(archiveSql.deleteDmFts);
		const insertFollowSnapshot = db.prepare(archiveSql.insertFollowSnapshot);
		const insertFollowSnapshotMember = db.prepare(
			archiveSql.insertFollowSnapshotMember,
		);
		const selectFollowSnapshotMembers = db.prepare(
			archiveSql.selectFollowSnapshotMembers,
		);
		const deleteFollowSnapshotMembers = db.prepare(
			archiveSql.deleteFollowSnapshotMembers,
		);
		const deleteArchiveFollowEvents = db.prepare(
			archiveSql.deleteArchiveFollowEvents,
		);
		const deleteArchiveFollowSnapshotMembers = db.prepare(
			archiveSql.deleteArchiveFollowSnapshotMembers,
		);
		const deleteArchiveFollowSnapshots = db.prepare(
			archiveSql.deleteArchiveFollowSnapshots,
		);
		const deleteArchiveFollowEdges = db.prepare(
			archiveSql.deleteArchiveFollowEdges,
		);
		const selectFollowEdges = db.prepare(archiveSql.selectFollowEdges);
		const insertFollowEdge = db.prepare(archiveSql.insertFollowEdge);
		const endFollowEdge = db.prepare(archiveSql.endFollowEdge);
		const insertFollowEvent = db.prepare(archiveSql.insertFollowEvent);
		const clearSelectedLikes = db.prepare(archiveSql.clearSelectedLikes);
		const clearSelectedBookmarks = db.prepare(
			archiveSql.clearSelectedBookmarks,
		);
		const clearSelectedArchiveTweetEdges = db.prepare(
			archiveSql.clearSelectedArchiveTweetEdges,
		);
		const deleteOrphanTweetLinkOccurrences = db.prepare(
			archiveSql.deleteOrphanTweetLinkOccurrences,
		);
		const deleteOrphanTweets = db.prepare(archiveSql.deleteOrphanTweets);
		const deleteOrphanTweetFts = db.prepare(archiveSql.deleteOrphanTweetFts);
		const deleteOrphanTweetSubordinateTombstones = db.prepare(
			archiveSql.deleteOrphanTweetSubordinateTombstones,
		);
		const deleteOrphanTweetRevisionChains = db.prepare(
			archiveSql.deleteOrphanTweetRevisionChains,
		);
		const deleteOrphanTweetRevisionEdges = db.prepare(
			archiveSql.deleteOrphanTweetRevisionEdges,
		);
		const clearDmFts = db.prepare(archiveSql.clearDmFts);
		const clearDmLinkOccurrences = db.prepare(
			archiveSql.clearDmLinkOccurrences,
		);
		const clearDmMessages = db.prepare(archiveSql.clearDmMessages);
		const clearDmConversations = db.prepare(archiveSql.clearDmConversations);

		function importFollowRows(
			direction: ArchiveFollowDirection,
			rows: Array<{ profileId: string; externalUserId: string }>,
			entryCount: number,
			now: string,
		) {
			const snapshotId = `follow_snapshot_archive_${accountId}_${direction}`;
			const existingEdges = new Map(
				(
					selectFollowEdges.all(accountId, direction) as Array<{
						profile_id: string;
						external_user_id: string;
						current: number;
					}>
				).map((row) => [row.profile_id, row]),
			);
			const existingMembers = selectFollowSnapshotMembers.all(
				snapshotId,
			) as Array<{
				profile_id: string;
				external_user_id: string;
			}>;
			const existingProfileIds = new Set(
				existingMembers.map((row) => row.profile_id),
			);
			const incomingByProfileId = new Map<
				string,
				{ profileId: string; externalUserId: string }
			>();
			for (const row of rows) {
				const profileId = resolveProfileId(row.profileId);
				if (!incomingByProfileId.has(profileId)) {
					incomingByProfileId.set(profileId, {
						profileId,
						externalUserId: row.externalUserId,
					});
				}
			}
			const incomingRows = Array.from(incomingByProfileId.values());
			const effectiveRows = restore
				? incomingRows
				: [
						...existingMembers.map((row) => ({
							profileId: row.profile_id,
							externalUserId: row.external_user_id,
						})),
						...incomingRows.filter(
							(row) => !existingProfileIds.has(row.profileId),
						),
					];
			const existingMemberKey = existingMembers
				.map(
					(row, index) =>
						`${String(index)}:${row.profile_id}:${row.external_user_id}`,
				)
				.join("\n");
			const nextMemberKey = effectiveRows
				.map(
					(row, index) =>
						`${String(index)}:${row.profileId}:${row.externalUserId}`,
				)
				.join("\n");
			const membersChanged = existingMemberKey !== nextMemberKey;
			const currentProfileIds = new Set<string>();

			insertFollowSnapshot.run(
				snapshotId,
				accountId,
				direction,
				restore ? "complete" : "partial",
				entryCount,
				effectiveRows.length,
				now,
				now,
				JSON.stringify({
					archivePath,
					result_count: incomingRows.length,
					merged_result_count: effectiveRows.length,
				}),
			);

			if (membersChanged) {
				deleteFollowSnapshotMembers.run(snapshotId);
			}
			effectiveRows.forEach((row, index) => {
				const profileId = row.profileId;
				if (membersChanged) {
					insertFollowSnapshotMember.run(
						snapshotId,
						profileId,
						row.externalUserId,
						index,
					);
				}
			});
			incomingRows.forEach((row) => {
				const profileId = row.profileId;
				currentProfileIds.add(profileId);

				const previous = existingEdges.get(profileId);
				insertFollowEdge.run(
					accountId,
					direction,
					profileId,
					row.externalUserId,
					now,
					now,
					now,
				);
				if (!previous || previous.current === 0) {
					insertFollowEvent.run(
						`follow_event_${randomUUID()}`,
						accountId,
						direction,
						profileId,
						row.externalUserId,
						"started",
						now,
						snapshotId,
					);
				}
			});

			if (!restore) return;
			for (const [profileId, previous] of existingEdges) {
				if (previous.current === 0 || currentProfileIds.has(profileId)) {
					continue;
				}
				endFollowEdge.run(now, now, accountId, direction, profileId);
				insertFollowEvent.run(
					`follow_event_${randomUUID()}`,
					accountId,
					direction,
					profileId,
					previous.external_user_id,
					"ended",
					now,
					snapshotId,
				);
			}
		}

		function clearArchiveFollowRows(direction: ArchiveFollowDirection) {
			deleteArchiveFollowEvents.run(
				accountId,
				direction,
				`follow_snapshot_archive_${accountId}_${direction}`,
				accountId,
				direction,
			);
			deleteArchiveFollowSnapshotMembers.run(accountId, direction);
			deleteArchiveFollowSnapshots.run(accountId, direction);
			deleteArchiveFollowEdges.run(accountId, direction);
		}

		onProgress({ kind: "writing" });
		const WRITE_PROGRESS_INTERVAL = 1000;
		function tickWrite(
			phase: ImportWritePhase,
			processed: number,
			total: number,
		) {
			if (processed === total || processed % WRITE_PROGRESS_INTERVAL === 0) {
				onProgress({ kind: "write-progress", phase, processed, total });
			}
		}
		yield* databaseWriteEffect(() => {
			if (restore) {
				if (includeTweets) {
					repository.clearAuthoredSyncCursors(accountId);
					repository.clearMentionSyncState(accountId);
					clearSelectedArchiveTweetEdges.run(accountId, localProfile.id);
				}
				if (includeLikes) {
					clearSelectedLikes.run(accountId);
				}
				if (includeBookmarks) {
					clearSelectedBookmarks.run(accountId);
				}
				if (includeTweets || includeLikes || includeBookmarks) {
					deleteOrphanTweets.run();
					deleteOrphanTweetFts.run();
					deleteOrphanTweetLinkOccurrences.run();
					deleteOrphanTweetSubordinateTombstones.run();
					deleteOrphanTweetRevisionChains.run();
					deleteOrphanTweetRevisionEdges.run();
				}
				if (includeDirectMessages) {
					clearDmLinkOccurrences.run(accountId);
					clearDmFts.run(accountId);
					clearDmMessages.run(accountId);
					clearDmConversations.run(accountId);
				}
			}

			// FTS identifier columns are unindexed. Scan existing rows once, then
			// replace by rowid instead of scanning the growing index for every item.
			function existingFtsRows(
				table: "tweets_fts" | "dm_fts",
				idColumn: "tweet_id" | "message_id",
				ids: Set<string>,
			) {
				const result = new Map<string, number[]>();
				if (ids.size === 0) return result;
				for (const value of db
					.prepare(`select rowid, ${idColumn} as id from ${table}`)
					.iterate()) {
					const row = value as { rowid: number; id: string };
					if (!ids.has(row.id)) continue;
					const previous = result.get(row.id);
					if (previous) previous.push(row.rowid);
					else result.set(row.id, [row.rowid]);
				}
				return result;
			}
			const tweetFtsRows = existingFtsRows(
				"tweets_fts",
				"tweet_id",
				new Set(tweetRows.map((row) => row.id)),
			);
			const dmFtsRows = existingFtsRows(
				"dm_fts",
				"message_id",
				new Set(dmMessages.map((row) => row.id)),
			);
			const writeAccount = selection ? insertAccountIfMissing : insertAccount;
			writeAccount.run(
				accountId,
				accountPayload.displayName,
				`@${accountPayload.username}`,
				accountPayload.accountId,
				"archive",
				accountPayload.createdAt,
			);

			const writeProfile =
				!selection || includeProfiles ? insertProfile : insertProfileIfMissing;
			const importedAt = new Date().toISOString();
			const profilesTotal = profiles.size;
			if (profilesTotal > 0) {
				onProgress({
					kind: "write-start",
					phase: "profiles",
					total: profilesTotal,
				});
			}
			let profileIndex = 0;
			for (const profile of profiles.values()) {
				writeProfile.run(
					profile.id,
					profile.handle,
					profile.displayName,
					profile.bio,
					profile.followersCount,
					profile.followingCount,
					profile.publicMetricsJson,
					profile.avatarHue,
					profile.avatarUrl,
					profile.location,
					profile.url,
					profile.verifiedType,
					profile.entitiesJson,
					profile.rawJson,
					profile.createdAt,
				);
				profileIndex += 1;
				tickWrite("profiles", profileIndex, profilesTotal);
			}

			if (tweetRows.length > 0) {
				onProgress({
					kind: "write-start",
					phase: "tweets",
					total: tweetRows.length,
				});
			}
			let tweetWriteIndex = 0;
			for (const tweet of tweetRows) {
				const preserveExistingBody =
					Boolean(tweet.deletedAt) ||
					tweet.kind === "like" ||
					tweet.kind === "bookmark";
				const authorProfileId =
					tweet.authorProfileId === "profile_me"
						? localProfile.id
						: resolveProfileId(tweet.authorProfileId);
				insertTweet.run(
					tweet.id,
					authorProfileId,
					tweet.text,
					tweet.createdAt,
					tweet.isReplied,
					tweet.replyToId,
					tweet.likeCount,
					tweet.mediaCount,
					tweet.entitiesJson,
					tweet.mediaJson,
					tweet.quotedTweetId,
					tweet.deletedAt ?? null,
					tweet.deletionSource ?? null,
					tweet.deletionReason ?? null,
					preserveExistingBody ? 1 : 0,
					preserveExistingBody ? 1 : 0,
				);
				for (const rowid of tweetFtsRows.get(tweet.id) ?? [])
					deleteTweetFts.run(rowid);
				tweetFtsRows.delete(tweet.id);
				if (tweet.kind === "home") {
					insertTimelineEdge.run(
						accountId,
						tweet.id,
						tweet.kind,
						tweet.createdAt,
						tweet.createdAt,
						new Date().toISOString(),
					);
				}
				if (authorProfileId === localProfile.id) {
					insertTimelineEdge.run(
						accountId,
						tweet.id,
						"authored",
						tweet.createdAt,
						tweet.createdAt,
						new Date().toISOString(),
					);
				}
				const storedTweet = selectTweetFtsState.get(tweet.id) as
					| {
							text: string;
							deleted_at: string | null;
							deletion_source: string | null;
					  }
					| undefined;
				if (!storedTweet?.deleted_at) {
					// ArchiveImportPlan merges duplicate tweet IDs before applying.
					insertTweetFts.run(tweet.id, storedTweet?.text ?? tweet.text);
				} else {
					tombstoneTweetSubordinates(db, {
						tweetId: tweet.id,
						deletedAt: storedTweet.deleted_at,
						deletionSource:
							storedTweet.deletion_source ??
							(tweet.deletedAt === storedTweet.deleted_at
								? (tweet.deletionSource ?? null)
								: null),
					});
				}
				recordTweetRevision(db, {
					tweetId: tweet.id,
					editHistoryIds: tweet.editHistoryIds ?? [tweet.id],
					payloadJson: tweet.rawJson ?? null,
					source: "twitter_archive",
					observedAt: importedAt,
				});
				tweetWriteIndex += 1;
				tickWrite("tweets", tweetWriteIndex, tweetRows.length);
			}

			if (collectionRows.length > 0) {
				onProgress({
					kind: "write-start",
					phase: "collections",
					total: collectionRows.length,
				});
			}
			let collectionIndex = 0;
			for (const collection of collectionRows) {
				insertCollection.run(
					accountId,
					collection.tweetId,
					collection.kind,
					collection.collectedAt,
					collection.source,
					collection.rawJson,
					importedAt,
				);
				collectionIndex += 1;
				tickWrite("collections", collectionIndex, collectionRows.length);
			}

			for (const conversation of conversations.values()) {
				insertConversation.run(
					conversation.id,
					conversation.accountId,
					conversation.participantProfileId,
					conversation.title,
					conversation.lastMessageAt,
					conversation.unreadCount,
					conversation.needsReply,
				);
			}

			if (dmMessages.length > 0) {
				onProgress({
					kind: "write-start",
					phase: "dmMessages",
					total: dmMessages.length,
				});
			}
			let dmWriteIndex = 0;
			for (const message of dmMessages) {
				insertMessage.run(
					message.id,
					message.conversationId,
					message.senderProfileId,
					message.text,
					message.createdAt,
					message.direction,
					message.direction === "outbound" ? 1 : 0,
					message.mediaCount,
				);
				for (const rowid of dmFtsRows.get(message.id) ?? [])
					deleteDmFts.run(rowid);
				const indexed = insertDmFts.run(message.id, message.text);
				dmFtsRows.set(message.id, [indexed.lastInsertRowid]);
				dmWriteIndex += 1;
				tickWrite("dmMessages", dmWriteIndex, dmMessages.length);
			}

			if (includeFollowers && followerEntryCount > 0) {
				importFollowRows(
					"followers",
					followerRows,
					followerEntryCount,
					importedAt,
				);
			} else if (includeFollowers && restore) {
				clearArchiveFollowRows("followers");
			}
			if (includeFollowing && followingEntryCount > 0) {
				importFollowRows(
					"following",
					followingRows,
					followingEntryCount,
					importedAt,
				);
			} else if (includeFollowing && restore) {
				clearArchiveFollowRows("following");
			}
			reconcileTweetTombstones(db);
		}, db);
	});
}
