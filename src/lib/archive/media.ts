import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	renameSync,
	statSync,
	unlinkSync,
} from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Effect } from "effect";
import { getNeoArchivePaths } from "../config";
import { tryPromise } from "../effect-runtime";
import { listArchiveEntryDetailsEffect, normalizeArchivePath } from "./reader";
import type {
	ArchiveImportSlice,
	ArchiveMediaFileCounts,
	ArchiveMediaKind,
} from "./types";

const ARCHIVE_MEDIA_DIRECTORIES: Array<{
	directory: string;
	kind: ArchiveMediaKind;
}> = [
	{ directory: "tweets_media", kind: "tweets" },
	{ directory: "direct_messages_media", kind: "dms" },
	{ directory: "community_tweet_media", kind: "community" },
	{ directory: "deleted_tweets_media", kind: "deleted" },
	{ directory: "profile_media", kind: "profile" },
	{ directory: "moments_tweets_media", kind: "moments" },
	{ directory: "direct_messages_group_media", kind: "dmGroup" },
];

function createArchiveMediaFileCounts(): ArchiveMediaFileCounts {
	return {
		tweets: 0,
		dms: 0,
		community: 0,
		profile: 0,
		deleted: 0,
		moments: 0,
		dmGroup: 0,
	};
}

export function selectedArchiveMediaKinds(
	selection: Set<ArchiveImportSlice> | null,
) {
	if (!selection) return null;
	const kinds = new Set<ArchiveMediaKind>();
	if (selection.has("tweets")) {
		for (const kind of ["tweets", "community", "deleted", "moments"] as const) {
			kinds.add(kind);
		}
	}
	if (selection.has("directMessages")) {
		for (const kind of ["dms", "dmGroup"] as const) kinds.add(kind);
	}
	if (selection.has("profiles")) kinds.add("profile");
	return kinds;
}

function getArchiveMediaKind(entryPath: string) {
	const normalized = normalizeArchivePath(entryPath);
	if (normalized.endsWith("/")) return undefined;
	return ARCHIVE_MEDIA_DIRECTORIES.find(({ directory }) =>
		new RegExp(`(?:^|/)data/${directory}/[^/]+$`).test(normalized),
	);
}

function getArchiveMediaDestination(entryPath: string, kind: ArchiveMediaKind) {
	const normalized = normalizeArchivePath(entryPath);
	const fileName = path.posix.basename(normalized);
	const separator = fileName.indexOf("-");
	const ownerId = separator > 0 ? fileName.slice(0, separator) : "unknown";
	return path.join(
		getNeoArchivePaths().mediaOriginalsDir,
		"archive",
		kind,
		ownerId,
		fileName,
	);
}

function copyArchiveEntryToFileEffect(
	archivePath: string,
	entryPath: string,
	destinationPath: string,
) {
	return tryPromise(() => {
		mkdirSync(path.dirname(destinationPath), { recursive: true });
		const temporaryPath = `${destinationPath}.${process.pid}.${randomUUID()}.tmp`;
		const child = spawn("unzip", ["-p", archivePath, entryPath], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		const exit = new Promise<number | null>((resolve, reject) => {
			child.on("error", reject);
			child.on("close", resolve);
		});

		return pipeline(child.stdout, createWriteStream(temporaryPath))
			.then(() => exit)
			.then((exitCode) => {
				if (exitCode !== 0) {
					throw new Error(
						`Failed to extract ${entryPath}: ${stderr.trim() || `exit ${String(exitCode)}`}`,
					);
				}
				renameSync(temporaryPath, destinationPath);
			})
			.catch((error: unknown) => {
				child.kill();
				if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
				throw error;
			});
	});
}

export function extractArchiveMediaFilesEffect(
	archivePath: string,
	selectedKinds: Set<ArchiveMediaKind> | null,
): Effect.Effect<ArchiveMediaFileCounts, unknown> {
	return Effect.gen(function* () {
		const counts = createArchiveMediaFileCounts();
		if (selectedKinds?.size === 0) return counts;
		const entries = yield* listArchiveEntryDetailsEffect(archivePath);
		for (const entry of entries) {
			const mediaKind = getArchiveMediaKind(entry.path);
			if (!mediaKind || (selectedKinds && !selectedKinds.has(mediaKind.kind))) {
				continue;
			}
			counts[mediaKind.kind] += 1;
			const destinationPath = getArchiveMediaDestination(
				entry.path,
				mediaKind.kind,
			);
			if (
				existsSync(destinationPath) &&
				statSync(destinationPath).size === entry.size
			) {
				continue;
			}
			yield* copyArchiveEntryToFileEffect(
				archivePath,
				entry.path,
				destinationPath,
			);
		}
		return counts;
	});
}
