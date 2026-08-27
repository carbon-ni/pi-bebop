import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
	MAX_AGREEMENT_RECORD_ID_BYTES,
	MAX_AGREEMENT_TEXT_BYTES,
	isAgreementProposal,
	isAgreementRevision,
	isAgreementRecord,
	type AgreementProposal,
	type AgreementRecord,
	type AgreementRevision,
} from "../domain/index.ts";
import { isTrustedCrewManifestPath } from "./crew-manifest-store.ts";

const AGREEMENTS_DIR = "agreements";
const HISTORY_DIR = "history";
const PROPOSALS_DIR = "proposals";
const REVISIONS_DIR = "revisions";
const LOCK_FILE = ".lock";
const TEMP_PREFIX = ".tmp-";
export const MAX_AGREEMENT_RECORD_FILE_BYTES = MAX_AGREEMENT_TEXT_BYTES * 4;
export const MAX_AGREEMENT_RECORD_COUNT = 1024;

export type CrewAgreementStoreErrorCode =
	| "untrusted-project"
	| "untrusted-path"
	| "path-unsafe"
	| "invalid-proposal"
	| "invalid-revision"
	| "record-not-found"
	| "stale-base"
	| "invalid-reference"
	| "corrupt-record"
	| "record-oversized"
	| "duplicate-id"
	| "idempotency-conflict"
	| "lock-conflict"
	| "read-failed"
	| "write-failed";

export class CrewAgreementStoreError extends Error {
	readonly code: CrewAgreementStoreErrorCode;

	constructor(code: CrewAgreementStoreErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "CrewAgreementStoreError";
		this.code = code;
	}
}

type Deps = {
	mkdir: (directory: string) => Promise<void>;
	readdir: (directory: string) => Promise<string[]>;
	readFile: (filePath: string) => Promise<Buffer>;
	writeFile: (filePath: string, data: string) => Promise<void>;
	rename: (from: string, to: string) => Promise<void>;
	unlink: (filePath: string) => Promise<void>;
	stat: (filePath: string) => Promise<{ size: number; isFile(): boolean }>;
	lstat: (filePath: string) => Promise<{ isSymbolicLink(): boolean }>;
	realpath: (filePath: string) => Promise<string>;
	openLock: (filePath: string) => Promise<() => Promise<void>>;
	lockDeadlineMs: number;
	lockPollMs: number;
};

export interface CrewAgreementStoreDependencies {
	readonly mkdir?: (directory: string) => Promise<void>;
	readonly readdir?: (directory: string) => Promise<string[]>;
	readonly readFile?: (filePath: string) => Promise<Buffer>;
	readonly writeFile?: (filePath: string, data: string) => Promise<void>;
	readonly rename?: (from: string, to: string) => Promise<void>;
	readonly unlink?: (filePath: string) => Promise<void>;
	readonly stat?: (filePath: string) => Promise<{ size: number; isFile(): boolean }>;
	readonly lstat?: (filePath: string) => Promise<{ isSymbolicLink(): boolean }>;
	readonly realpath?: (filePath: string) => Promise<string>;
	readonly openLock?: (filePath: string) => Promise<() => Promise<void>>;
	readonly lockDeadlineMs?: number;
	readonly lockPollMs?: number;
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
	lockDeadlineMs: 2000,
	lockPollMs: 10,
};

export interface AgreementRecordSummary {
	readonly kind: AgreementRecord["kind"];
	readonly id: string;
	readonly status: AgreementProposal["status"] | AgreementRevision["status"];
	readonly origin: AgreementRecord["origin"];
}

export interface CrewAgreementStore {
	putProposal(record: unknown): Promise<{ readonly record: AgreementProposal; readonly alreadyPersisted?: boolean }>;
	putRevision(record: unknown): Promise<{ readonly record: AgreementRevision; readonly alreadyPersisted?: boolean }>;
	show(kind: AgreementRecord["kind"], id: string): Promise<AgreementRecord>;
	list(kind?: AgreementRecord["kind"]): Promise<readonly AgreementRecordSummary[]>;
}

