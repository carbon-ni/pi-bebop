import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { isCrewRetrospectiveRecord, type CrewRetrospectiveRecord } from "../domain/retrospective-record.ts";

/** TASK-0115: immutable freeze-once Crew Retrospective Record store. */

export const CREW_RETROSPECTIVE_RECORDS_DIRNAME = "retrospective-records";

export type CrewRetrospectiveRecordStoreErrorCode =
	| "untrusted-project"
	| "untrusted-path"
	| "path-unsafe"
	| "invalid-record"
	| "already-frozen-conflict"
	| "unknown-record"
	| "read-failed"
	| "write-failed";

export class CrewRetrospectiveRecordStoreError extends Error {
	constructor(
		readonly code: CrewRetrospectiveRecordStoreErrorCode,
		message: string,
	) {
		super(message);
		this.name = "CrewRetrospectiveRecordStoreError";
	}
}

export interface CrewRetrospectiveRecordFreezeResult {
	readonly record: CrewRetrospectiveRecord;
	readonly alreadyFrozen?: boolean;
}

export interface CrewRetrospectiveRecordStore {
	freeze(record: CrewRetrospectiveRecord): Promise<CrewRetrospectiveRecordFreezeResult>;
	show(id: string): Promise<CrewRetrospectiveRecord>;
	list(): Promise<readonly CrewRetrospectiveRecord[]>;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function recordBytes(record: CrewRetrospectiveRecord): string {
	return `${JSON.stringify(record, null, "\t")}\n`;
}

function recordFileHash(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Opens the trusted project-local retrospective record store. Records are
 * write-once: freezing identical bytes is idempotent; different bytes for a
 * frozen id are an explicit conflict and never replace the original.
 */
export async function openTrustedCrewRetrospectiveRecordStore(options: {
	readonly projectRoot: string;
	readonly manifestPath: string;
	readonly isProjectTrusted: () => boolean;
}): Promise<CrewRetrospectiveRecordStore> {
	if (!options.isProjectTrusted())
		throw new CrewRetrospectiveRecordStoreError("untrusted-project", "cannot open records in an untrusted project");
	const manifestPath = path.resolve(options.manifestPath);
	const layout = path.dirname(manifestPath);
	const root = path.resolve(options.projectRoot);
	const recordsDir = path.join(layout, CREW_RETROSPECTIVE_RECORDS_DIRNAME);
	if (!recordsDir.startsWith(root + path.sep))
		throw new CrewRetrospectiveRecordStoreError("untrusted-path", "records directory escapes the project root");
	await fs.mkdir(recordsDir, { recursive: true });

	const recordPath = (id: string) => path.join(recordsDir, `${id}.json`);

	async function readRecordFile(id: string): Promise<CrewRetrospectiveRecord> {
		const content = await fs.readFile(recordPath(id), "utf8");
		const parsed: unknown = JSON.parse(content);
		if (!isCrewRetrospectiveRecord(parsed))
			throw new CrewRetrospectiveRecordStoreError("invalid-record", `stored record is invalid: ${id}`);
		return parsed;
	}

	return {
		freeze: async (record) => {
			if (!isCrewRetrospectiveRecord(record))
				throw new CrewRetrospectiveRecordStoreError("invalid-record", "not a crew retrospective record");
			if (!ID_PATTERN.test(record.id))
				throw new CrewRetrospectiveRecordStoreError("path-unsafe", "record id is not a safe filename");
			const target = recordPath(record.id);
			const bytes = recordBytes(record);
			try {
				const existing = await fs.readFile(target, "utf8");
				const existingRecord = JSON.parse(existing) as CrewRetrospectiveRecord;
				if (
					existingRecord.contentHash === record.contentHash &&
					recordFileHash(existing) === recordFileHash(bytes)
				) {
					return { record: existingRecord, alreadyFrozen: true };
				}
				throw new CrewRetrospectiveRecordStoreError(
					"already-frozen-conflict",
					`record id already frozen with different bytes: ${record.id}`,
				);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
			await fs.writeFile(temp, bytes, { encoding: "utf8" });
			try {
				await fs.rename(temp, target);
			} catch (error) {
				await fs.unlink(temp).catch(() => undefined);
				// Another writer may have frozen first: treat rename collision as replay check.
				if (
					(error as NodeJS.ErrnoException).code === "ENOTEMPTY" ||
					(error as NodeJS.ErrnoException).code === "EEXIST"
				) {
					const existing = await fs.readFile(target, "utf8");
					if (recordFileHash(existing) === recordFileHash(bytes)) {
						return { record: JSON.parse(existing) as CrewRetrospectiveRecord, alreadyFrozen: true };
					}
				}
				throw new CrewRetrospectiveRecordStoreError("write-failed", `failed to freeze record: ${record.id}`);
			}
			return { record };
		},
		show: async (id) => {
			if (!ID_PATTERN.test(id))
				throw new CrewRetrospectiveRecordStoreError("path-unsafe", "record id is not a safe filename");
			try {
				return await readRecordFile(id);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT")
					throw new CrewRetrospectiveRecordStoreError("unknown-record", `record not found: ${id}`);
				throw error;
			}
		},
		list: async () => {
			const entries = await fs.readdir(recordsDir);
			const records: CrewRetrospectiveRecord[] = [];
			for (const entry of entries.sort()) {
				if (!entry.endsWith(".json")) continue;
				if (entry.includes(".tmp")) continue;
				try {
					records.push(await readRecordFile(entry.slice(0, -".json".length)));
				} catch {
					// Corrupt entries stay invisible to listing but remain on disk for inspection.
				}
			}
			return records;
		},
	};
}
