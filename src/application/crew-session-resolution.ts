import * as path from "node:path";
import {
	getLatestMembershipState,
	type CrewManifest,
	type CrewSessionMember,
	type CrewSessionRecord,
} from "../domain/index.ts";

export type CrewSessionResolutionFailureCode =
	| "record-not-found"
	| "invalid-record"
	| "untrusted-project"
	| "manifest-missing"
	| "manifest-drift"
	| "member-not-configured"
	| "member-ambiguous"
	| "member-role-drift"
	| "member-not-captured"
	| "membership-inactive"
	| "membership-drift"
	| "missing-session-file"
	| "session-file-moved"
	| "ambiguous-session-file"
	| "cwd-missing"
	| "already-open"
	| "malformed-session"
	| "untrusted-session-root"
	| "session-id-mismatch"
	| "session-cwd-mismatch"
	| "operational";

export interface CrewSessionStartupSpecification {
	readonly argv: readonly ["pi", "--session", string];
	readonly cwd: string;
	readonly sessionId: string;
	readonly sessionFile: string;
	readonly processState: "unreachable";
	readonly warning: string;
}

export interface CrewSessionResolutionSuccess {
	readonly ok: true;
	readonly crewSessionId: string;
	readonly member: { readonly name: string; readonly role: string };
	readonly startup: CrewSessionStartupSpecification;
}

export interface CrewSessionResolutionFailure {
	readonly ok: false;
	readonly code: CrewSessionResolutionFailureCode;
	readonly message: string;
	readonly recovery: string;
}

export type CrewSessionResolutionResult = CrewSessionResolutionSuccess | CrewSessionResolutionFailure;

export type CrewSessionResolutionStoreEntry =
	| { readonly id: string; readonly record: CrewSessionRecord }
	| { readonly id: string; readonly invalid: true };

export interface CrewSessionResolutionEvidence {
	readonly id: string;
	readonly root: string;
	readonly membership: readonly unknown[];
}

export interface CrewSessionResolutionDependencies {
	readonly store: { readonly listDetailed: () => Promise<readonly CrewSessionResolutionStoreEntry[]> };
	readonly isTrustedManifestPath: (manifestPath: string, projectRoot: string) => boolean;
	readonly manifestFingerprint: (manifest: CrewManifest) => string;
	readonly readManifest: (
		manifestPath: string,
		projectRoot: string,
		isProjectTrusted: () => boolean,
	) => Promise<CrewManifest>;
	readonly validateSession: (evidence: {
		readonly id: string;
		readonly file: string;
		readonly cwd: string;
		readonly root: string;
	}) => Promise<void>;
	readonly access: (target: string) => Promise<void>;
	readonly resolveEndpoint: (socketPath: string) => Promise<string>;
	readonly probe: (endpoint: string) => Promise<boolean>;
	readonly readSessionEvidence: (file: string, root: string) => Promise<CrewSessionResolutionEvidence>;
	readonly readDirectory: (directory: string) => Promise<readonly string[]>;
}

function failure(
	code: CrewSessionResolutionFailureCode,
	message: string,
	recovery: string,
): CrewSessionResolutionFailure {
	return { ok: false, code, message, recovery };
}

