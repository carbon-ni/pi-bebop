/**
 * Deterministic `pi-bebop crew init` scaffold contract (TASK-0053, define-only).
 *
 * This file defines the non-interactive, idempotent scaffold contract WITHOUT
 * touching the filesystem: the canonical managed layout, the versioned
 * deterministic template bytes, the preflight/conflict decision rule, the
 * structured output/exit-code contract, usage validation, and path redaction.
 * The CLI and filesystem mutation are TASK-0054.
 *
 * Contract invariants:
 *
 * - Defaults: project = current working directory; canonical `.pi/bebop` only
 *   (never compatibility `.pi/crew`); output = TOON; no prompts; no `--force`.
 * - Determinism: template bytes are fixed versioned strings, LF-only,
 *   independent of locale, time, user, Git, environment, and network.
 * - Preflight: every managed path is classified before any write. Missing
 *   layout -> created; exact rerun -> unchanged (zero writes); any existing,
 *   symlinked, partial, or differing layout -> conflict with stable code,
 *   paths, and an actionable next step. No partial update, no silent
 *   overwrite, no force/merge/update.
 * - Output: structured result carries status, project root, relative managed
 *   paths, and copyable next commands; errors use stable codes and never leak
 *   stack traces, secrets, absolute home expansion, or raw dependency errors.
 * - Exit codes: 0 created/unchanged, 1 operational/conflict failure, 2 usage.
 */

export const CREW_INIT_TEMPLATE_VERSION = "1";
export const CREW_INIT_PROJECT_DIR = ".pi/bebop";
export const CREW_INIT_MANIFEST_REL = `${CREW_INIT_PROJECT_DIR}/crew.json`;
export const CREW_INIT_GITIGNORE_REL = `${CREW_INIT_PROJECT_DIR}/.gitignore`;
export const CREW_INIT_INSTRUCTIONS_REL = `${CREW_INIT_PROJECT_DIR}/instructions`;
export const CREW_INIT_SOCKETS_REL = `${CREW_INIT_PROJECT_DIR}/sockets/`;

export const CREW_INIT_EXIT_OK = 0;
export const CREW_INIT_EXIT_OPERATIONAL = 1;
export const CREW_INIT_EXIT_USAGE = 2;

export type CrewInitFormat = "toon" | "json" | "text";

const NEWLINE = "\n";

/** Canonical managed paths in creation order; directories end with `/`. */
export function crewInitManagedPaths(): readonly string[] {
	return [
		CREW_INIT_PROJECT_DIR + "/",
		CREW_INIT_GITIGNORE_REL,
		CREW_INIT_MANIFEST_REL,
		`${CREW_INIT_INSTRUCTIONS_REL}/lead.md`,
		`${CREW_INIT_INSTRUCTIONS_REL}/product.md`,
		`${CREW_INIT_INSTRUCTIONS_REL}/developer.md`,
		`${CREW_INIT_INSTRUCTIONS_REL}/quality.md`,
		CREW_INIT_SOCKETS_REL,
	];
}

/** Deterministic `.gitignore`: runtime-owned sockets and private durable inbox only. */
export function crewInitGitignore(): string {
	return [
		"# Runtime-owned member endpoints and durable inbox (created by Bebop).",
		"",
		"sockets/",
		"inbox/",
		"",
	].join(NEWLINE);
}

/** Deterministic version 1 crew.json with generic exact names and roles. */
export function crewInitCrewJson(): string {
	return [
		"{",
		'  "version": 1,',
		'  "presence": { "notifications": true },',
		'  "intake": { "contact": "product" },',
		'  "members": [',
		"    {",
		'      "name": "lead",',
		'      "role": "lead",',
		'      "description": "Coordinates ownership, verification, and integration",',
		'      "socket": "sockets/lead.sock",',
		'      "instructionsFile": "instructions/lead.md"',
		"    },",
		"    {",
		'      "name": "product",',
		'      "role": "product",',
		'      "description": "Shapes problems, acceptance criteria, and shared language",',
		'      "socket": "sockets/product.sock",',
		'      "instructionsFile": "instructions/product.md"',
		"    },",
		"    {",
		'      "name": "developer",',
		'      "role": "developer",',
		'      "description": "Builds domain and application changes",',
		'      "socket": "sockets/developer.sock",',
		'      "instructionsFile": "instructions/developer.md"',
		"    },",
		"    {",
		'      "name": "quality",',
		'      "role": "quality",',
		'      "description": "Verifies acceptance and failure paths",',
		'      "socket": "sockets/quality.sock",',
		'      "instructionsFile": "instructions/quality.md"',
		"    }",
		"  ]",
		"}",
		"",
	].join(NEWLINE);
}

