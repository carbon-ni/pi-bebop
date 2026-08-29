import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { isCrewDisplayName, type CompactionDeliveryEnvelope } from "../domain/index.ts";
import { isTrustedCrewManifestPath } from "./crew-manifest-store.ts";

export const COMPACTION_DELIVERY_JOURNAL_VERSION = 1 as const;
export const COMPACTION_DELIVERY_MAX_ENTRIES = 64;
export const COMPACTION_DELIVERY_MAX_ENTRY_BYTES = 1_100_000;
export const COMPACTION_DELIVERY_MAX_BYTES = 70_400_000;

type JournalState = "pending" | "handing-off";

export interface CompactionDeliveryRecord {
	readonly version: typeof COMPACTION_DELIVERY_JOURNAL_VERSION;
	readonly id: string;
	readonly sequence: number;
	readonly acceptedAt: number;
	readonly bytes: number;
	readonly state: JournalState;
	readonly envelope: CompactionDeliveryEnvelope;
}

interface JournalFile {
	readonly version: typeof COMPACTION_DELIVERY_JOURNAL_VERSION;
	readonly nextSequence: number;
	readonly records: readonly CompactionDeliveryRecord[];
}

export type CompactionDeliveryJournalErrorCode =
	| "untrusted-project"
	| "untrusted-path"
	| "invalid-member"
	| "capacity-exceeded"
	| "invalid-record"
	| "storage-failed";

export class CompactionDeliveryJournalError extends Error {
	readonly code: CompactionDeliveryJournalErrorCode;

	constructor(code: CompactionDeliveryJournalErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "CompactionDeliveryJournalError";
		this.code = code;
	}
}

interface JournalDependencies {
	readonly readFile?: (filePath: string) => Promise<Buffer>;
	readonly writeFile?: (filePath: string, data: string) => Promise<void>;
	readonly rename?: (from: string, to: string) => Promise<void>;
	readonly mkdir?: (directory: string) => Promise<void>;
	readonly acquireLock?: (filePath: string) => Promise<() => Promise<void>>;
	readonly syncDirectory?: (directory: string) => Promise<void>;
}

const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_STALE_MS = 30_000;

