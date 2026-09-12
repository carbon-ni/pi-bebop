import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	getLatestMembershipState,
	MEMBERSHIP_SNAPSHOT_VERSION,
	selectCrewMemberByRole,
	type CrewManifest,
	type CrewMember,
	type PersistedMembershipState,
} from "../domain/index.ts";
import { getTrustedCrewManifestPaths } from "../infra/crew-layout.ts";
import { readTrustedCrewManifestMetadata } from "../infra/crew-manifest-store.ts";
import { manifestFingerprint } from "../infra/crew-session-store.ts";
import { probeMemberEndpoint } from "../infra/member-endpoint.ts";
import { resolveMemberEndpoint } from "../infra/socket-endpoint.ts";
import { validateSessionFileEvidence } from "../infra/session-file-security.ts";

export type RoleSessionResumeFailureCode =
	| "untrusted-project"
	| "missing-manifest"
	| "ambiguous-manifest"
	| "empty-role"
	| "unknown-role"
	| "ambiguous-role"
	| "session-scan-failed"
	| "empty"
	| "malformed-session"
	| "missing-session-file"
	| "untrusted-session-root"
	| "session-id-mismatch"
	| "session-cwd-mismatch"
	| "inactive-membership"
	| "membership-drift"
	| "already-online"
	| "cancelled";

export interface RoleSessionCandidate {
	readonly sessionId: string;
	readonly sessionFile: string;
	readonly cwd: string;
	readonly root: string;
	readonly name?: string;
	readonly modified: string;
}

export interface RoleSessionMember {
	readonly name: string;
	readonly role: string;
	readonly socketPath: string;
}

export type RoleSessionDiscoveryResult =
	| {
			readonly ok: true;
			readonly member: RoleSessionMember;
			readonly candidates: readonly RoleSessionCandidate[];
			readonly skipped: number;
	  }
	| {
			readonly ok: false;
			readonly code: RoleSessionResumeFailureCode;
			readonly message: string;
	  };

export type RoleSessionResolutionResult =
	| { readonly ok: true; readonly candidate: RoleSessionCandidate }
	| { readonly ok: false; readonly code: RoleSessionResumeFailureCode; readonly message: string };

type RoleSessionFailure = Extract<RoleSessionDiscoveryResult, { readonly ok: false }>;

interface SessionInfoLike {
	readonly id: string;
	readonly path: string;
	readonly cwd: string;
	readonly name?: string;
	readonly modified: Date;
}

export interface RoleSessionResumeDependencies {
	readonly readManifest: typeof readTrustedCrewManifestMetadata;
	readonly manifestExists: (file: string) => Promise<boolean>;
	readonly listSessions: () => Promise<readonly SessionInfoLike[]>;
	readonly openSession: (file: string) => Promise<SessionManager>;
	readonly validateSession: typeof validateSessionFileEvidence;
	readonly resolveEndpoint: typeof resolveMemberEndpoint;
	readonly probe: (socketPath: string) => Promise<boolean>;
}

function defaultDependencies(): RoleSessionResumeDependencies {
	return {
		readManifest: readTrustedCrewManifestMetadata,
		manifestExists: async (file) => {
			try {
				await fs.access(file);
				return true;
			} catch {
				return false;
			}
		},
		listSessions: async () => {
			const { SessionManager } = await import("@earendil-works/pi-coding-agent");
			return SessionManager.listAll();
		},
		openSession: async (file) => {
			const { SessionManager } = await import("@earendil-works/pi-coding-agent");
			return SessionManager.open(file);
		},
		validateSession: validateSessionFileEvidence,
		resolveEndpoint: resolveMemberEndpoint,
		probe: (socketPath) => probeMemberEndpoint(socketPath),
	};
}

function failure(code: RoleSessionResumeFailureCode, message: string): RoleSessionFailure {
	return { ok: false, code, message };
}

function resolutionFailure(code: RoleSessionResumeFailureCode, message: string): RoleSessionResolutionResult {
	return { ok: false, code, message };
}

async function currentManifest(
	projectRoot: string,
	deps: RoleSessionResumeDependencies,
): Promise<{ readonly path: string; readonly manifest: CrewManifest } | RoleSessionFailure> {
	const paths = getTrustedCrewManifestPaths(projectRoot);
	const existing: string[] = [];
	for (const candidate of paths) if (await deps.manifestExists(candidate)) existing.push(candidate);
	if (existing.length === 0)
		return failure("missing-manifest", "no supported Crew manifest found in the current project");
	if (existing.length > 1)
		return failure("ambiguous-manifest", "both supported Crew manifests exist; remove one before resuming");
	try {
		return {
			path: path.resolve(existing[0]!),
			manifest: await deps.readManifest(existing[0]!, projectRoot, () => true),
		};
	} catch (error) {
		return failure("untrusted-project", error instanceof Error ? error.message : "Crew manifest is not trusted");
	}
}

function selectMember(manifest: CrewManifest, role: string): RoleSessionMember | RoleSessionFailure {
	const selection = selectCrewMemberByRole(manifest, role);
	if (selection.kind === "match") {
		return { name: selection.member.name, role: selection.member.role, socketPath: selection.member.socketPath };
	}
	if (selection.kind === "empty-role") return failure("empty-role", "role must be non-empty");
	if (selection.kind === "ambiguous-role") return failure("ambiguous-role", `role '${selection.role}' is ambiguous`);
	return failure(
		"unknown-role",
		`role '${selection.role}' is unknown; available roles: ${selection.availableRoles.join(", ")}`,
	);
}