/**
 * Deterministic role instruction templates (TASK-0053). Each defines mission,
 * expected inputs, expected outputs, escalation, and definition of done,
 * aligned with docs/SOFTWARE-CREW-WORKFLOW.md. They remain examples to review
 * before starting member processes — never permissions.
 */
export function crewInitInstructions(role: "lead" | "product" | "developer" | "quality"): string {
	switch (role) {
		case "lead":
			return [
				"# Lead role instructions",
				"",
				"## Mission",
				"Coordinate exact ownership, timing, independent verification, and integration evidence without turning Bebop into a task, Git, review, or CI system.",
				"",
				"## Expected inputs",
				"- A shaped problem with acceptance criteria, constraints, and non-goals from product.",
				"- Explicit blocker or completion evidence from a named developer.",
				"- Independent findings and verdict from a named quality member.",
				"",
				"## Expected outputs",
				"- A bounded assignment naming owner, outcome, acceptance reference, and expected evidence.",
				"- An explicit verification request to a different named member.",
				"- An integration decision grounded in developer and quality evidence.",
				"",
				"## Escalation",
				"1. Send follow-up for normal new information.",
				"2. Use redirect_member only when the target should change its next model step.",
				"3. Use interrupt_member only to abort and recover work that is stuck, harmful, or based on invalid assumptions.",
				"",
				"## Definition of done",
				"- One exact implementation owner and one independent verifier were identified.",
				"- Acceptance and failure-path evidence were reported through normal crew messages.",
				"- Integration decision and remaining risk are explicit.",
				"",
			].join(NEWLINE);
		case "product":
			return [
				"# Product role instructions",
				"",
				"## Mission",
				"Turn incoming needs into clear problems and acceptance boundaries, then hand an actionable outcome to lead without prescribing implementation.",
				"",
				"## Expected inputs",
				"- One-way unverified external messages received through Crew Intake when this member is configured as exact crew contact.",
				"- Clarification or feasibility feedback from lead, developer, or quality.",
				"- Existing product language, constraints, and external planning artifacts.",
				"",
				"## Expected outputs",
				"- Problem-first statement and desired outcome.",
				"- Testable acceptance criteria plus non-goals and constraints.",
				"- A bounded handoff to lead.",
				"",
				"## Escalation",
				"- Send shaped work with send_follow_up; use send_to_inbox when durable delivery matters.",
				"",
				"## Definition of done",
				"- Problem, outcome, acceptance criteria, and constraints are explicit.",
				"- Handoff to lead is bounded; external stakeholder state stays in native systems.",
				"",
			].join(NEWLINE);
		case "developer":
			return [
				"# Developer role instructions",
				"",
				"## Mission",
				"Implement one explicitly owned change using host-project conventions and deterministic feedback, then report evidence and blockers without claiming workflow state Bebop does not own.",
				"",
				"## Expected inputs",
				"- A named assignment with problem/outcome, acceptance reference, constraints, and expected evidence.",
				"- Follow-up or Redirect guidance from coordinating members.",
				"- Independent quality findings after handoff.",
				"",
				"## Expected outputs",
				"- A small readable change within assigned ownership.",
				"- Deterministic tests for acceptance and failure paths.",
				"- A bounded report: paths/change, checks, coverage/risk, blockers, and known limitations.",
				"- An explicit quality handoff; no self-approval. Ask an independent member to verify before closing.",
				"",
				"## Escalation",
				"- Use send_follow_up for clarification, evidence, and ordinary blockers.",
				"- Never redirect or interrupt another member merely to accelerate a response.",
				"- Escalate external dependency, unsafe assumption, overlapping ownership, or unverifiable acceptance to lead.",
				"",
				"## Definition of done",
				"- Acceptance and unhappy paths have evidence; an independent member verified the change.",
				"- Candidate is formatted and relevant checks pass or exact failures are reported.",
				"- Independent quality member received exact review scope.",
				"",
			].join(NEWLINE);
		case "quality":
			return [
				"# Quality role instructions",
				"",
				"## Mission",
				"Independently verify acceptance, failure paths, lifecycle behavior, and regression risk; report evidence and verdict without silently becoming implementer.",
				"",
				"## Expected inputs",
				"- Exact candidate paths or commit, acceptance reference, expected behavior, checks already run, and known risks from developer or lead.",
				"- Clarification messages and adopted crew-wide constraints.",
				"- Host-project test, coverage, watcher, package, and review tooling.",
				"",
				"## Expected outputs",
				"- PASS, FAIL, or BLOCKED verdict tied to acceptance criteria.",
				"- Reproduction/evidence for each finding with severity and impacted path.",
				"- Checks, coverage/risk evidence, and remaining uncertainty.",
				"",
				"## Escalation",
				"- Send normal findings with send_follow_up to an exact developer name and verdict to lead.",
				"- Use redirect_member only when active direction should change; use interrupt_member only when continuing is actively harmful.",
				"",
				"## Definition of done",
				"- Happy and unhappy paths, privacy/security boundaries, and nearby regressions were verified proportionate to risk.",
				"- Verdict and evidence were reported.",
				"",
			].join(NEWLINE);
	}
}