function isErrno(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
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
		Buffer.byteLength(id, "utf8") <= MAX_AGREEMENT_RECORD_ID_BYTES &&
		/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)
	);
}
function recordError(code: CrewAgreementStoreErrorCode, message: string, cause?: unknown): CrewAgreementStoreError {
	return new CrewAgreementStoreError(code, message, cause === undefined ? undefined : { cause });
}
function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		return `{${Object.keys(value)
			.filter((key) => (value as Record<string, unknown>)[key] !== undefined)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

async function withLock<T>(lockPath: string, deps: Deps, operation: () => Promise<T>): Promise<T> {
	const deadline = Date.now() + deps.lockDeadlineMs;
	while (true) {
		try {
			const release = await deps.openLock(lockPath);
			try {
				return await operation();
			} finally {
				await release();
			}
		} catch (error) {
			if (!isErrno(error, "EEXIST") || Date.now() >= deadline)
				throw isErrno(error, "EEXIST")
					? recordError("lock-conflict", "another Agreement record write is in progress", error)
					: error;
			await new Promise((resolve) => setTimeout(resolve, deps.lockPollMs));
		}
	}
}

async function validateStorage(layout: string, deps: Deps): Promise<string> {
	const agreements = path.join(layout, AGREEMENTS_DIR);
	const history = path.join(agreements, HISTORY_DIR);
	await deps.mkdir(history);
	const realLayout = await deps.realpath(layout);
	const realAgreements = await deps.realpath(agreements);
	const realHistory = await deps.realpath(history);
	if (!isInside(realLayout, realAgreements) || !isInside(realAgreements, realHistory))
		throw recordError("path-unsafe", "Agreement history escapes the trusted Crew layout");
	return realHistory;
}

async function validateRecordDirectory(history: string, kind: AgreementRecord["kind"], deps: Deps): Promise<string> {
	const directory = path.join(history, kind === "proposal" ? PROPOSALS_DIR : REVISIONS_DIR);
	await deps.mkdir(directory);
	const realDirectory = await deps.realpath(directory);
	if (!isInside(history, realDirectory))
		throw recordError("path-unsafe", "Agreement record directory escapes trusted history");
	return realDirectory;
}

async function readRecord(filePath: string, deps: Deps): Promise<AgreementRecord> {
	try {
		if ((await deps.lstat(filePath)).isSymbolicLink())
			throw recordError("corrupt-record", "Agreement record must not be a symbolic link");
	} catch (error) {
		if (error instanceof CrewAgreementStoreError) throw error;
		if (!isErrno(error, "ENOENT")) throw recordError("read-failed", "failed to inspect Agreement record", error);
	}
	let stat;
	try {
		stat = await deps.stat(filePath);
	} catch (error) {
		if (isErrno(error, "ENOENT")) throw recordError("record-not-found", "Agreement record was not found");
		throw recordError("read-failed", "failed to inspect Agreement record", error);
	}
	if (!stat.isFile()) throw recordError("corrupt-record", "Agreement record is not a regular file");
	if (stat.size > MAX_AGREEMENT_RECORD_FILE_BYTES)
		throw recordError("record-oversized", "Agreement record is oversized");
	let bytes: Buffer;
	try {
		bytes = await deps.readFile(filePath);
	} catch (error) {
		throw recordError("read-failed", "failed to read Agreement record", error);
	}
	if (bytes.byteLength > MAX_AGREEMENT_RECORD_FILE_BYTES)
		throw recordError("record-oversized", "Agreement record is oversized");
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch (error) {
		throw recordError("corrupt-record", "Agreement record is not valid UTF-8 JSON", error);
	}
	if (!isAgreementRecord(parsed)) throw recordError("corrupt-record", "Agreement record failed schema validation");
	return parsed;
}

async function validateRevisionReferences(revision: AgreementRevision, history: string, deps: Deps): Promise<void> {
	for (const operation of revision.operations) {
		try {
			const proposalDirectory = await validateRecordDirectory(history, "proposal", deps);
			const proposal = await readRecord(path.join(proposalDirectory, `${operation.proposalId}.json`), deps);
			if (
				proposal.kind !== "proposal" ||
				proposal.status !== "proposed" ||
				proposal.intent !== operation.intent ||
				proposal.targetAgreementId !== operation.targetAgreementId
			)
				throw recordError(
					"invalid-reference",
					`Agreement operation references an incompatible proposal: ${operation.proposalId}`,
				);
		} catch (error) {
			if (error instanceof CrewAgreementStoreError && error.code === "record-not-found")
				throw recordError(
					"invalid-reference",
					`Agreement operation references a missing proposal: ${operation.proposalId}`,
				);
			throw error;
		}
	}
}

async function validateRevisionBase(revision: AgreementRevision, history: string, deps: Deps): Promise<void> {
	if (revision.baseRevisionId === "genesis") return;
	try {
		const revisionDirectory = await validateRecordDirectory(history, "revision", deps);
		const base = await readRecord(path.join(revisionDirectory, `${revision.baseRevisionId}.json`), deps);
		if (base.kind !== "revision" || base.status !== "activated")
			throw recordError("stale-base", "Agreement revision base is not the current activated revision");
	} catch (error) {
		if (error instanceof CrewAgreementStoreError && error.code === "record-not-found")
			throw recordError("stale-base", `Agreement revision base does not exist: ${revision.baseRevisionId}`);
		throw error;
	}
}

async function persist<T extends AgreementProposal | AgreementRevision>(
	record: T,
	kind: T["kind"],
	history: string,
	deps: Deps,
): Promise<{ readonly record: T; readonly alreadyPersisted?: boolean }> {
	const directory = await validateRecordDirectory(history, kind, deps);
	const target = path.join(directory, `${record.id}.json`);
	try {
		const existing = await readRecord(target, deps);
		if (stableJson(existing) === stableJson(record)) return { record, alreadyPersisted: true };
		throw recordError(
			"idempotency-conflict",
			`Agreement ${kind} id already contains a different record: ${record.id}`,
		);
	} catch (error) {
		if (!(error instanceof CrewAgreementStoreError) || error.code !== "record-not-found") throw error;
	}
	if (kind === "revision") {
		const revision = record as AgreementRevision;
		await validateRevisionReferences(revision, history, deps);
		await validateRevisionBase(revision, history, deps);
	}
	const temporary = path.join(directory, `${TEMP_PREFIX}${record.id}-${process.pid}-${Date.now()}.json`);
	try {
		await deps.writeFile(temporary, stableJson(record));
		await deps.rename(temporary, target);
		return { record };
	} catch (error) {
		try {
			await deps.unlink(temporary);
		} catch {
			// Best-effort cleanup; the target was never published.
		}
		throw recordError("write-failed", `failed to persist Agreement ${kind}`, error);
	}
}

export async function openTrustedCrewAgreementStore(options: {
	readonly manifestPath: string;
	readonly projectRoot: string;
	readonly isProjectTrusted: () => boolean;
	readonly deps?: CrewAgreementStoreDependencies;
}): Promise<CrewAgreementStore> {
	if (!options.isProjectTrusted())
		throw recordError("untrusted-project", "cannot open Agreement history in an untrusted project");
	const manifestPath = path.resolve(options.manifestPath);
	if (!isTrustedCrewManifestPath(manifestPath, options.projectRoot))
		throw recordError("untrusted-path", "Agreement history is not trusted project-local configuration");
	const deps: Deps = { ...defaultDeps, ...options.deps };
	const history = await validateStorage(path.dirname(manifestPath), deps);
	const lockPath = path.join(history, LOCK_FILE);
	const put = async <T extends AgreementProposal | AgreementRevision>(record: unknown, kind: T["kind"]) => {
		const valid = kind === "proposal" ? isAgreementProposal(record) : isAgreementRevision(record);
		if (!valid)
			throw recordError(
				kind === "proposal" ? "invalid-proposal" : "invalid-revision",
				`invalid Agreement ${kind}`,
			);
		if (!safeId((record as T).id)) throw recordError("path-unsafe", "Agreement record id is not a safe filename");
		return await withLock(lockPath, deps, () => persist(record as T, kind, history, deps));
	};
	return {
		putProposal: (record) =>
			put(record, "proposal") as Promise<{ record: AgreementProposal; alreadyPersisted?: boolean }>,
		putRevision: (record) =>
			put(record, "revision") as Promise<{ record: AgreementRevision; alreadyPersisted?: boolean }>,
		show: async (kind, id) => {
			if (kind !== "proposal" && kind !== "revision")
				throw recordError("path-unsafe", "Agreement record kind is not supported");
			if (!safeId(id)) throw recordError("path-unsafe", "Agreement record id is not a safe filename");
			const directory = await validateRecordDirectory(history, kind, deps);
			const record = await readRecord(path.join(directory, `${id}.json`), deps);
			if (record.kind !== kind)
				throw recordError("corrupt-record", "Agreement record kind does not match its history");
			return record;
		},
		list: async (kind) => {
			const kinds = kind === undefined ? (["proposal", "revision"] as const) : ([kind] as const);
			const summaries: AgreementRecordSummary[] = [];
			for (const currentKind of kinds) {
				const directory = await validateRecordDirectory(history, currentKind, deps);
				let names: string[];
				try {
					names = await deps.readdir(directory);
				} catch (error) {
					if (isErrno(error, "ENOENT")) continue;
					throw recordError("read-failed", "failed to list Agreement records", error);
				}
				const files = names.filter((name) => name.endsWith(".json")).sort();
				if (files.length > MAX_AGREEMENT_RECORD_COUNT)
					throw recordError("corrupt-record", "Agreement history exceeds its record bound");
				for (const name of files) {
					const record = await readRecord(path.join(directory, name), deps);
					if (record.kind !== currentKind)
						throw recordError("corrupt-record", "Agreement record kind does not match its history");
					summaries.push({ kind: record.kind, id: record.id, status: record.status, origin: record.origin });
				}
			}
			return summaries.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
		},
	};
}
