import {
	adoptedBytesFromTemplate,
	adoptedManagedPaths,
	classifyCrewInitTarget,
	describeTemplateSource,
	selectTemplateRoot,
	validateTemplate,
	CREW_INIT_MANIFEST_REL,
	CREW_INIT_PROJECT_DIR,
	CREW_INIT_SOCKETS_REL,
	crewInitManagedPaths,
	crewInitTemplateBytes,
	redactCrewInitPath,
	type CrewInitPathEntry,
	type CrewInitProvenance,
	type CrewInitTargetVerdict,
	type CrewInitTemplatePlan,
	type TemplateEntries,
	type TemplateSourceDescriptor,
} from "../domain/index.ts";
import type { TemplateSourceAdapter } from "../infra/crew-init-template-source.ts";

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
	| "staging-failed"
	| "template-not-found"
	| "template-invalid-manifest"
	| "template-missing-instruction"
	| "template-runtime-owned-path"
	| "template-symlinked-path"
	| "template-source-unreadable"
	| "template-source-too-large"
	| "git-unavailable"
	| "git-clone-failed"
	| "git-network-unreachable"
	| "git-auth-required"
	| "git-unsupported-url"
	| "git-ref-not-found"
	| "git-checkout-failed"
	| "git-resolve-failed";

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
			readonly source?: CrewInitProvenance;
	  }
	| { readonly ok: false; readonly error: { readonly code: CrewInitFlowErrorCode; readonly message: string } };

/** Optional deps for `--from` template adoption. */
export interface CrewInitFlowDeps {
	readonly sourceAdapter?: TemplateSourceAdapter;
}

function errnoCode(error: unknown): string {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as NodeJS.ErrnoException).code)
		: "";
}

/** Loads and validates an external template into a scaffold plan. Pure error mapping, zero destination IO. */
async function loadTemplatePlan(
	sourceAdapter: TemplateSourceAdapter,
	from: TemplateSourceDescriptor,
	cwd: string,
): Promise<{ ok: true; plan: CrewInitTemplatePlan; source: CrewInitProvenance } | { ok: false; code: CrewInitFlowErrorCode; message: string }> {
	const read = await sourceAdapter.read(from, { cwd });
	if (read.ok === false) return { ok: false, code: read.code as CrewInitFlowErrorCode, message: read.message };
	const root = selectTemplateRoot(Object.keys(read.entries));
	if (root.ok === false) return { ok: false, code: root.code, message: root.message };
	const scoped: TemplateEntries = {};
	for (const [key, entry] of Object.entries(read.entries)) {
		if (key.startsWith(root.root)) scoped[key.slice(root.root.length)] = entry;
	}
	const verdict = validateTemplate(scoped);
	if (verdict.ok === false) return { ok: false, code: verdict.code as CrewInitFlowErrorCode, message: verdict.message };
	const bytes = adoptedBytesFromTemplate(verdict.files, verdict.manifest);
	return {
		ok: true,
		plan: { bytes, managedPaths: adoptedManagedPaths(bytes) },
		source: describeTemplateSource(read.descriptor),
	};
}

type TemplateLoadResult =
	| { readonly ok: true; readonly plan?: CrewInitTemplatePlan; readonly source?: CrewInitProvenance }
	| { readonly ok: false; readonly code: CrewInitFlowErrorCode; readonly message: string };

async function loadRequestedTemplate(
	deps: CrewInitFlowDeps,
	options: { from?: TemplateSourceDescriptor; cwd?: string },
): Promise<TemplateLoadResult> {
	if (options.from === undefined) return { ok: true };
	if (!deps.sourceAdapter) {
		return { ok: false, code: "staging-failed", message: "Template source adapter is not configured" };
	}
	return loadTemplatePlan(deps.sourceAdapter, options.from, options.cwd ?? "");
}

function managedFiles(plan?: CrewInitTemplatePlan): readonly string[] {
	return (plan?.managedPaths ?? crewInitManagedPaths()).filter((path) => !path.endsWith("/"));
}

function successResult(
	project: string,
	status: "created" | "unchanged",
	createdPaths: readonly string[],
	verifiedPaths: readonly string[],
	source?: CrewInitProvenance,
): CrewInitFlowResult {
	return {
		ok: true,
		status,
		project,
		manifestPath: CREW_INIT_MANIFEST_REL,
		createdPaths,
		verifiedPaths,
		nextCommands: [`pi --crew-role lead`, `pi --crew-role developer`],
		...(source ? { source } : {}),
	};
}