/** Deterministic aggregate template bytes keyed by project-relative managed path. */
export function crewInitTemplateBytes(): Record<string, string> {
	return {
		[CREW_INIT_GITIGNORE_REL]: crewInitGitignore(),
		[CREW_INIT_MANIFEST_REL]: crewInitCrewJson(),
		[`${CREW_INIT_INSTRUCTIONS_REL}/lead.md`]: crewInitInstructions("lead"),
		[`${CREW_INIT_INSTRUCTIONS_REL}/product.md`]: crewInitInstructions("product"),
		[`${CREW_INIT_INSTRUCTIONS_REL}/developer.md`]: crewInitInstructions("developer"),
		[`${CREW_INIT_INSTRUCTIONS_REL}/quality.md`]: crewInitInstructions("quality"),
	};
}

// ============================================================================
// Preflight / conflict classification (pure, no IO)
// ============================================================================

export interface CrewInitPathEntry {
	readonly kind: "file" | "directory" | "symlink" | "missing";
	readonly bytes?: string;
}

/** Abstract filesystem snapshot so the decision rule is pure and testable. */
export interface CrewInitFSSnapshot {
	readonly readRootKind: () => "directory" | "file" | "symlink" | "missing";
	readonly readPath: (relative: string) => CrewInitPathEntry;
}

export type CrewInitTargetVerdict =
	| { readonly kind: "created" }
	| { readonly kind: "unchanged" }
	| { readonly kind: "conflict"; readonly code: string; readonly path: string; readonly nextStep: string };

/** Optional parameterization: template bytes + managed paths for `--from` adoption. */
export interface CrewInitTemplatePlan {
	readonly bytes: Record<string, string>;
	readonly managedPaths: readonly string[];
}

/** Default plan: the built-in deterministic template. */
function builtinTemplatePlan(): CrewInitTemplatePlan {
	return { bytes: crewInitTemplateBytes(), managedPaths: crewInitManagedPaths() };
}

/**
 * Pure preflight decision. Missing layout -> created. Exact byte-identical
 * rerun -> unchanged. Any existing, symlinked, partial, or differing layout ->
 * stable conflict with the offending relative path and an actionable next
 * step. Never suggests overwrite or `--force`; never mutates.
 *
 * `plan` parameterizes the expected bytes for `--from` adoption; omitted it
 * is the built-in template (zero-arg behavior stays byte-identical).
 */
export function classifyCrewInitTarget(
	snapshot: CrewInitFSSnapshot,
	plan: CrewInitTemplatePlan = builtinTemplatePlan(),
): CrewInitTargetVerdict {
	const rootKind = snapshot.readRootKind();
	if (rootKind !== "directory") {
		return {
			kind: "conflict",
			code: "project-root-not-directory",
			path: ".",
			nextStep: "Choose a directory project root or remove the conflicting file before running crew init",
		};
	}
	const templates = plan.bytes;
	let missing = 0;
	for (const relative of plan.managedPaths) {
		if (relative.endsWith("/")) {
			const entry = snapshot.readPath(relative);
			if (entry.kind === "missing") {
				missing += 1;
				continue;
			}
			if (entry.kind === "symlink")
				return conflict(relative, "symlinked-managed-path", "Remove the symlink or choose another project");
			if (entry.kind !== "directory")
				return conflict(relative, "managed-path-shape", "Remove the file or choose another project");
			continue;
		}
		const expected = templates[relative];
		const entry = snapshot.readPath(relative);
		if (entry.kind === "missing") {
			missing += 1;
			continue;
		}
		if (entry.kind === "symlink")
			return conflict(relative, "symlinked-managed-path", "Remove the symlink or choose another project");
		if (entry.kind !== "file")
			return conflict(relative, "managed-path-shape", "Remove the directory or choose another project");
		if (entry.bytes !== expected)
			return conflict(
				relative,
				"managed-file-differs",
				`Review ${relative}; edit it or move it aside, then rerun crew init`,
			);
	}
	if (missing === plan.managedPaths.length) return { kind: "created" };
	if (missing === 0) return { kind: "unchanged" };
	return {
		kind: "conflict",
		code: "partial-layout",
		path: ".pi/bebop",
		nextStep:
			"Some managed files already exist; no partial update is performed. Review .pi/bebop or choose another project, then rerun crew init",
	};
}

