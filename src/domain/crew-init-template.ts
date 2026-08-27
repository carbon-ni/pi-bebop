/**
 * `crew init --from <template source>` template contract (pure, no IO).
 *
 * A template is a plain directory that is already a valid crew layout:
 * `crew.json` (strict v1 manifest via the existing `parseCrewManifest`) plus
 * the `instructions/*.md` files it references. The `template/` subdir of a
 * source repository is auto-detected. Runtime-owned paths (`sockets/`,
 * `inbox/`, `.gitignore`) are never adopted; their presence inside a template
 * is an operational error naming the path.
 *
 * Validation is strict and total: nothing is written before it completes.
 * All verdicts carry stable codes and actionable messages.
 */

import { CREW_INIT_PROJECT_DIR, CREW_INIT_SOCKETS_REL } from "./crew-init.ts";
import { parseCrewManifest, type CrewManifest } from "./crew-manifest.ts";

// ============================================================================
// Template source classification
// ============================================================================

export type TemplateSourceDescriptor =
	| { readonly kind: "local"; readonly location: string }
	| { readonly kind: "git"; readonly location: string; readonly ref?: string; readonly resolvedCommit?: string };

/** Classifies a `--from` value: git URL shapes vs filesystem paths. Pure. */
export function classifyTemplateSource(raw: string): TemplateSourceDescriptor {
	if (isGitUrl(raw)) return { kind: "git", location: raw };
	return { kind: "local", location: raw };
}

function isGitUrl(value: string): boolean {
	if (/^(https?|ssh|git|git\+ssh):\/\//i.test(value)) return true;
	if (/^git@[\w.-]+:/.test(value)) return true;
	if (value.toLowerCase().endsWith(".git")) return true;
	return false;
}

/** Serializable provenance carried in created/unchanged results. */
export interface CrewInitProvenance {
	readonly type: "local" | "git";
	readonly location: string;
	readonly resolvedRef?: string;
}

export function describeTemplateSource(source: TemplateSourceDescriptor): CrewInitProvenance {
	if (source.kind === "git") {
		return source.resolvedCommit === undefined
			? { type: "git", location: source.location }
			: { type: "git", location: source.location, resolvedRef: source.resolvedCommit };
	}
	return { type: "local", location: source.location };
}

// ============================================================================
// Template root auto-detection
// ============================================================================

export type TemplateRootVerdict =
	| { readonly ok: true; readonly root: string }
	| { readonly ok: false; readonly code: "template-not-found"; readonly message: string };

/**
 * Auto-detects the template root: the `template/` subdir when it holds a
 * `crew.json`, otherwise the source root itself.
 */
export function selectTemplateRoot(entries: readonly string[]): TemplateRootVerdict {
	if (entries.includes("template/crew.json")) return { ok: true, root: "template/" };
	if (entries.includes("crew.json")) return { ok: true, root: "" };
	return {
		ok: false,
		code: "template-not-found",
		message: "Template has no crew.json: expected <source>/crew.json or <source>/template/crew.json",
	};
}

// ============================================================================
// Strict template validation (before any write)
// ============================================================================

/** Template file set keyed by template-root-relative posix path. */
export type TemplateFileSet = Record<string, string>;

const RUNTIME_OWNED_FILES = new Set([".gitignore"]);

function runtimeOwnedPath(relative: string): string | undefined {
	if (RUNTIME_OWNED_FILES.has(relative)) return relative;
	if (relative === "sockets" || relative.startsWith("sockets/")) return "sockets/";
	if (relative === "inbox" || relative.startsWith("inbox/")) return "inbox/";
	return undefined;
}

export type TemplateValidationVerdict =
	| { readonly ok: true; readonly manifest: CrewManifest; readonly files: TemplateFileSet }
	| { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Validates a template file set strictly. The manifest must parse with the
 * existing `parseCrewManifest` strictness, every referenced instruction file
 * must exist, and runtime-owned paths must be absent (rejected, never
 * skipped). Pure: reads nothing, writes nothing.
 */
export function validateTemplate(files: TemplateFileSet): TemplateValidationVerdict {
	for (const relative of Object.keys(files).sort()) {
		const owned = runtimeOwnedPath(relative);
		if (owned) {
			return {
				ok: false,
				code: "template-runtime-owned-path",
				message: `Template contains runtime-owned path '${owned}' (${relative}); remove it from the template and rerun`,
			};
		}
	}
	const manifestBytes = files["crew.json"];
	if (manifestBytes === undefined) {
		return {
			ok: false,
			code: "template-not-found",
			message: "Template has no crew.json: expected <source>/crew.json or <source>/template/crew.json",
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(manifestBytes);
	} catch {
		return {
			ok: false,
			code: "template-invalid-manifest",
			message: "Template crew.json is not valid JSON; fix the template manifest and rerun",
		};
	}
	let manifest: CrewManifest;
	try {
		manifest = parseCrewManifest(parsed, "crew.json");
	} catch (error) {
		const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "";
		return {
			ok: false,
			code: code ? `template-invalid-manifest:${code}` : "template-invalid-manifest",
			message: `Template crew.json is invalid: ${(error as { message?: unknown }).message ?? "unknown error"}`,
		};
	}
	for (const member of manifest.members) {
		const referenced = member.instructionsFile;
		if (referenced !== undefined && files[referenced] === undefined) {
			return {
				ok: false,
				code: "template-missing-instruction",
				message: `Template crew.json references '${referenced}' but the template does not contain it; add the file to the template and rerun`,
			};
		}
	}
	return { ok: true, manifest, files };
}

// ============================================================================
// Adoption mapping
// ============================================================================

/**
 * Maps a validated template onto managed `.pi/bebop` bytes: manifest and
 * referenced instruction files verbatim; nothing else. Runtime-owned paths
 * are never part of the result by construction.
 */
export function adoptedBytesFromTemplate(files: TemplateFileSet, manifest: CrewManifest): Record<string, string> {
	const adopted: Record<string, string> = {
		[`${CREW_INIT_PROJECT_DIR}/crew.json`]: files["crew.json"]!,
	};
	for (const member of manifest.members) {
		if (member.instructionsFile !== undefined && files[member.instructionsFile] !== undefined) {
			adopted[`${CREW_INIT_PROJECT_DIR}/${member.instructionsFile}`] = files[member.instructionsFile]!;
		}
	}
	return adopted;
}

/** Managed paths (creation order) for an adopted template: root, sockets dir, adopted files. */
export function adoptedManagedPaths(adoptedBytes: Record<string, string>): readonly string[] {
	return [
		`${CREW_INIT_PROJECT_DIR}/`,
		...Object.keys(adoptedBytes)
			.sort()
			.map((relative) => relative),
		CREW_INIT_SOCKETS_REL,
	];
}