function conflictResult(verdict: Extract<CrewInitTargetVerdict, { kind: "conflict" }>): CrewInitFlowResult {
	return {
		ok: false,
		error: {
			code: verdict.code as CrewInitFlowErrorCode,
			message: `Crew init conflict at ${redactCrewInitPath(verdict.path)}: ${verdict.nextStep}`,
		},
	};
}

function publishFailure(project: string, error: unknown): CrewInitFlowResult {
	const code = errnoCode(error);
	return {
		ok: false,
		error: {
			code: code === "EACCES" || code === "EPERM" ? "permission-denied" : "publish-failed",
			message: `Failed to publish crew scaffold: ${redactCrewInitPath(project)}`,
		},
	};
}

async function writeStaging(
	adapter: CrewInitFsAdapter,
	staging: string,
	plan?: CrewInitTemplatePlan,
): Promise<void> {
	const templates = plan?.bytes ?? crewInitTemplateBytes();
	const managed = plan?.managedPaths ?? crewInitManagedPaths();
	for (const relative of managed) {
		if (relative.endsWith("/")) continue;
		const stagingRelative = relative.replace(`${CREW_INIT_PROJECT_DIR}/`, "");
		await adapter.writeFile(`${staging}/${stagingRelative}`, templates[relative]!);
	}
	await adapter.mkdir(`${staging}/${CREW_INIT_SOCKETS_REL.replace(`${CREW_INIT_PROJECT_DIR}/`, "")}`);
}

type PublishResult =
	| { readonly kind: "created" }
	| { readonly kind: "unchanged" }
	| { readonly kind: "conflict"; readonly verdict: Extract<CrewInitTargetVerdict, { kind: "conflict" }> }
	| { readonly kind: "error"; readonly error: unknown };

async function publishStaging(
	adapter: CrewInitFsAdapter,
	project: string,
	plan: CrewInitTemplatePlan | undefined,
	classify: (project: string, plan?: CrewInitTemplatePlan) => Promise<CrewInitTargetVerdict>,
): Promise<PublishResult> {
	let staging: string | undefined;
	try {
		staging = await adapter.createStaging(project);
		await writeStaging(adapter, staging, plan);
		try {
			await adapter.publishStaging(staging, `${project}/${CREW_INIT_PROJECT_DIR}`);
		} catch (error) {
			const code = errnoCode(error);
			if (code === "ENOTEMPTY" || code === "EEXIST") {
				const after = await classify(project, plan);
				if (after.kind === "unchanged") return { kind: "unchanged" };
				if (after.kind === "conflict") return { kind: "conflict", verdict: after };
			}
			return { kind: "error", error };
		}
		staging = undefined;
		return { kind: "created" };
	} catch (error) {
		return { kind: "error", error };
	} finally {
		if (staging) await adapter.remove(staging);
	}
}

export function createCrewInitFlow(adapter: CrewInitFsAdapter, deps: CrewInitFlowDeps = {}) {
	const classify = async (
		projectAbs: string,
		plan: CrewInitTemplatePlan = { bytes: crewInitTemplateBytes(), managedPaths: crewInitManagedPaths() },
	): Promise<CrewInitTargetVerdict> => {
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
		const reads = plan.managedPaths.map((relative) => snapshot.readPath(relative));
		const entries = await Promise.all(reads);
		const entryByPath = new Map<string, CrewInitPathEntry>();
		plan.managedPaths.forEach((relative, index) => entryByPath.set(relative, entries[index]!));
		const syncSnapshot = {
			readRootKind: () => rootKind,
			readPath: (relative: string) => entryByPath.get(relative) ?? { kind: "missing" },
		};
		return classifyCrewInitTarget(syncSnapshot, plan);
	};

	const run = async (
		projectAbs: string,
		options: { from?: TemplateSourceDescriptor; cwd?: string } = {},
	): Promise<CrewInitFlowResult> => {
		const loaded = await loadRequestedTemplate(deps, options);
		if (loaded.ok === false) return { ok: false, error: { code: loaded.code, message: loaded.message } };
		const plan = loaded.plan;
		const source = loaded.source;
		const verified = managedFiles(plan);
		const verdict = await classify(projectAbs, plan);
		if (verdict.kind === "unchanged") return successResult(projectAbs, "unchanged", [], verified, source);
		if (verdict.kind === "conflict") return conflictResult(verdict);

		const published = await publishStaging(adapter, projectAbs, plan, classify);
		if (published.kind === "created") return successResult(projectAbs, "created", verified, [], source);
		if (published.kind === "unchanged") return successResult(projectAbs, "unchanged", [], verified, source);
		if (published.kind === "conflict") return conflictResult(published.verdict);
		return publishFailure(projectAbs, published.error);
	};
	return { run, classify };
}
