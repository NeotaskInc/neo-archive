// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetNeoArchivePathsForTests } from "./config";
import {
	enqueueDatabaseWrite,
	resetDatabaseWriterForTests,
} from "./database-writer";
import {
	getDatabaseRuntimeMetrics,
	resetDatabaseRuntimeMetricsForTests,
} from "./database-metrics";
import { getNativeDb, resetDatabaseForTests } from "./db";
import { createServerRuntimeServices } from "./server-runtime-services";
import { NativeSqliteDatabase } from "./sqlite";

let tempDir: string | undefined;

afterEach(() => {
	resetDatabaseWriterForTests();
	resetDatabaseRuntimeMetricsForTests();
	resetDatabaseForTests();
	resetNeoArchivePathsForTests();
	delete process.env.NEO_ARCHIVE_HOME;
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

function setupDatabase() {
	tempDir = mkdtempSync(path.join(os.tmpdir(), "neo-archive-writer-"));
	process.env.NEO_ARCHIVE_HOME = tempDir;
	const db = getNativeDb({ seedDemoData: false });
	db.exec(
		"create table writer_events (position integer primary key, name text)",
	);
	return db;
}

describe("database writer", () => {
	it("serializes writes in enqueue order", async () => {
		setupDatabase();
		const order: string[] = [];

		await Promise.all([
			enqueueDatabaseWrite((db) => {
				order.push("first");
				db.prepare(
					"insert into writer_events (position, name) values (1, 'first')",
				).run();
			}),
			enqueueDatabaseWrite((db) => {
				order.push("second");
				db.prepare(
					"insert into writer_events (position, name) values (2, 'second')",
				).run();
			}),
		]);

		expect(order).toEqual(["first", "second"]);
		expect(
			getNativeDb({ seedDemoData: false })
				.prepare("select name from writer_events order by position")
				.all(),
		).toEqual([{ name: "first" }, { name: "second" }]);
		expect(
			getNativeDb({ seedDemoData: false })
				.prepare("select count(*) as count from accounts")
				.get(),
		).toEqual({ count: 0 });
	});

	it("rolls back failed writes and keeps the queue usable", async () => {
		setupDatabase();

		await expect(
			enqueueDatabaseWrite((db) => {
				db.prepare(
					"insert into writer_events (position, name) values (1, 'rolled back')",
				).run();
				throw new Error("write failed");
			}),
		).rejects.toThrow("write failed");
		await enqueueDatabaseWrite((db) => {
			db.prepare(
				"insert into writer_events (position, name) values (2, 'committed')",
			).run();
		});

		expect(
			getNativeDb({ seedDemoData: false })
				.prepare("select name from writer_events order by position")
				.all(),
		).toEqual([{ name: "committed" }]);
		expect(getDatabaseRuntimeMetrics().writer).toMatchObject({
			completed: 2,
			failed: 1,
			queued: 0,
		});
	});

	it("can serialize writes against an explicitly provided database", async () => {
		const db = setupDatabase();

		await enqueueDatabaseWrite((writeDb) => {
			expect(writeDb).toBe(db);
			writeDb
				.prepare(
					"insert into writer_events (position, name) values (1, 'provided')",
				)
				.run();
		}, db);

		expect(db.prepare("select name from writer_events").all()).toEqual([
			{ name: "provided" },
		]);
	});

	it("resolves the default database through injected services", async () => {
		const db = setupDatabase();
		const runtime = createServerRuntimeServices({
			getDatabase: () => db,
		});

		await enqueueDatabaseWrite(
			(writeDb) => {
				expect(writeDb).toBe(db);
				writeDb
					.prepare(
						"insert into writer_events (position, name) values (1, 'injected')",
					)
					.run();
			},
			undefined,
			runtime,
		);

		expect(db.prepare("select name from writer_events").get()).toEqual({
			name: "injected",
		});
	});

	it("keeps independent queues for independent databases", async () => {
		setupDatabase();
		const secondDb = new NativeSqliteDatabase(":memory:");
		secondDb.exec(
			"create table writer_events (position integer primary key, name text)",
		);

		await Promise.all([
			enqueueDatabaseWrite((db) => {
				db.prepare(
					"insert into writer_events (position, name) values (1, 'primary')",
				).run();
			}),
			enqueueDatabaseWrite((db) => {
				db.prepare(
					"insert into writer_events (position, name) values (1, 'secondary')",
				).run();
			}, secondDb),
		]);

		expect(secondDb.prepare("select name from writer_events").get()).toEqual({
			name: "secondary",
		});
		secondDb.close();
	});
});