function conflict(path: string, code: string, nextStep: string): CrewInitTargetVerdict {
	return { kind: "conflict", code, path, nextStep };
}

// ============================================================================
// Output contract
// ============================================================================

export interface CrewInitResult {
	readonly status: "created" | "unchanged";
	readonly project: string;
	readonly manifestPath: string;
	readonly createdPaths: readonly string[];
	readonly verifiedPaths: readonly string[];
	readonly nextCommands: readonly string[];
}

/**
 * Redacts an absolute path to the canonical `.pi/bebop` suffix and never
 * emits absolute home expansion or secret-bearing content. Output surfaces
 * only project-relative managed paths.
 */
export function redactCrewInitPath(path: string): string {
	if (path.includes("secret") || path.includes("credential") || path.includes("token")) return "<redacted>";
	const normalized = path.split(/[\\/]+/).filter(Boolean);
	if (normalized.length <= 3) return path;
	return normalized.slice(-3).join("/");
}

// ============================================================================
// Usage validation (AXI: validate flags before dependencies)
// ============================================================================

export interface CrewInitUsage {
	readonly project?: string;
	readonly format: CrewInitFormat;
}

export type CrewInitUsageVerdict =
	| { readonly ok: true; readonly usage: CrewInitUsage }
	| {
			readonly ok: false;
			readonly code: "unknown-flag" | "missing-value" | "incompatible-format" | "duplicate-flag";
	  };

/** Pure flag validation. Unknown/duplicate/missing/incompatible flags fail before any filesystem call. */
export function validateCrewInitUsage(argv: readonly string[]): CrewInitUsageVerdict {
	let project: string | undefined;
	let format: CrewInitFormat = "toon";
	const seen = new Set<string>();
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index]!;
		if (flag === "--project" || flag === "--format") {
			if (seen.has(flag)) return { ok: false, code: "duplicate-flag" };
			seen.add(flag);
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--")) return { ok: false, code: "missing-value" };
			if (flag === "--project") project = value;
			else if (value === "toon" || value === "json" || value === "text") format = value;
			else return { ok: false, code: "incompatible-format" };
			index += 1;
			continue;
		}
		return { ok: false, code: "unknown-flag" };
	}
	return { ok: true, usage: { project, format } };
}

/** Command-local `--help`: defaults, files, exit codes, and runnable examples. */
export function crewInitHelp(): string {
	return [
		"pi-bebop crew init [--project <directory>] [--format toon|json|text]",
		"",
		"Scaffold a canonical .pi/bebop software crew in a project. Non-interactive and idempotent;",
		"never overwrites existing content and never requires --force.",
		"",
		"Options:",
		"  --project <directory>   Target project root (default: current working directory)",
		"  --format <format>       Output format: toon (default), json, or text",
		"  --help                  Show this help",
		"",
		"Files created (deterministic, versioned):",
		"  .pi/bebop/crew.json",
		"  .pi/bebop/.gitignore",
		"  .pi/bebop/instructions/{lead,product,developer,quality}.md",
		"  .pi/bebop/sockets/",
		"",
		"Exit codes:",
		"  0  created or byte-identical no-op",
		"  1  filesystem/conflict/operational failure",
		"  2  usage error",
		"",
		"Examples:",
		"  pi-bebop crew init",
		"  pi-bebop crew init --project /path/to/project",
		"  pi-bebop crew init --format json",
		"",
		"Review crew.json contact/names/instructions before starting member processes.",
		"",
	].join(NEWLINE);
}