function isAttributed(
	state: PersistedMembershipState | null,
	expected: {
		readonly manifestPath: string;
		readonly fingerprint: string;
		readonly member: RoleSessionMember;
	},
): boolean {
	return (
		state?.active === true &&
		state.snapshotVersion === MEMBERSHIP_SNAPSHOT_VERSION &&
		state.memberName === expected.member.name &&
		state.memberRole === expected.member.role &&
		path.resolve(state.manifestPath ?? "") === path.resolve(expected.manifestPath) &&
		state.manifestFingerprint === expected.fingerprint
	);
}

function candidateFromSession(info: SessionInfoLike, manager: SessionManager): RoleSessionCandidate | undefined {
	const header = manager.getHeader();
	const file = manager.getSessionFile();
	const cwd = manager.getCwd();
	const root = manager.getSessionDir();
	if (!header || header.id !== info.id || !file || !cwd || !root) return undefined;
	if (path.resolve(header.cwd) !== path.resolve(cwd)) return undefined;
	if (info.cwd && path.resolve(info.cwd) !== path.resolve(cwd)) return undefined;
	return {
		sessionId: header.id,
		sessionFile: path.resolve(file),
		cwd: path.resolve(cwd),
		root: path.resolve(root),
		...(info.name === undefined ? {} : { name: info.name }),
		modified: info.modified.toISOString(),
	};
}

async function inspectSession(
	info: SessionInfoLike,
	expected: { readonly manifestPath: string; readonly fingerprint: string; readonly member: RoleSessionMember },
	deps: RoleSessionResumeDependencies,
): Promise<{ readonly candidate?: RoleSessionCandidate; readonly reason?: RoleSessionResumeFailureCode }> {
	let manager: SessionManager;
	try {
		manager = await deps.openSession(info.path);
	} catch {
		return { reason: "malformed-session" };
	}
	let attribution: PersistedMembershipState | null;
	let candidate: RoleSessionCandidate | undefined;
	try {
		attribution = getLatestMembershipState(manager.getBranch());
		candidate = candidateFromSession(info, manager);
	} catch {
		return { reason: "malformed-session" };
	}
	if (!isAttributed(attribution, expected))
		return { reason: attribution?.active === true ? "membership-drift" : "inactive-membership" };
	if (!candidate) return { reason: "session-id-mismatch" };
	try {
		await deps.validateSession({
			id: candidate.sessionId,
			file: candidate.sessionFile,
			cwd: candidate.cwd,
			root: candidate.root,
		});
	} catch (error) {
		const code = (error as { code?: RoleSessionResumeFailureCode }).code;
		return { reason: code ?? "malformed-session" };
	}
	try {
		const endpoint = await deps.resolveEndpoint(expected.member.socketPath);
		if (await deps.probe(endpoint)) return { reason: "already-online" };
	} catch {
		return { reason: "malformed-session" };
	}
	return { candidate };
}

async function resolveExpected(
	projectRoot: string,
	role: string,
	deps: RoleSessionResumeDependencies,
): Promise<
	| { readonly manifestPath: string; readonly fingerprint: string; readonly member: RoleSessionMember }
	| RoleSessionFailure
> {
	const selected = await currentManifest(projectRoot, deps);
	if ("code" in selected) return selected;
	const member = selectMember(selected.manifest, role);
	if ("code" in member) return member;
	return {
		manifestPath: selected.path,
		fingerprint: manifestFingerprint(selected.manifest),
		member,
	};
}

export async function discoverRoleSessionCandidates(
	request: { readonly projectRoot: string; readonly role: string },
	dependencies: Partial<RoleSessionResumeDependencies> = {},
): Promise<RoleSessionDiscoveryResult> {
	const deps = { ...defaultDependencies(), ...dependencies };
	const expected = await resolveExpected(path.resolve(request.projectRoot), request.role, deps);
	if ("code" in expected) return expected;
	let sessions: readonly SessionInfoLike[];
	try {
		sessions = await deps.listSessions();
	} catch (error) {
		return failure(
			"session-scan-failed",
			error instanceof Error ? error.message : "Pi sessions could not be listed",
		);
	}
	const inspected = await Promise.all(sessions.map((info) => inspectSession(info, expected, deps)));
	const candidates = inspected.flatMap((item) => (item.candidate ? [item.candidate] : []));
	candidates.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
	return {
		ok: true,
		member: expected.member,
		candidates,
		skipped: inspected.length - candidates.length,
	};
}

export async function resolveRoleSessionCandidate(
	request: {
		readonly projectRoot: string;
		readonly role: string;
		readonly candidate: RoleSessionCandidate;
	},
	dependencies: Partial<RoleSessionResumeDependencies> = {},
): Promise<RoleSessionResolutionResult> {
	const deps = { ...defaultDependencies(), ...dependencies };
	const expected = await resolveExpected(path.resolve(request.projectRoot), request.role, deps);
	if ("code" in expected) return expected;
	const info: SessionInfoLike = {
		id: request.candidate.sessionId,
		path: request.candidate.sessionFile,
		cwd: request.candidate.cwd,
		name: request.candidate.name,
		modified: new Date(request.candidate.modified),
	};
	const inspected = await inspectSession(info, expected, deps);
	if (!inspected.candidate) {
		return resolutionFailure(
			inspected.reason ?? "malformed-session",
			"The selected Pi Session is no longer resumable",
		);
	}
	return { ok: true, candidate: inspected.candidate };
}
