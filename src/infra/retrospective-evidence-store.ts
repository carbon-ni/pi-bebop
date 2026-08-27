import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
	MAX_RETROSPECTIVE_EVIDENCE_TEXT_BYTES,
	canonicalRetrospectiveEvidenceFingerprintInput,
	canonicalRetrospectiveEvidenceJson,
	isRetrospectiveEvidence,
	orderAndDeduplicateRetrospectiveEvidence,
	parseRetrospectiveEvidence,
	type RetrospectiveEvidence,
	type RetrospectiveEvidenceFingerprint,
} from "../domain/index.ts";
import { isTrustedCrewManifestPath } from "./crew-manifest-store.ts";

const RETROSPECTIVES_DIR = "retrospectives";
const EVIDENCE_DIR = "evidence";
const RECORDS_DIR = "records";
const LOCK_FILE = ".lock";
const TEMP_PREFIX = ".tmp-";
export const MAX_RETROSPECTIVE_EVIDENCE_FILE_BYTES = MAX_RETROSPECTIVE_EVIDENCE_TEXT_BYTES * 2;
export const MAX_RETROSPECTIVE_EVIDENCE_RECORDS = 1024;

export type RetrospectiveEvidenceStoreErrorCode =
	| "untrusted-project"
	| "untrusted-path"
	| "path-unsafe"
	| "invalid-evidence"
	| "fingerprint-invalid"
	| "fingerprint-conflict"
	| "id-conflict"
	| "record-not-found"
	| "corrupt-record"
	| "unsupported-version"
	| "record-oversized"
	| "capacity-exceeded"
	| "lock-conflict"
	| "read-failed"
	| "write-failed";

export class RetrospectiveEvidenceStoreError extends Error {
	readonly code: RetrospectiveEvidenceStoreErrorCode;
	constructor(code: RetrospectiveEvidenceStoreErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "RetrospectiveEvidenceStoreError";
		this.code = code;
	}
}

export interface RetrospectiveEvidencePutResult {
	readonly record: RetrospectiveEvidence;
	readonly alreadyPersisted?: boolean;
	readonly deduplicatedByFingerprint?: boolean;
}
export interface RetrospectiveEvidenceStore {
	put(record: unknown): Promise<RetrospectiveEvidencePutResult>;
	show(id: string): Promise<RetrospectiveEvidence>;
	list(): Promise<readonly RetrospectiveEvidence[]>;
}

type FileStat = { size: number; isFile(): boolean };
type FileLstat = { isSymbolicLink(): boolean };
type StorePaths = { evidence: string; records: string };
type Deps = {
	mkdir: (directory: string) => Promise<void>;
	readdir: (directory: string) => Promise<string[]>;
	readFile: (filePath: string) => Promise<Buffer>;
	writeFile: (filePath: string, data: string) => Promise<void>;
	rename: (from: string, to: string) => Promise<void>;
	unlink: (filePath: string) => Promise<void>;
	stat: (filePath: string) => Promise<FileStat>;
	lstat: (filePath: string) => Promise<FileLstat>;
	realpath: (filePath: string) => Promise<string>;
	openLock: (filePath: string) => Promise<() => Promise<void>>;
	fingerprint: RetrospectiveEvidenceFingerprint;
	now: () => number;
	sleep: (milliseconds: number) => Promise<void>;
	lockDeadlineMs: number;
	lockPollMs: number;
};

export interface RetrospectiveEvidenceStoreDependencies {
	readonly mkdir?: Deps["mkdir"];
	readonly readdir?: Deps["readdir"];
	readonly readFile?: Deps["readFile"];
	readonly writeFile?: Deps["writeFile"];
	readonly rename?: Deps["rename"];
	readonly unlink?: Deps["unlink"];
	readonly stat?: Deps["stat"];
	readonly lstat?: Deps["lstat"];
	readonly realpath?: Deps["realpath"];
	readonly openLock?: Deps["openLock"];
	readonly fingerprint?: RetrospectiveEvidenceFingerprint;
	readonly now?: Deps["now"];
	readonly sleep?: Deps["sleep"];
	readonly lockDeadlineMs?: number;
	readonly lockPollMs?: number;
}

