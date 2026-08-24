import {
	classifyCrewInitTarget,
	CREW_INIT_MANIFEST_REL,
	CREW_INIT_PROJECT_DIR,
	CREW_INIT_SOCKETS_REL,
	crewInitManagedPaths,
	crewInitTemplateBytes,
	redactCrewInitPath,
	type CrewInitPathEntry,
	type CrewInitTargetVerdict,
} from "../domain/index.ts";

/**
 * Deterministic `pi-bebop crew init` application flow (TASK-0054).
 *
 * Implements the TASK-0053 contract with an injected filesystem adapter so the
 * whole flow is deterministic and testable without real IO:
 *
 *   1. Preflight every managed path through the pure classification rule.
 *   2. Missing layout -> stage deterministic template bytes under the same
 *      project `.pi` directory and atomically publish `.pi/bebop`.
 *   3. Exact rerun -> `unchanged` with zero writes/renames.
 *   4. Any existing/symlinked/partial/differing layout -> stable conflict
 *      code with the offending relative path and an actionable next step; the
 *      pre-existing content is never touched.
 *   5. Publish failure or concurrency -> reconcile to `unchanged` when the
 *      concurrent winner produced the exact scaffold, otherwise a stable
 *      conflict; staging is cleaned on every terminal path.
 *
 * The flow never creates `inbox/`, socket links, processes, session files,
 * Git state, or trust records, and never accepts `--force`/overwrite.
 */

export type CrewInitFlowErrorCode =
	| "project-root-not-directory"
	| "managed-path-shape"
	| "symlinked-managed-path"
	| "managed-file-differs"
	| "partial-layout"
	| "permission-denied"
	| "publish-failed"
	| "staging-failed";

export type CrewInitPathKind = "file" | "directory" | "symlink" | "missing";

/** Injected filesystem surface: absolute paths, deterministic, no raw IO. */
export interface CrewInitFsAdapter {
	readonly readKind: (absPath: string) => Promise<CrewInitPathKind>;
	readonly readFile: (absPath: string) => Promise<string | undefined>;
	readonly writeFile: (absPath: string, bytes: string) => Promise<void>;
	readonly mkdir: (absPath: string) => Promise<void>;
	/** Create a private staging directory under the target project `.pi` (same filesystem). */
	readonly createStaging: (projectAbs: string) => Promise<string>;
	/** Atomically rename staging onto the target; throws with a stable errno code on conflict. */
	readonly publishStaging: (stagingAbs: string, targetAbs: string) => Promise<void>;
	readonly remove: (absPath: string) => Promise<void>;
	readonly touchFile: (absPath: string) => Promise<void>;
	readonly mtimeNs: (absPath: string) => Promise<number | undefined>;
}

export type CrewInitFlowResult =
	| {
			readonly ok: true;
			readonly status: "created" | "unchanged";
			readonly project: string;
			readonly manifestPath: string;
			readonly createdPaths: readonly string[];
			readonly verifiedPaths: readonly string[];
			readonly nextCommands: readonly string[];
	  }
	| { readonly ok: false; readonly error: { readonly code: CrewInitFlowErrorCode; readonly message: string } };

function errnoCode(error: unknown): string {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as NodeJS.ErrnoException).code)
		: "";
}

