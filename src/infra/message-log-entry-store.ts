import * as path from "node:path";
import { MessageLogStoreError } from "./message-log-store.ts";
import type { HealthyEntry } from "./message-log-retention.ts";
import type { MessageLogEntry } from "../domain/message-log-entry.ts";

type EntryFs = {
	readonly readFile: (filePath: string) => Promise<Buffer>;
	readonly writeFile: (filePath: string, data: Uint8Array, options: { flag: string }) => Promise<void>;
};

export async function appendEntryLocked(
	entry: MessageLogEntry,
	bytes: Uint8Array,
	logDir: string,
	io: EntryFs,
	retentionNow: number,
	persistedRetentionNow: number,
	inspect: () => Promise<readonly HealthyEntry[]>,
	expire: (entries: readonly HealthyEntry[], cutoff: number) => Promise<void>,
	publish: (temp: string, target: string, bytes: Uint8Array) => Promise<void>,
	persistHighWater: (value: number) => Promise<void>,
	syncHighWater: () => Promise<void>,
): Promise<void> {
	const healthyEntries = await inspect();
	await expire(healthyEntries, retentionNow - 2_592_000_000);
	if (!/^entry-[0-9a-f]{64}$/.test(String(entry.id)))
		throw new MessageLogStoreError("invalid-entry", "message log entry id is invalid");
	const target = path.join(logDir, `${entry.id}.json`);
	try {
		const existing = await io.readFile(target);
		if (Buffer.compare(existing, Buffer.from(bytes)) !== 0)
			throw new MessageLogStoreError("id-conflict", "message log entry identity conflict");
		if (retentionNow > persistedRetentionNow) await persistHighWater(retentionNow);
		else await syncHighWater();
		return;
	} catch (error) {
		if (error instanceof MessageLogStoreError) throw error;
		if (!isCode(error, "ENOENT")) throw error;
	}
	const temp = `${target}.tmp-${process.pid}`;
	await io.writeFile(temp, bytes, { flag: "wx" });
	await publish(temp, target, bytes);
	if (retentionNow > persistedRetentionNow) await persistHighWater(retentionNow);
}

function isCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