export function sha256RetrospectiveEvidenceFingerprint(canonicalInput: string): string {
	return createHash("sha256").update(canonicalInput, "utf8").digest("hex");
}

function isErrno(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

const defaultDeps: Deps = {
	mkdir: async (directory) => {
		await fs.mkdir(directory, { recursive: true });
	},
	readdir: (directory) => fs.readdir(directory),
	readFile: (filePath) => fs.readFile(filePath),
	writeFile: async (filePath, data) => {
		await fs.writeFile(filePath, data, "utf8");
	},
	rename: (from, to) => fs.rename(from, to),
	unlink: async (filePath) => {
		await fs.unlink(filePath);
	},
	stat: async (filePath) => {
		const stat = await fs.stat(filePath);
		return { size: stat.size, isFile: () => stat.isFile() };
	},
	lstat: async (filePath) => {
		const stat = await fs.lstat(filePath);
		return { isSymbolicLink: () => stat.isSymbolicLink() };
	},
	realpath: (filePath) => fs.realpath(filePath),
	openLock: async (filePath) => {
		const handle = await fs.open(filePath, "wx");
		return async () => {
			await handle.close();
			try {
				await fs.unlink(filePath);
			} catch (error) {
				if (!isErrno(error, "ENOENT")) throw error;
			}
		};
	},
	fingerprint: sha256RetrospectiveEvidenceFingerprint,
	now: () => Date.now(),
	sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
	lockDeadlineMs: 2000,
	lockPollMs: 10,
};

function storeError(
	code: RetrospectiveEvidenceStoreErrorCode,
	message: string,
	cause?: unknown,
): RetrospectiveEvidenceStoreError {
	return new RetrospectiveEvidenceStoreError(code, message, cause === undefined ? undefined : { cause });
}
function isInside(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function safeId(id: string): boolean {
	return (
		typeof id === "string" &&
		id.trim() === id &&
		id.length > 0 &&
		Buffer.byteLength(id, "utf8") <= 128 &&
		/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)
	);
}

async function withLock<T>(lockPath: string, deps: Deps, operation: () => Promise<T>): Promise<T> {
	const deadline = deps.now() + deps.lockDeadlineMs;
	while (true) {
		let release: (() => Promise<void>) | undefined;
		try {
			release = await deps.openLock(lockPath);
		} catch (error) {
			if (!isErrno(error, "EEXIST")) throw error;
			if (deps.now() >= deadline)
				throw storeError("lock-conflict", "another Retrospective evidence write is in progress", error);
			await deps.sleep(deps.lockPollMs);
			continue;
		}
		try {
			return await operation();
		} finally {
			await release();
		}
	}
}

async function ensureContainedDirectory(configuredDirectory: string, realParent: string, deps: Deps): Promise<string> {
	try {
		if ((await deps.lstat(configuredDirectory)).isSymbolicLink())
			throw storeError("path-unsafe", "Retrospective evidence directory must not be a symbolic link");
		if ((await deps.stat(configuredDirectory)).isFile())
			throw storeError("path-unsafe", "Retrospective evidence directory is not a directory");
	} catch (error) {
		if (error instanceof RetrospectiveEvidenceStoreError) throw error;
		if (!isErrno(error, "ENOENT")) throw storeError("read-failed", "failed to inspect evidence directory", error);
		await deps.mkdir(configuredDirectory);
	}
	const realDirectory = await deps.realpath(configuredDirectory);
	if (!isInside(realParent, realDirectory))
		throw storeError("path-unsafe", "Retrospective evidence storage escapes the trusted Crew layout");
	return realDirectory;
}

async function validateStorePaths(layout: string, projectRoot: string, deps: Deps): Promise<StorePaths> {
	const [realProjectRoot, realLayout] = await Promise.all([deps.realpath(projectRoot), deps.realpath(layout)]);
	if (!isInside(realProjectRoot, realLayout))
		throw storeError("path-unsafe", "Crew layout escapes the trusted project root");
	const retrospectives = path.join(layout, RETROSPECTIVES_DIR);
	const realRetrospectives = await ensureContainedDirectory(retrospectives, realLayout, deps);
	const evidence = path.join(retrospectives, EVIDENCE_DIR);
	const realEvidence = await ensureContainedDirectory(evidence, realRetrospectives, deps);
	const records = path.join(evidence, RECORDS_DIR);
	const realRecords = await ensureContainedDirectory(records, realEvidence, deps);
	return { evidence: realEvidence, records: realRecords };
}

async function inspectRegularFile(filePath: string, deps: Deps): Promise<FileStat> {
	try {
		if ((await deps.lstat(filePath)).isSymbolicLink())
			throw storeError("corrupt-record", "Retrospective evidence record must not be a symbolic link");
		const stat = await deps.stat(filePath);
		if (!stat.isFile()) throw storeError("corrupt-record", "Retrospective evidence record is not a regular file");
		return stat;
	} catch (error) {
		if (error instanceof RetrospectiveEvidenceStoreError) throw error;
		if (isErrno(error, "ENOENT")) throw storeError("record-not-found", "Retrospective evidence was not found");
		throw storeError("read-failed", "failed to inspect Retrospective evidence record", error);
	}
}

function parseRecordBytes(bytes: Buffer): RetrospectiveEvidence {
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch (error) {
		throw storeError("corrupt-record", "Retrospective evidence is not valid UTF-8 JSON", error);
	}
	if (typeof parsed === "object" && parsed !== null && "version" in parsed && parsed.version !== 1)
		throw storeError("unsupported-version", "Retrospective evidence version is unsupported");
	if (!isRetrospectiveEvidence(parsed))
		throw storeError("corrupt-record", "Retrospective evidence failed schema validation");
	return parseRetrospectiveEvidence(parsed);
}

function verifyFingerprint(record: RetrospectiveEvidence, deps: Deps): void {
	const expected = deps.fingerprint(canonicalRetrospectiveEvidenceFingerprintInput(record));
	if (record.fingerprint !== expected)
		throw storeError("fingerprint-invalid", `Retrospective evidence fingerprint is invalid: ${record.id}`);
}

async function readRecord(filePath: string, expectedId: string, deps: Deps): Promise<RetrospectiveEvidence> {
	const stat = await inspectRegularFile(filePath, deps);
	if (stat.size > MAX_RETROSPECTIVE_EVIDENCE_FILE_BYTES)
		throw storeError("record-oversized", "Retrospective evidence record is oversized");
	let bytes: Buffer;
	try {
		bytes = await deps.readFile(filePath);
	} catch (error) {
		throw storeError("read-failed", "failed to read Retrospective evidence record", error);
	}
	if (bytes.byteLength > MAX_RETROSPECTIVE_EVIDENCE_FILE_BYTES)
		throw storeError("record-oversized", "Retrospective evidence record is oversized");
	const record = parseRecordBytes(bytes);
	if (record.id !== expectedId)
		throw storeError("corrupt-record", "Retrospective evidence ID does not match its filename");
	verifyFingerprint(record, deps);
	return record;
}

async function recordNames(recordsDirectory: string, deps: Deps): Promise<string[]> {
	let names: string[];
	try {
		names = await deps.readdir(recordsDirectory);
	} catch (error) {
		throw storeError("read-failed", "failed to list Retrospective evidence", error);
	}
	const records = names.filter((name) => name.endsWith(".json")).sort();
	if (records.length > MAX_RETROSPECTIVE_EVIDENCE_RECORDS)
		throw storeError("capacity-exceeded", "Retrospective evidence exceeds its record-count bound");
	return records;
}

async function readAllRecords(recordsDirectory: string, deps: Deps): Promise<readonly RetrospectiveEvidence[]> {
	const names = await recordNames(recordsDirectory, deps);
	const records: RetrospectiveEvidence[] = [];
	for (const name of names) {
		const id = name.slice(0, -".json".length);
		if (!safeId(id)) throw storeError("corrupt-record", "Retrospective evidence filename is unsafe");
		records.push(await readRecord(path.join(recordsDirectory, name), id, deps));
	}
	let ordered: readonly RetrospectiveEvidence[];
	try {
		ordered = orderAndDeduplicateRetrospectiveEvidence(records);
	} catch (error) {
		throw storeError("corrupt-record", "Retrospective evidence history contains conflicting records", error);
	}
	if (ordered.length !== records.length)
		throw storeError("corrupt-record", "Retrospective evidence history contains duplicate fingerprints");
	return ordered;
}

function findExisting(
	record: RetrospectiveEvidence,
	existing: readonly RetrospectiveEvidence[],
): RetrospectiveEvidencePutResult | undefined {
	const sameId = existing.find((candidate) => candidate.id === record.id);
	if (sameId !== undefined) {
		if (canonicalRetrospectiveEvidenceJson(sameId) === canonicalRetrospectiveEvidenceJson(record))
			return { record: sameId, alreadyPersisted: true };
		throw storeError("id-conflict", `Retrospective evidence ID already contains different bytes: ${record.id}`);
	}
	const sameFingerprint = existing.find((candidate) => candidate.fingerprint === record.fingerprint);
	if (sameFingerprint === undefined) return undefined;
	if (
		canonicalRetrospectiveEvidenceFingerprintInput(sameFingerprint) !==
		canonicalRetrospectiveEvidenceFingerprintInput(record)
	)
		throw storeError(
			"fingerprint-conflict",
			`Retrospective evidence fingerprint maps to conflicting events: ${record.fingerprint}`,
		);
	return { record: sameFingerprint, alreadyPersisted: true, deduplicatedByFingerprint: true };
}

let temporarySequence = 0;
async function publishRecord(record: RetrospectiveEvidence, recordsDirectory: string, deps: Deps): Promise<void> {
	const target = path.join(recordsDirectory, `${record.id}.json`);
	temporarySequence += 1;
	const temporary = path.join(recordsDirectory, `${TEMP_PREFIX}${process.pid}-${temporarySequence}.json.tmp`);
	try {
		await deps.writeFile(temporary, canonicalRetrospectiveEvidenceJson(record));
		await deps.rename(temporary, target);
	} catch (error) {
		try {
			await deps.unlink(temporary);
		} catch {
			// Best effort: a temp file is never considered a durable evidence record.
		}
		throw storeError("write-failed", "failed to persist Retrospective evidence", error);
	}
}

export async function openTrustedRetrospectiveEvidenceStore(options: {
	readonly manifestPath: string;
	readonly projectRoot: string;
	readonly isProjectTrusted: () => boolean;
	readonly deps?: RetrospectiveEvidenceStoreDependencies;
}): Promise<RetrospectiveEvidenceStore> {
	if (!options.isProjectTrusted())
		throw storeError("untrusted-project", "cannot open Retrospective evidence in an untrusted project");
	const manifestPath = path.resolve(options.manifestPath);
	if (!isTrustedCrewManifestPath(manifestPath, options.projectRoot))
		throw storeError("untrusted-path", "Retrospective evidence is not trusted project-local configuration");
	const deps: Deps = { ...defaultDeps, ...options.deps };
	const layout = path.dirname(manifestPath);
	await validateStorePaths(layout, options.projectRoot, deps);
	const paths = () => validateStorePaths(layout, options.projectRoot, deps);
	return {
		put: async (value) => {
			if (!isRetrospectiveEvidence(value)) throw storeError("invalid-evidence", "invalid Retrospective evidence");
			const record = parseRetrospectiveEvidence(value);
			if (!safeId(record.id)) throw storeError("path-unsafe", "Retrospective evidence ID is not a safe filename");
			verifyFingerprint(record, deps);
			const currentPaths = await paths();
			return await withLock(path.join(currentPaths.evidence, LOCK_FILE), deps, async () => {
				const lockedPaths = await paths();
				const existing = await readAllRecords(lockedPaths.records, deps);
				const replay = findExisting(record, existing);
				if (replay !== undefined) return replay;
				if (existing.length >= MAX_RETROSPECTIVE_EVIDENCE_RECORDS)
					throw storeError("capacity-exceeded", "Retrospective evidence reached its record-count bound");
				await publishRecord(record, lockedPaths.records, deps);
				return { record };
			});
		},
		show: async (id) => {
			if (!safeId(id)) throw storeError("path-unsafe", "Retrospective evidence ID is not a safe filename");
			const { records } = await paths();
			return await readRecord(path.join(records, `${id}.json`), id, deps);
		},
		list: async () => {
			const { records } = await paths();
			return await readAllRecords(records, deps);
		},
	};
}