function validationCode(error: unknown): CrewSessionResolutionFailureCode {
	const code = (error as { code?: string }).code;
	if (
		code === "missing-session-file" ||
		code === "malformed-session" ||
		code === "untrusted-session-root" ||
		code === "session-id-mismatch" ||
		code === "session-cwd-mismatch"
	)
		return code;
	return "malformed-session";
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function recoverMovedSessionFile(
	root: string,
	id: string,
	deps: CrewSessionResolutionDependencies,
): Promise<"none" | "ambiguous" | "one"> {
	let files: readonly string[];
	try {
		files = await deps.readDirectory(root);
	} catch {
		return "none";
	}
	let matches = 0;
	for (const file of files) {
		try {
			const evidence = await deps.readSessionEvidence(file, root);
			if (evidence.id === id) matches += 1;
		} catch {
			/* Unsupported or unrelated files are not recovery candidates. */
		}
	}
	return matches > 1 ? "ambiguous" : matches === 1 ? "one" : "none";
}

async function resolveRecord(
	id: string,
	deps: CrewSessionResolutionDependencies,
): Promise<Extract<CrewSessionResolutionStoreEntry, { record: CrewSessionRecord }> | CrewSessionResolutionFailure> {
	const entries = await deps.store.listDetailed();
	const entry = entries.find((candidate) => candidate.id === id);
	if (!entry)
		return failure(
			"record-not-found",
			"Crew Session record was not found",
			"Run `bebop session list` and choose an exact ID.",
		);
	if ("invalid" in entry)
		return failure(
			"invalid-record",
			"Crew Session record is invalid",
			"Capture a new Crew Session; the invalid record was not changed.",
		);
	return entry;
}

export async function resolveCrewSessionMember(
	request: { readonly projectRoot: string; readonly id: string; readonly memberName: string },
	deps: CrewSessionResolutionDependencies,
): Promise<CrewSessionResolutionResult> {
	const entry = await resolveRecord(request.id, deps);
	if (!("record" in entry)) return entry;
	if (entry.id !== entry.record.id)
		return failure(
			"invalid-record",
			"Crew Session filename and record ID do not match",
			"Capture a new Crew Session; the invalid record was not changed.",
		);
	const record = entry.record;
	const projectRoot = path.resolve(request.projectRoot);
	if (!deps.isTrustedManifestPath(record.crew.locator, projectRoot))
		return failure(
			"untrusted-project",
			"Crew Locator is outside the trusted current project",
			"Run the command from the captured trusted project.",
		);
	let manifest;
	try {
		manifest = await deps.readManifest(record.crew.locator, projectRoot, () => true);
	} catch {
		return failure(
			"manifest-missing",
			"The captured Crew manifest is unavailable",
			"Restore the trusted manifest or capture a new Crew Session.",
		);
	}
	if (deps.manifestFingerprint(manifest) !== record.crew.manifestFingerprint)
		return failure(
			"manifest-drift",
			"The Crew manifest changed since capture",
			"Review the manifest and capture a new Crew Session.",
		);
	const configuredMembers = manifest.members.filter((member) => member.name === request.memberName);
	if (configuredMembers.length === 0)
		return failure(
			"member-not-configured",
			`Member '${request.memberName}' is not configured in this Crew`,
			"Use an exact configured Member name.",
		);
	if (configuredMembers.length > 1)
		return failure(
			"member-ambiguous",
			`Member '${request.memberName}' is ambiguous in this Crew manifest`,
			"Do not guess; repair the manifest and capture a new Crew Session.",
		);
	const configured = configuredMembers[0]!;
	const stored = record.members.find((member) => member.name === request.memberName);
	if (!stored || stored.role !== configured.role)
		return failure(
			"member-role-drift",
			"The stored Member identity no longer matches the manifest",
			"Review the manifest and capture a new Crew Session.",
		);
	if (stored.status !== "captured")
		return failure(
			"member-not-captured",
			"This Member has no captured Pi Session binding",
			"Capture or add this exact Member before resolving it.",
		);
	const member = stored as Extract<CrewSessionMember, { status: "captured" }>;
	try {
		await deps.access(member.sessionCwd);
	} catch {
		return failure(
			"cwd-missing",
			"The stored session working directory is unavailable",
			"Restore the working directory or capture a new Crew Session.",
		);
	}
	try {
		await deps.access(member.persistedSessionFile);
	} catch {
		const recovery = await recoverMovedSessionFile(member.sessionRoot, member.piSessionId, deps);
		if (recovery === "ambiguous")
			return failure(
				"ambiguous-session-file",
				"Multiple supported session files match the stored Session ID",
				"Do not guess; repair the record explicitly or capture a new Crew Session.",
			);
		if (recovery === "one")
			return failure(
				"session-file-moved",
				"The stored session file moved within its trusted root",
				"Repair the Crew Session record explicitly before resolving it.",
			);
		return failure(
			"missing-session-file",
			"The stored Pi Session file is unavailable",
			"Restore the exact session file or capture a new Crew Session.",
		);
	}
	try {
		await deps.validateSession({
			id: member.piSessionId,
			file: member.persistedSessionFile,
			cwd: member.sessionCwd,
			root: member.sessionRoot,
		});
	} catch (error) {
		const code = validationCode(error);
		return failure(
			code,
			`The stored Pi Session failed ${code.replaceAll("-", " ")} validation`,
			"Restore the exact session or capture a new Crew Session.",
		);
	}
	let evidence: CrewSessionResolutionEvidence;
	try {
		evidence = await deps.readSessionEvidence(member.persistedSessionFile, member.sessionRoot);
	} catch {
		return failure(
			"malformed-session",
			"The stored Pi Session is not supported by Pi",
			"Restore the exact session or capture a new Crew Session.",
		);
	}
	if (evidence.id !== member.piSessionId)
		return failure(
			"session-id-mismatch",
			"The stored Pi Session ID does not match its supported header",
			"Do not guess a replacement session; capture a new Crew Session.",
		);
	if (path.resolve(evidence.root) !== path.resolve(member.sessionRoot))
		return failure(
			"untrusted-session-root",
			"Pi reported a different SessionManager root",
			"Use the reported trusted root or capture a new Crew Session.",
		);
	const persisted = getLatestMembershipState(evidence.membership);
	if (!persisted?.active)
		return failure(
			"membership-inactive",
			"The stored Pi Session has no active Crew membership",
			"Start the exact session manually, then join the intended Crew explicitly.",
		);
	if (
		path.resolve(persisted.manifestPath ?? "") !== path.resolve(record.crew.locator) ||
		path.resolve(persisted.socketPath) !== path.resolve(configured.socketPath)
	)
		return failure(
			"membership-drift",
			"The stored Pi membership does not match this Crew Member binding",
			"Do not resume this binding; capture a new Crew Session.",
		);
	const endpoint = await deps.resolveEndpoint(configured.socketPath);
	if (await deps.probe(endpoint))
		return failure(
			"already-open",
			"This Member endpoint is already open; opening the same JSONL in two writers is unsafe",
			"Close the existing Member Pi session before resolving this binding.",
		);
	const argv = ["pi", "--session", path.resolve(member.persistedSessionFile)] as const;
	return {
		ok: true,
		crewSessionId: record.id,
		member: { name: configured.name, role: configured.role },
		startup: {
			argv,
			cwd: path.resolve(member.sessionCwd),
			sessionId: member.piSessionId,
			sessionFile: path.resolve(member.persistedSessionFile),
			processState: "unreachable",
			warning: "Endpoint is currently unreachable; this observation is not a lock or a race-free guarantee.",
		},
	};
}

export function resolutionCommand(result: CrewSessionResolutionSuccess): string {
	return `${result.startup.argv.map(shellQuote).join(" ")}`;
}
