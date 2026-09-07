import { Effect } from "effect";
import type {
	ArchiveImportPlan,
	ArchiveMessageRow,
	ArchiveProfileRow,
} from "../archive-import-plan";
import type { Database } from "../sqlite";
import {
	asArray,
	asRecord,
	compareIsoTimestamp,
	inferProfileFromDirectory,
	parseTwitterDate,
} from "./parsing";
import type { ArchiveProfileReconciler } from "./profile-reconciler";
import { defaultArchiveProfileMetadata } from "./profile-reconciler";
import { processArchiveEntryRecordsEffect } from "./reader";
import type {
	ArchiveAccountPayload,
	ArchiveImportSlice,
	ImportProgressEvent,
} from "./types";

interface ParseDirectMessagesParams {
	accountId?: string;
	archivePath: string;
	entries: string[];
	db: Database;
	selection: Set<ArchiveImportSlice> | null;
	accountPayload: ArchiveAccountPayload;
	localProfile: ArchiveProfileRow;
	plan: ArchiveImportPlan;
	profileReconciler: ArchiveProfileReconciler;
	onProgress: (event: ImportProgressEvent) => void;
}

export function parseDirectMessagesEffect({
	accountId = "acct_primary",
	archivePath,
	entries: dmEntries,
	db,
	accountPayload,
	localProfile,
	plan,
	profileReconciler,
	onProgress,
}: ParseDirectMessagesParams) {
	const { mentionDirectory, profiles, conversations, dmMessages } = plan;
	return Effect.gen(function* () {
		const existingDmConversationAccounts = new Map(
			(
				db
					.prepare("select id, account_id from dm_conversations")
					.all() as Array<{ id: string; account_id: string }>
			).map((row) => [row.id, row.account_id]),
		);
		const existingOtherDmMessageIds = new Set(
			(
				db
					.prepare(
						`
		          select m.id
		          from dm_messages m
		          join dm_conversations c on c.id = m.conversation_id
		          where c.account_id <> ?
		        `,
					)
					.all(accountId) as Array<{ id: string }>
			).map((row) => row.id),
		);
		const archiveDmConversationIdAliases = new Map<string, string>();
		const archiveDmMessageIdAliases = new Map<string, string>();

		function uniquePrimaryArchiveId(
			baseId: string,
			isTakenByOtherAccount: (candidate: string) => boolean,
			isPending: (candidate: string) => boolean,
		) {
			let index = 1;
			while (true) {
				const suffix = index === 1 ? "" : `:${index}`;
				const candidate = `${accountId}:${baseId}${suffix}`;
				if (!isTakenByOtherAccount(candidate) && !isPending(candidate)) {
					return candidate;
				}
				index += 1;
			}
		}

		function resolveArchiveDmConversationId(conversationId: string) {
			const existingAlias = archiveDmConversationIdAliases.get(conversationId);
			if (existingAlias) return existingAlias;

			const takenByOtherAccount = (candidate: string) => {
				const storedAccountId = existingDmConversationAccounts.get(candidate);
				return storedAccountId !== undefined && storedAccountId !== accountId;
			};
			const resolved = takenByOtherAccount(conversationId)
				? uniquePrimaryArchiveId(
						conversationId,
						takenByOtherAccount,
						(candidate) => conversations.has(candidate),
					)
				: conversationId;
			archiveDmConversationIdAliases.set(conversationId, resolved);
			return resolved;
		}

		function resolveArchiveDmMessageId(
			messageId: string,
			conversationIdChanged: boolean,
		) {
			const existingAlias = archiveDmMessageIdAliases.get(messageId);
			if (existingAlias) return existingAlias;
			const shouldRemap =
				conversationIdChanged || existingOtherDmMessageIds.has(messageId);
			const resolved = shouldRemap
				? uniquePrimaryArchiveId(
						messageId,
						(candidate) => existingOtherDmMessageIds.has(candidate),
						(candidate) =>
							dmMessages.some((message) => message.id === candidate),
					)
				: messageId;
			archiveDmMessageIdAliases.set(messageId, resolved);
			return resolved;
		}

		if (dmEntries.length > 0) {
			onProgress({
				kind: "slice-start",
				slice: "directMessages",
				files: dmEntries.length,
			});
		}
		for (const [dmFileIndex, entry] of dmEntries.entries()) {
			yield* processArchiveEntryRecordsEffect(archivePath, entry, (wrapper) => {
				const dmConversation = asRecord(wrapper.dmConversation);
				if (!dmConversation) return;

				const rawConversationId = String(dmConversation.conversationId ?? "");
				if (!rawConversationId) return;
				const conversationId =
					resolveArchiveDmConversationId(rawConversationId);
				const conversationIdChanged = conversationId !== rawConversationId;

				const conversationName = String(dmConversation.name ?? "").trim();
				const participantIds = new Set<string>();
				const rawMessages = asArray<Record<string, unknown>>(
					dmConversation.messages,
				);

				for (const event of rawMessages) {
					const messageCreate = asRecord(event.messageCreate);
					if (messageCreate) {
						const senderId = String(messageCreate.senderId ?? "");
						const recipientId = String(messageCreate.recipientId ?? "");
						if (senderId) participantIds.add(senderId);
						if (recipientId) participantIds.add(recipientId);
					}

					const joinConversation = asRecord(event.joinConversation);
					if (joinConversation) {
						for (const userId of asArray<string>(
							joinConversation.participantsSnapshot,
						)) {
							participantIds.add(String(userId));
						}
					}

					const participantsJoin = asRecord(event.participantsJoin);
					if (participantsJoin) {
						for (const userId of asArray<string>(participantsJoin.userIds)) {
							participantIds.add(String(userId));
						}
						const initiatingUserId = String(
							participantsJoin.initiatingUserId ?? "",
						);
						if (initiatingUserId) {
							participantIds.add(initiatingUserId);
						}
					}

					const participantsLeave = asRecord(event.participantsLeave);
					if (participantsLeave) {
						for (const userId of asArray<string>(participantsLeave.userIds)) {
							participantIds.add(String(userId));
						}
						const initiatingUserId = String(
							participantsLeave.initiatingUserId ?? "",
						);
						if (initiatingUserId) {
							participantIds.add(initiatingUserId);
						}
					}
				}

				const externalParticipantIds = [...participantIds].filter(
					(userId) => userId && userId !== accountPayload.accountId,
				);
				const isGroup =
					conversationName.length > 0 || externalParticipantIds.length > 1;
				const participantProfileId = isGroup
					? `profile_group_${conversationId}`
					: `profile_user_${externalParticipantIds[0] ?? conversationId}`;

				if (!profiles.has(participantProfileId)) {
					if (isGroup) {
						profiles.set(participantProfileId, {
							id: participantProfileId,
							handle: `group-${conversationId}`,
							displayName:
								conversationName || `Group DM ${externalParticipantIds.length}`,
							bio: `Group DM with ${externalParticipantIds.length} participants`,
							followersCount: 0,
							followingCount: 0,
							...defaultArchiveProfileMetadata,
							avatarHue: 220,
							avatarUrl: null,
							createdAt: accountPayload.createdAt,
						});
					} else {
						const otherUserId = externalParticipantIds[0] ?? conversationId;
						const inferred = inferProfileFromDirectory(
							otherUserId,
							mentionDirectory,
						);
						profileReconciler.merge({
							id: participantProfileId,
							handle: inferred.handle,
							displayName: inferred.displayName,
							bio: `Imported from archive user ${otherUserId}`,
							followersCount: 0,
							followingCount: 0,
							...defaultArchiveProfileMetadata,
							avatarHue: 210,
							avatarUrl: null,
							createdAt: accountPayload.createdAt,
						});
					}
				}

				const messageEvents = rawMessages
					.map((event) => asRecord(event.messageCreate))
					.filter((event): event is Record<string, unknown> => event !== null)
					.map((messageCreate) => {
						const senderId = String(messageCreate.senderId ?? "");
						const rawMessageId = String(
							messageCreate.id ?? `${rawConversationId}-${senderId}`,
						);
						const senderProfileId =
							senderId === accountPayload.accountId
								? localProfile.id
								: `profile_user_${senderId}`;

						if (senderId && senderId !== accountPayload.accountId) {
							const inferred = inferProfileFromDirectory(
								senderId,
								mentionDirectory,
							);
							if (!profiles.has(senderProfileId)) {
								profileReconciler.merge({
									id: senderProfileId,
									handle: inferred.handle,
									displayName: inferred.displayName,
									bio: `Imported from archive user ${senderId}`,
									followersCount: 0,
									followingCount: 0,
									...defaultArchiveProfileMetadata,
									avatarHue: 240,
									avatarUrl: null,
									createdAt: accountPayload.createdAt,
								});
							}
						}

						return {
							id: resolveArchiveDmMessageId(
								rawMessageId,
								conversationIdChanged,
							),
							conversationId,
							senderProfileId: profileReconciler.resolveId(senderProfileId),
							text: String(messageCreate.text ?? ""),
							createdAt: parseTwitterDate(messageCreate.createdAt),
							direction:
								senderId === accountPayload.accountId ? "outbound" : "inbound",
							mediaCount: asArray(messageCreate.mediaUrls).length,
						} satisfies ArchiveMessageRow;
					})
					.sort((left, right) =>
						compareIsoTimestamp(left.createdAt, right.createdAt),
					);

				if (messageEvents.length === 0) {
					return;
				}

				const lastMessage = messageEvents.at(-1);
				if (!lastMessage) return;

				dmMessages.push(...messageEvents);
				const resolvedParticipantProfileId =
					profileReconciler.resolveId(participantProfileId);
				conversations.set(conversationId, {
					id: conversationId,
					title:
						profiles.get(resolvedParticipantProfileId)?.displayName ||
						conversationName ||
						conversationId,
					accountId,
					participantProfileId: resolvedParticipantProfileId,
					lastMessageAt: lastMessage.createdAt,
					unreadCount: 0,
					needsReply: lastMessage.direction === "inbound" ? 1 : 0,
				});
			});
			onProgress({
				kind: "slice-file",
				slice: "directMessages",
				processed: dmFileIndex + 1,
				files: dmEntries.length,
			});
		}
		if (dmEntries.length > 0) {
			onProgress({
				kind: "slice-done",
				slice: "directMessages",
				count: dmMessages.length,
			});
		}
	});
}
