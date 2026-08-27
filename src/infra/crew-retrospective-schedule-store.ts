import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
	emptyRetrospectiveSchedule,
	validateRetrospectiveScheduleState,
	type RetrospectiveScheduleState,
} from "../domain/index.ts";
import { isTrustedCrewManifestPath } from "./crew-manifest-store.ts";

/** TASK-0108: trusted atomic schedule marker storage. */
export const RETROSPECTIVE_SCHEDULE_DIRNAME = "retrospectives";
export const RETROSPECTIVE_SCHEDULE_FILENAME = "schedule.json";
export const MAX_RETROSPECTIVE_SCHEDULE_FILE_BYTES = 16 * 1024;

export type CrewRetrospectiveScheduleStoreErrorCode =
	| "untrusted-project"
	| "untrusted-path"
	| "read-failed"
	| "write-failed"
	| "invalid-state"
	| "lock-conflict";

export class CrewRetrospectiveScheduleStoreError extends Error {
	constructor(
		readonly code: CrewRetrospectiveScheduleStoreErrorCode,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "CrewRetrospectiveScheduleStoreError";
	}
}

export interface CrewRetrospectiveScheduleStore {
	read(): Promise<RetrospectiveScheduleState | null>;
	write(state: RetrospectiveScheduleState): Promise<void>;
}

interface Dependencies {
	readonly mkdir: (directory: string) => Promise<void>;
	readonly readFile: (file: string) => Promise<Buffer>;
	readonly writeFile: (file: string, data: string) => Promise<void>;
	readonly rename: (from: string, to: string) => Promise<void>;
	readonly unlink: (file: string) => Promise<void>;
	readonly stat: (file: string) => Promise<{ size: number; isFile(): boolean }>;
	readonly realpath: (file: string) => Promise<string>;
	readonly openLock: (file: string) => Promise<() => Promise<void>>;
	readonly lockDeadlineMs: number;
	readonly lockPollMs: number;
}

const dependencies: Dependencies = {
	mkdir: async (directory) => {
		await fs.mkdir(directory, { recursive: true });
	},
	readFile: (file) => fs.readFile(file),
	writeFile: async (file, data) => {
		await fs.writeFile(file, data, "utf8");
	},
	rename: (from, to) => fs.rename(from, to),
	unlink: async (file) => {
		await fs.unlink(file);
	},
	stat: async (file) => {
		const value = await fs.stat(file);
		return { size: value.size, isFile: () => value.isFile() };
	},
	realpath: (file) => fs.realpath(file),
	openLock: async (file) => {
		const handle = await fs.open(file, "wx");
		return async () => {
			await handle.close();
			await fs.unlink(file).catch((error: unknown) => {
				if (!isCode(error, "ENOENT")) throw error;
			});
		};
	},
	lockDeadlineMs: 2_000,
	lockPollMs: 25,
};

function isCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isInside(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function withLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
	const deadline = Date.now() + dependencies.lockDeadlineMs;
	let release: (() => Promise<void>) | undefined;
	while (!release) {
		try {
			release = await dependencies.openLock(lockPath);
		} catch (error) {
			if (!isCode(error, "EEXIST") || Date.now() >= deadline)
				throw new CrewRetrospectiveScheduleStoreError("lock-conflict", "retrospective schedule is locked", {
					cause: error,
				});
			await new Promise((resolve) => setTimeout(resolve, dependencies.lockPollMs));
		}
	}
	try {
		return await operation();
	} finally {
		await release();
	}
}

export async function openTrustedCrewRetrospectiveScheduleStore(options: {
	readonly manifestPath: string;
	readonly projectRoot: string;
	readonly isProjectTrusted: () => boolean;
}): Promise<CrewRetrospectiveScheduleStore> {
	if (!options.isProjectTrusted())
		throw new CrewRetrospectiveScheduleStoreError(
			"untrusted-project",
			"cannot open schedule in an untrusted project",
		);
	const manifestPath = path.resolve(options.manifestPath);
	if (!isTrustedCrewManifestPath(manifestPath, options.projectRoot))
		throw new CrewRetrospectiveScheduleStoreError(
			"untrusted-path",
			"schedule requires a trusted crew manifest path",
		);
	const layout = path.dirname(manifestPath);
	const projectRoot = path.resolve(options.projectRoot);
	const directory = path.join(layout, RETROSPECTIVE_SCHEDULE_DIRNAME);
	if (!isInside(projectRoot, directory))
		throw new CrewRetrospectiveScheduleStoreError("untrusted-path", "schedule escapes the trusted project");
	await dependencies.mkdir(directory);
	const realLayout = await dependencies.realpath(layout);
	const realDirectory = await dependencies.realpath(directory);
	if (!isInside(realLayout, realDirectory))
		throw new CrewRetrospectiveScheduleStoreError("untrusted-path", "schedule directory escapes crew layout");
	const file = path.join(directory, RETROSPECTIVE_SCHEDULE_FILENAME);
	const lock = path.join(directory, ".lock");
	return {
		async read() {
			try {
				const stat = await dependencies.stat(file);
				if (!stat.isFile() || stat.size > MAX_RETROSPECTIVE_SCHEDULE_FILE_BYTES)
					throw new Error("invalid schedule file");
				const state = validateRetrospectiveScheduleState(
					JSON.parse((await dependencies.readFile(file)).toString("utf8")),
				);
				return state;
			} catch (error) {
				if (isCode(error, "ENOENT")) return null;
				if (error instanceof CrewRetrospectiveScheduleStoreError) throw error;
				throw new CrewRetrospectiveScheduleStoreError("read-failed", "failed to read retrospective schedule", {
					cause: error,
				});
			}
		},
		async write(state) {
			let validated: RetrospectiveScheduleState;
			try {
				validated = validateRetrospectiveScheduleState(state);
			} catch (error) {
				throw new CrewRetrospectiveScheduleStoreError("invalid-state", "invalid retrospective schedule state", {
					cause: error,
				});
			}
			await withLock(lock, async () => {
				const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
				try {
					await dependencies.writeFile(temporary, `${JSON.stringify(validated, null, "\t")}\n`);
					await dependencies.rename(temporary, file);
				} catch (error) {
					await dependencies.unlink(temporary).catch(() => undefined);
					throw new CrewRetrospectiveScheduleStoreError(
						"write-failed",
						"failed to persist retrospective schedule",
						{ cause: error },
					);
				}
			});
		},
	};
}

export function defaultRetrospectiveSchedule(): RetrospectiveScheduleState {
	return emptyRetrospectiveSchedule();
}