export function createCrewInitFlow(adapter: CrewInitFsAdapter) {
	const classify = async (projectAbs: string): Promise<CrewInitTargetVerdict> => {
		const rootKind = await adapter.readKind(projectAbs);
		const snapshot = {
			readRootKind: () => rootKind,
			readPath: async (relative: string): Promise<CrewInitPathEntry> => {
				const abs = `${projectAbs}/${relative}`;
				const kind = await adapter.readKind(abs);
				if (kind === "missing") return { kind: "missing" };
				if (kind === "symlink") return { kind: "symlink" };
				if (kind !== "file") return { kind: "directory" };
				const bytes = await adapter.readFile(abs);
				return { kind: "file", bytes };
			},
		};
		// classifyCrewInitTarget is synchronous over the snapshot; the async
		// reads above are collected first.
		const reads = crewInitManagedPaths().map((relative) => snapshot.readPath(relative));
		const entries = await Promise.all(reads);
		const entryByPath = new Map<string, CrewInitPathEntry>();
		crewInitManagedPaths().forEach((relative, index) => entryByPath.set(relative, entries[index]!));
		const syncSnapshot = {
			readRootKind: () => rootKind,
			readPath: (relative: string) => entryByPath.get(relative) ?? { kind: "missing" },
		};
		return classifyCrewInitTarget(syncSnapshot);
	};

	const run = async (projectAbs: string): Promise<CrewInitFlowResult> => {
		const verdict = await classify(projectAbs);
		if (verdict.kind === "unchanged") {
			return {
				ok: true,
				status: "unchanged",
				project: projectAbs,
				manifestPath: CREW_INIT_MANIFEST_REL,
				createdPaths: [],
				verifiedPaths: crewInitManagedPaths().filter((p) => !p.endsWith("/")),
				nextCommands: [`pi --crew-role lead`, `pi --crew-role developer`],
			};
		}
		if (verdict.kind === "conflict") {
			return {
				ok: false,
				error: {
					code: verdict.code as CrewInitFlowErrorCode,
					message: `Crew init conflict at ${redactCrewInitPath(verdict.path)}: ${verdict.nextStep}`,
				},
			};
		}

		// verdict.kind === "created": stage under project `.pi`, publish atomically.
		let staging: string | undefined;
		try {
			staging = await adapter.createStaging(projectAbs);
			const templates = crewInitTemplateBytes();
			for (const relative of crewInitManagedPaths()) {
				if (relative.endsWith("/")) continue;
				// Staging is the eventual `.pi/bebop` content root: strip the project prefix.
				const stagingRelative = relative.replace(`${CREW_INIT_PROJECT_DIR}/`, "");
				await adapter.writeFile(`${staging}/${stagingRelative}`, templates[relative]!);
			}
			// sockets/ empty directory for immediate discoverability.
			await adapter.mkdir(`${staging}/${CREW_INIT_SOCKETS_REL.replace(`${CREW_INIT_PROJECT_DIR}/`, "")}`);
			const targetAbs = `${projectAbs}/${CREW_INIT_PROJECT_DIR}`;
			try {
				await adapter.publishStaging(staging, targetAbs);
			} catch (error) {
				const code = errnoCode(error);
				if (code === "ENOTEMPTY" || code === "EEXIST") {
					// Concurrent initializer won: reconcile to unchanged or stable conflict.
					const after = await classify(projectAbs);
					if (after.kind === "unchanged") {
						return {
							ok: true,
							status: "unchanged",
							project: projectAbs,
							manifestPath: CREW_INIT_MANIFEST_REL,
							createdPaths: [],
							verifiedPaths: crewInitManagedPaths().filter((p) => !p.endsWith("/")),
							nextCommands: [`pi --crew-role lead`, `pi --crew-role developer`],
						};
					}
					if (after.kind === "conflict") {
						return {
							ok: false,
							error: {
								code: after.code as CrewInitFlowErrorCode,
								message: `Crew init conflict at ${redactCrewInitPath(after.path)}: ${after.nextStep}`,
							},
						};
					}
				}
				return {
					ok: false,
					error: {
						code: code === "EACCES" || code === "EPERM" ? "permission-denied" : "publish-failed",
						message: `Failed to publish crew scaffold: ${redactCrewInitPath(projectAbs)}`,
					},
				};
			}
			staging = undefined;
			return {
				ok: true,
				status: "created",
				project: projectAbs,
				manifestPath: CREW_INIT_MANIFEST_REL,
				createdPaths: crewInitManagedPaths().filter((p) => !p.endsWith("/")),
				verifiedPaths: [],
				nextCommands: [`pi --crew-role lead`, `pi --crew-role developer`],
			};
		} catch (error) {
			const code = errnoCode(error);
			return {
				ok: false,
				error: {
					code:
						code === "EACCES" || code === "EPERM"
							? "permission-denied"
							: code === "ENOTDIR"
								? "managed-path-shape"
								: "staging-failed",
					message: `Crew init failed: ${redactCrewInitPath(projectAbs)}`,
				},
			};
		} finally {
			if (staging) await adapter.remove(staging);
		}
	};

	return { run, classify };
}
