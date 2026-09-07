// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTestHome } from "../test/test-home";
import { importArchive } from "./archive-import";
import { getNativeDb } from "./db";
import { listTimelineItems } from "./timeline-read-model";

const home = useTestHome({ prefix: "neo-archive-multi-account-" });

function archive(index: number, bookmarks = true) {
	const root = home().makeTempDir("archive-");
	const data = path.join(root, "archive", "data");
	mkdirSync(data, { recursive: true });
	const accountId = String(91000 + index);
	const values: Record<string, unknown> = {
		account: [
			{
				account: {
					accountId,
					username: `neo_test_${index}`,
					accountDisplayName: `Synthetic ${index}`,
					createdAt: "2020-01-01T00:00:00.000Z",
				},
			},
		],
		tweets: [
			{
				tweet: {
					id_str: String(94000 + index),
					created_at: "Tue Jun 03 19:32:20 +0000 2025",
					full_text: `compass authored ${index}`,
				},
			},
		],
		bookmark: bookmarks
			? [
					{
						bookmark: {
							tweetId: String(92000 + index),
							fullText: `compass bookmark ${index}`,
							bookmarkedAt: "2026-09-01T00:00:00.000Z",
						},
					},
				]
			: [],
		like: [{ like: { tweetId: "93000", fullText: "compass shared like" } }],
		"direct-messages": [
			{
				dmConversation: {
					conversationId: "same-conversation",
					messages: [
						{
							messageCreate: {
								id: "same-message",
								senderId: "999",
								recipientId: accountId,
								text: `private compass ${index}`,
								createdAt: "2026-09-01T00:00:00.000Z",
								mediaUrls: [],
							},
						},
					],
				},
			},
		],
	};
	for (const [name, value] of Object.entries(values)) {
		writeFileSync(
			path.join(data, `${name}.js`),
			`window.YTD.${name.replaceAll("-", "_")}.part0 = ${JSON.stringify(value)}`,
		);
	}
	const zip = path.join(root, "archive.zip");
	execFileSync("zip", ["-qr", zip, "archive"], { cwd: root });
	return zip;
}

describe("archive account ownership", () => {
	it("imports three accounts, keeps DM ownership, and reimports without duplicates", async () => {
		const paths = [archive(1), archive(2), archive(3)];
		for (const [index, file] of paths.entries()) {
			await importArchive(file, { account: `neo_test_${index + 1}` });
		}
		await importArchive(paths[1], { account: "neo_test_2" });
		const db = getNativeDb({ seedDemoData: false });
		expect(db.prepare("select count(*) as count from accounts").get()).toEqual({
			count: 3,
		});
		expect(
			db
				.prepare("select count(*) as count from accounts where is_default = 1")
				.get(),
		).toEqual({ count: 1 });
		expect(
			listTimelineItems({
				resource: "home",
				account: "all",
				search: "compass",
				bookmarkedOnly: true,
			}),
		).toHaveLength(3);
		expect(
			listTimelineItems({
				resource: "home",
				account: "all",
				search: "compass",
				likedOnly: true,
			}),
		).toHaveLength(1);
		for (let index = 1; index <= 3; index += 1) {
			const accountId = `acct_x_${91000 + index}`;
			const posts = listTimelineItems({
				resource: "authored",
				account: accountId,
				search: "compass",
			});
			expect(posts).toHaveLength(1);
			expect(posts[0].author.handle).toBe(`neo_test_${index}`);
			expect(
				listTimelineItems({
					resource: "home",
					account: accountId,
					likedOnly: true,
				}),
			).toHaveLength(1);
			expect(
				db
					.prepare(
						"select m.text from dm_messages m join dm_conversations c on c.id = m.conversation_id where c.account_id = ?",
					)
					.all(accountId),
			).toEqual([{ text: `private compass ${index}` }]);
		}
	});

	it("restores one account's bookmarks while preserving the other account", async () => {
		await importArchive(archive(1), { account: "neo_test_1" });
		await importArchive(archive(2), { account: "neo_test_2" });
		await importArchive(archive(2, false), {
			account: "neo_test_2",
			restore: true,
			select: ["bookmarks"],
		});
		const matches = listTimelineItems({
			resource: "home",
			account: "all",
			bookmarkedOnly: true,
		});
		expect(matches.map((item) => item.id)).toEqual(["92001"]);
		expect(
			getNativeDb({ seedDemoData: false })
				.prepare("select count(*) as count from dm_messages")
				.get(),
		).toEqual({ count: 2 });
	});

	it("rejects a mismatched explicit owner before writing imported data", async () => {
		await expect(
			importArchive(archive(1), { account: "neo_test_2" }),
		).rejects.toThrow("does not match the archive owner");
		expect(
			getNativeDb({ seedDemoData: false })
				.prepare("select count(*) as count from accounts")
				.get(),
		).toEqual({ count: 0 });
	});
});