async function acquireFileLock(filePath: string): Promise<() => Promise<void>> {
	const lockPath = `${filePath}.lock`;
	await fs.mkdir(path.dirname(lockPath), { recursive: true });
	const started = Date.now();
	while (true) {
		try {
			const handle = await fs.open(lockPath, "wx");
			await handle.writeFile(`${process.pid}\n`, "utf8");
			await handle.sync();
			await handle.close();
			return async () => {
				try {
					await fs.unlink(lockPath);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (Date.now() - started >= LOCK_TIMEOUT_MS) {
				try {
					const stat = await fs.stat(lockPath);
					if (Date.now() - stat.mtimeMs >= LOCK_STALE_MS) {
						await fs.unlink(lockPath);
						continue;
					}
				} catch (statError) {
					if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
				}
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
		}
	}
}

const defaults: Required<JournalDependencies> = {
	readFile: (filePath) => fs.readFile(filePath),
	writeFile: async (filePath, data) => {
		const handle = await fs.open(filePath, "w");
		try {
			await handle.writeFile(data, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
	},
	rename: (from, to) => fs.rename(from, to),
	mkdir: async (directory) => {
		await fs.mkdir(directory, { recursive: true });
	},
	acquireLock: acquireFileLock,
	syncDirectory: async (directory) => {
		const handle = await fs.open(directory, "r");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	},
};

function stableJson(value: unknown, seen = new Set<object>()): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		const encoded = JSON.stringify(value);
		if (encoded === undefined) throw new TypeError("unsupported JSON value");
		return encoded;
	}
	if (typeof value !== "object") throw new TypeError("unsupported JSON value");
	if (seen.has(value)) throw new TypeError("circular JSON value");
	seen.add(value);
	try {
		if (Array.isArray(value)) return `[${value.map((item) => stableJson(item, seen)).join(",")}]`;
		const object = value as Record<string, unknown>;
		return `{${Object.keys(object)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableJson(object[key], seen)}`)
			.join(",")}}`;
	} finally {
		seen.delete(value);
	}
}

function journalKey(manifestPath: string, memberName: string): string {
	return createHash("sha256")
		.update(`${path.resolve(manifestPath)}\0${memberName}`, "utf8")
		.digest("hex");
}

function recordBytes(records: readonly CompactionDeliveryRecord[]): number {
	return records.reduce((total, record) => total + record.bytes, 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidDeliveryEnvelope(record: Record<string, unknown>): boolean {
	if (!isRecord(record.envelope)) return false;
	return (
		record.envelope.id === record.id &&
		record.envelope.bytes === record.bytes &&
		isRecord(record.envelope.delivery) &&
		isRecord(record.envelope.metadata)
	);
}

function isValidDeliveryIdentity(record: Record<string, unknown>): boolean {
	return record.version === 1 && typeof record.id === "string" && record.id.length > 0;
}

function isValidDeliveryRecord(record: unknown): record is CompactionDeliveryRecord {
	if (!isRecord(record)) return false;
	const validIdentity = isValidDeliveryIdentity(record);
	const sequence = record.sequence;
	const acceptedAt = record.acceptedAt;
	const validSequence = typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence > 0;
	const validTime = typeof acceptedAt === "number" && Number.isSafeInteger(acceptedAt);
	const validState = record.state === "pending" || record.state === "handing-off";
	const bytes = record.bytes;
	const validBytes =
		typeof bytes === "number" &&
		Number.isSafeInteger(bytes) &&
		bytes >= 0 &&
		bytes <= COMPACTION_DELIVERY_MAX_ENTRY_BYTES;
	return validIdentity && validSequence && validTime && validState && validBytes && isValidDeliveryEnvelope(record);
}

function parseJournal(value: unknown): JournalFile {
	if (!isRecord(value) || value.version !== COMPACTION_DELIVERY_JOURNAL_VERSION || !Array.isArray(value.records))
		throw new CompactionDeliveryJournalError("invalid-record", "compaction delivery journal is malformed");
	const records = value.records as CompactionDeliveryRecord[];
	const valid = records.every(isValidDeliveryRecord);
	const sequences = new Set(records.map((record) => record.sequence));
	if (
		!valid ||
		sequences.size !== records.length ||
		records.length > COMPACTION_DELIVERY_MAX_ENTRIES ||
		recordBytes(records) > COMPACTION_DELIVERY_MAX_BYTES
	)
		throw new CompactionDeliveryJournalError(
			"invalid-record",
			"compaction delivery journal contains an invalid record",
		);
	return {
		version: 1,
		nextSequence: Number.isSafeInteger(value.nextSequence) ? Number(value.nextSequence) : records.length + 1,
		records: [...records].sort((a, b) => a.sequence - b.sequence),
	};
}

export interface CompactionDeliveryJournal {
	readonly filePath: string;
	readonly nextSequence?: () => Promise<number>;
	/** Reserve a globally unique delivery id before constructing its envelope. */
	readonly reserveId?: () => Promise<string>;
	readonly append: (envelope: CompactionDeliveryEnvelope, acceptedAt: number) => Promise<CompactionDeliveryRecord>;
	readonly listPending: () => Promise<readonly CompactionDeliveryRecord[]>;
	readonly markHandingOff: (id: string) => Promise<void>;
	readonly markDelivered: (id: string) => Promise<void>;
	readonly reconcile: (hasSessionEvidence: (id: string) => Promise<boolean> | boolean) => Promise<void>;
}

export async function openTrustedCompactionDeliveryJournal(options: {
	readonly manifestPath: string;
	readonly projectRoot: string;
	readonly isProjectTrusted: () => boolean;
	readonly memberName: string;
	readonly deps?: JournalDependencies;
}): Promise<CompactionDeliveryJournal> {
	if (!options.isProjectTrusted())
		throw new CompactionDeliveryJournalError(
			"untrusted-project",
			"cannot open compaction delivery journal in an untrusted project",
		);
	const manifestPath = path.resolve(options.manifestPath);
	if (!isTrustedCrewManifestPath(manifestPath, options.projectRoot))
		throw new CompactionDeliveryJournalError(
			"untrusted-path",
			"compaction delivery journal path is not trusted project-local configuration",
		);
	if (!isCrewDisplayName(options.memberName))
		throw new CompactionDeliveryJournalError(
			"invalid-member",
			"compaction delivery journal requires an exact member name",
		);

	const deps = { ...defaults, ...options.deps };
	const directory = path.join(path.dirname(manifestPath), "compaction-delivery");
	const filePath = path.join(directory, `${journalKey(manifestPath, options.memberName)}.json`);
	let operation = Promise.resolve();

	const read = async (): Promise<JournalFile> => {
		try {
			return parseJournal(JSON.parse((await deps.readFile(filePath)).toString("utf8")));
		} catch (error) {
			if (error instanceof CompactionDeliveryJournalError) throw error;
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, nextSequence: 1, records: [] };
			throw new CompactionDeliveryJournalError("storage-failed", "failed to read compaction delivery journal", {
				cause: error,
			});
		}
	};

	const write = async (next: JournalFile): Promise<void> => {
		await deps.mkdir(directory);
		const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
		let serialized: string;
		try {
			serialized = stableJson(next);
		} catch (error) {
			throw new CompactionDeliveryJournalError(
				"invalid-record",
				"compaction delivery journal contains an unserializable value",
				{
					cause: error,
				},
			);
		}
		await deps.writeFile(temporary, `${serialized}\n`);
		await deps.rename(temporary, filePath);
		await deps.syncDirectory(directory);
	};

	const transact = async <T>(task: () => Promise<T>, locked = false): Promise<T> => {
		const previous = operation;
		let releaseOperation!: () => void;
		operation = new Promise<void>((resolve) => (releaseOperation = resolve));
		await previous;
		let releaseLock: (() => Promise<void>) | undefined;
		try {
			if (locked) {
				try {
					releaseLock = await deps.acquireLock(filePath);
				} catch (error) {
					throw new CompactionDeliveryJournalError(
						"storage-failed",
						"failed to acquire delivery journal lock",
						{
							cause: error,
						},
					);
				}
			}
			return await task();
		} finally {
			try {
				await releaseLock?.();
			} finally {
				releaseOperation();
			}
		}
	};

	return {
		filePath,
		nextSequence: async () => (await read()).nextSequence,
		reserveId: () =>
			transact(async () => {
				const journal = await read();
				const sequence = journal.nextSequence;
				await write({ ...journal, nextSequence: sequence + 1 });
				return `delivery-${sequence}`;
			}, true),
		append: (envelope, acceptedAt) =>
			transact(async () => {
				const journal = await read();
				if (journal.records.some((record) => record.id === envelope.id))
					return journal.records.find((record) => record.id === envelope.id)!;
				if (
					envelope.bytes > COMPACTION_DELIVERY_MAX_ENTRY_BYTES ||
					journal.records.length >= COMPACTION_DELIVERY_MAX_ENTRIES ||
					recordBytes(journal.records) + envelope.bytes > COMPACTION_DELIVERY_MAX_BYTES
				)
					throw new CompactionDeliveryJournalError(
						"capacity-exceeded",
						"compaction delivery journal capacity exceeded",
					);
				const record: CompactionDeliveryRecord = {
					version: 1,
					id: envelope.id,
					sequence: journal.nextSequence,
					acceptedAt,
					bytes: envelope.bytes,
					state: "pending",
					envelope,
				};
				await write({
					version: 1,
					nextSequence: journal.nextSequence + 1,
					records: [...journal.records, record],
				});
				return record;
			}, true),
		// Handoff records remain visible until Pi evidence confirms delivery;
		// reconciliation deliberately returns both pending and handing-off rows.
		listPending: () => transact(async () => (await read()).records),
		markHandingOff: (id) =>
			transact(async () => {
				const journal = await read();
				if (!journal.records.some((record) => record.id === id)) return;
				await write({
					...journal,
					records: journal.records.map((record) =>
						record.id === id ? { ...record, state: "handing-off" } : record,
					),
				});
			}, true),
		markDelivered: (id) =>
			transact(async () => {
				const journal = await read();
				await write({ ...journal, records: journal.records.filter((record) => record.id !== id) });
			}, true),
		reconcile: (hasEvidence) =>
			transact(async () => {
				const journal = await read();
				const records: CompactionDeliveryRecord[] = [];
				for (const record of journal.records) {
					if (record.state === "handing-off" && (await hasEvidence(record.id))) continue;
					records.push(record.state === "handing-off" ? { ...record, state: "pending" } : record);
				}
				await write({ ...journal, records });
			}, true),
	};
}
