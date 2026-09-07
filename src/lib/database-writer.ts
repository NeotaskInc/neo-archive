import { Effect } from "effect";
import type { Database } from "./sqlite";
import {
	defaultServerRuntimeServices,
	type ServerRuntimeServices,
} from "./server-runtime-services";
import {
	recordDatabaseWriteCompleted,
	recordDatabaseWriteQueued,
	recordDatabaseWriteStarted,
} from "./database-metrics";

let writeTails = new Map<string | object, Promise<void>>();

export function enqueueDatabaseWrite<T>(
	write: (db: Database) => T,
	providedDb?: Database,
	runtime: ServerRuntimeServices = defaultServerRuntimeServices,
): Promise<T> {
	const db = providedDb ?? runtime.getDatabase({ seedDemoData: false });
	return enqueueExternalDatabaseWrite(
		() => db.transaction(() => write(db))(),
		db,
	);
}

/** Serialize a writer that owns its own transaction, including a native subprocess. */
export function enqueueExternalDatabaseWrite<T>(
	write: () => Promise<T> | T,
	db: Database,
): Promise<T> {
	const writeIdentity = db.writeIdentity;
	const queuedAt = performance.now();
	recordDatabaseWriteQueued();
	const writeTail = writeTails.get(writeIdentity) ?? Promise.resolve();
	const pending = writeTail.then(async () => {
		recordDatabaseWriteStarted(performance.now() - queuedAt);
		try {
			const result = await write();
			recordDatabaseWriteCompleted(false);
			return result;
		} catch (error) {
			recordDatabaseWriteCompleted(true);
			throw error;
		}
	});
	const settled = pending.then(
		() => undefined,
		() => undefined,
	);
	writeTails.set(writeIdentity, settled);
	void settled.then(() => {
		if (writeTails.get(writeIdentity) === settled) {
			writeTails.delete(writeIdentity);
		}
	});
	return pending;
}

export function databaseWriteEffect<T>(
	write: (db: Database) => T,
	providedDb?: Database,
	runtime: ServerRuntimeServices = defaultServerRuntimeServices,
) {
	return Effect.tryPromise({
		try: () => enqueueDatabaseWrite(write, providedDb, runtime),
		catch: (error) =>
			error instanceof Error ? error : new Error(String(error)),
	});
}

export function resetDatabaseWriterForTests() {
	writeTails = new Map();
}
