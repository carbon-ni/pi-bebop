import * as path from "node:path";
import { MessageLogStoreError } from "./message-log-store.ts";

export const RETENTION_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const RETENTION_HIGH_WATER_FILE = ".retention-high-water.jsonl";

type RetentionFs = {
	readonly readFile: (filePath: string) => Promise<Buffer>;
	readonly link: (existingPath: string, destinationPath: string) => Promise<void>;
	readonly realpath: (filePath: string) => Promise<string>;
	readonly writeFile: (filePath: string, data: string | Uint8Array, options?: { flag?: string }) => Promise<void>;
	readonly sync: (filePath: string) => Promise<void>;
	readonly unlink: (filePath: string) => Promise<void>;
};

export type HealthyEntry = {
	readonly source: string;
	readonly occurredAt: number;
};

function quarantineName(hash: (value: string) => string, bytes: Uint8Array): string {
	const digest = hash(Buffer.from(bytes).toString("base64"));
	if (!/^[0-9a-f]{64}$/.test(digest)) throw new MessageLogStoreError("write-failed", "message log quarantine failed");
	return `artifact-${digest}.bin`;
}

export async function quarantineArtifact(
	source: string,
	bytes: Uint8Array,
	quarantineDir: string,
	io: RetentionFs,
	hash: (value: string) => string,
): Promise<void> {
	const destination = path.join(quarantineDir, quarantineName(hash, bytes));
	let linked = false;
	try {
		try {
			await io.link(source, destination);
			linked = true;
		} catch (error) {
			if (!isCode(error, "EEXIST")) throw error;
			const existing = await io.readFile(destination);
			if (Buffer.compare(existing, Buffer.from(bytes)) !== 0)
				throw new MessageLogStoreError("write-failed", "message log quarantine failed");
		}
		await io.sync(destination);
		await io.sync(quarantineDir);
		await io.unlink(source);
		await io.sync(path.dirname(source));
	} catch (error) {
		if (linked) await io.unlink(destination).catch(() => undefined);
		if (error instanceof MessageLogStoreError) throw error;
		throw new MessageLogStoreError("write-failed", "message log quarantine failed");
	}
}

function isCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function retentionHighWaterBytes(value: number): Uint8Array {
	return Buffer.from(`${JSON.stringify({ version: 1, retentionNow: value })}\n`, "utf8");
}

function parseHighWaterLine(line: string, highWater: number): number {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		throw new MessageLogStoreError("write-failed", "message log retention state is invalid");
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("version" in parsed) ||
		parsed.version !== 1 ||
		!("retentionNow" in parsed) ||
		typeof parsed.retentionNow !== "number" ||
		!Number.isSafeInteger(parsed.retentionNow) ||
		parsed.retentionNow < highWater ||
		Buffer.compare(Buffer.from(`${line}\n`), Buffer.from(retentionHighWaterBytes(parsed.retentionNow))) !== 0
	)
		throw new MessageLogStoreError("write-failed", "message log retention state is invalid");
	return parsed.retentionNow;
}

async function validateBoundary(filePath: string, trustedLogDir: string, io: RetentionFs): Promise<boolean> {
	try {
		const resolved = await io.realpath(filePath);
		if (resolved !== path.join(trustedLogDir, RETENTION_HIGH_WATER_FILE))
			throw new MessageLogStoreError("untrusted-path", "message log is not in a trusted crew layout");
		return true;
	} catch (error) {
		if (isCode(error, "ENOENT")) return false;
		if (error instanceof MessageLogStoreError) throw error;
		throw new MessageLogStoreError("write-failed", "message log path could not be resolved");
	}
}

export async function readRetentionHighWater(logDir: string, trustedLogDir: string, io: RetentionFs): Promise<number> {
	const filePath = path.join(logDir, RETENTION_HIGH_WATER_FILE);
	if (!(await validateBoundary(filePath, trustedLogDir, io))) return 0;
	let bytes: Buffer;
	try {
		bytes = await io.readFile(filePath);
	} catch (error) {
		if (isCode(error, "ENOENT")) return 0;
		throw new MessageLogStoreError("write-failed", "message log retention state could not be read");
	}
	let highWater = 0;
	const lines = bytes.toString("utf8").split("\n");
	if (bytes.byteLength === 0 || lines.at(-1) !== "")
		throw new MessageLogStoreError("write-failed", "message log retention state is invalid");
	for (const line of lines.slice(0, -1)) highWater = parseHighWaterLine(line, highWater);
	return highWater;
}

export async function syncRetentionHighWater(logDir: string, trustedLogDir: string, io: RetentionFs): Promise<void> {
	const filePath = path.join(logDir, RETENTION_HIGH_WATER_FILE);
	if (!(await validateBoundary(filePath, trustedLogDir, io))) return;
	try {
		await io.sync(filePath);
		await io.sync(logDir);
	} catch (error) {
		if (error instanceof MessageLogStoreError) throw error;
		throw new MessageLogStoreError("write-failed", "message log retention state could not be persisted");
	}
}

export async function persistRetentionHighWater(
	logDir: string,
	trustedLogDir: string,
	value: number,
	io: RetentionFs,
): Promise<void> {
	const filePath = path.join(logDir, RETENTION_HIGH_WATER_FILE);
	try {
		const exists = await validateBoundary(filePath, trustedLogDir, io);
		await io.writeFile(filePath, retentionHighWaterBytes(value), { flag: exists ? "a" : "ax" });
		await syncRetentionHighWater(logDir, trustedLogDir, io);
	} catch (error) {
		if (isCode(error, "EEXIST")) {
			await validateBoundary(filePath, trustedLogDir, io);
			try {
				await io.writeFile(filePath, retentionHighWaterBytes(value), { flag: "a" });
				await io.sync(filePath);
				await io.sync(logDir);
				return;
			} catch (retryError) {
				if (retryError instanceof MessageLogStoreError) throw retryError;
				throw new MessageLogStoreError("write-failed", "message log retention state could not be persisted");
			}
		}
		if (error instanceof MessageLogStoreError) throw error;
		throw new MessageLogStoreError("write-failed", "message log retention state could not be persisted");
	}
}

export async function expireEntries(entries: readonly HealthyEntry[], cutoff: number, io: RetentionFs): Promise<void> {
	for (const entry of entries) {
		if (entry.occurredAt >= cutoff) continue;
		try {
			await io.unlink(entry.source);
			const directory = entry.source.slice(0, entry.source.lastIndexOf("/"));
			await io.sync(directory);
		} catch (error) {
			if (isCode(error, "ENOENT")) continue;
			throw new MessageLogStoreError("write-failed", "message log retention failed");
		}
	}
}
