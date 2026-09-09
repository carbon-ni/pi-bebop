import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type {
	CrewManifest,
	CrewMember,
	CrewSessionMember,
	CrewSessionRecord,
	CapturedCrewSessionMember,
} from "../domain/index.ts";
import { crewSessionState, memberSessionIdentity } from "../domain/index.ts";
import {
	createCrewSessionStore,
	manifestFingerprint,
	type CrewSessionStore,
	CrewSessionStoreError,
} from "../infra/crew-session-store.ts";
import { readTrustedCrewManifest } from "../infra/crew-manifest-store.ts";
import { resolveMemberEndpoint } from "../infra/socket-endpoint.ts";
import { sendRpcCommand } from "../infra/rpc-client.ts";
import { validateSessionFileEvidence, type SessionFileEvidence } from "../infra/session-file-security.ts";
import type { SessionCaptureResult } from "../domain/protocol/protocol-types.ts";

export const CAPTURE_MEMBER_TIMEOUT_MS = 3_000;
export const CAPTURE_TOTAL_TIMEOUT_MS = 10_000;
const MAX_COLLISION_IDS = 20;

export type CrewSessionCaptureFailureCode =
	| "capture-empty"
	| "name-collision"
	| "manifest-drift"
	| "member-not-configured"
	| "member-already-bound"
	| "not-joined"
	| "offline"
	| "unavailable"
	| "unpersisted-session"
	| "malformed-session"
	| "wrong-crew"
	| "wrong-member"
	| "untrusted-session-root"
	| "missing-session-file"
	| "capture-timeout"
	| "capture-aborted"
	| "storage-busy"
	| "storage-failed"
	| "invalid-record"
	| "record-not-found";

export type CaptureMemberResult =
	| { readonly ok: true; readonly member: CapturedCrewSessionMember }
	| { readonly ok: false; readonly reason: CrewSessionCaptureFailureCode };

export type CrewSessionCaptureOutcome =
	| {
			readonly ok: true;
			readonly record: CrewSessionRecord;
			readonly capturedCount: number;
			readonly missing: readonly { name: string; reason: CrewSessionCaptureFailureCode }[];
	  }
	| {
			readonly ok: false;
			readonly code: CrewSessionCaptureFailureCode;
			readonly message: string;
			readonly candidateIds?: readonly string[];
	  };

export interface CrewSessionCaptureDependencies {
	readonly readManifest: (manifestPath: string, projectRoot: string) => Promise<CrewManifest>;
	readonly store: CrewSessionStore;
	readonly resolveEndpoint: typeof resolveMemberEndpoint;
	readonly sendCapture: typeof sendRpcCommand;
	readonly validateSession: (evidence: SessionFileEvidence) => Promise<void>;
	readonly now: () => Date;
	readonly createId: () => string;
}

export interface CrewSessionCaptureRequest {
	readonly name: string;
	readonly manifestPath: string;
	readonly projectRoot: string;
	readonly signal?: AbortSignal;
}

export interface CrewSessionAddRequest {
	readonly id: string;
	readonly memberName: string;
	readonly manifestPath: string;
	readonly projectRoot: string;
	readonly signal?: AbortSignal;
}

function defaultDependencies(): CrewSessionCaptureDependencies {
	return {
		readManifest: (manifestPath, projectRoot) => readTrustedCrewManifest(manifestPath, projectRoot, () => true),
		store: createCrewSessionStore(),
		resolveEndpoint: resolveMemberEndpoint,
		sendCapture: sendRpcCommand,
		validateSession: validateSessionFileEvidence,
		now: () => new Date(),
		createId: () => `cs_${randomUUID()}`,
	};
}

function createCaptureWindow(parentSignal?: AbortSignal): {
	signal: AbortSignal;
	reason: () => "timeout" | "cancelled" | undefined;
	close: () => void;
} {
	const controller = new AbortController();
	let termination: "timeout" | "cancelled" | undefined;
	const onAbort = () => {
		termination = "cancelled";
		controller.abort(parentSignal?.reason);
	};
	if (parentSignal?.aborted) onAbort();
	else parentSignal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => {
		termination = "timeout";
		controller.abort(new Error("Crew Session capture timeout"));
	}, CAPTURE_TOTAL_TIMEOUT_MS);
	return {
		signal: controller.signal,
		reason: () => termination,
		close: () => {
			clearTimeout(timer);
			parentSignal?.removeEventListener("abort", onAbort);
		},
	};
}

function mapCaptureError(
	error: unknown,
	window: ReturnType<typeof createCaptureWindow>,
): CrewSessionCaptureFailureCode {
	const reason = window.reason();
	if (reason === "cancelled") return "capture-aborted";
	if (reason === "timeout") return "capture-timeout";
	if (error instanceof CrewSessionStoreError) return error.code as CrewSessionCaptureFailureCode;
	const code = (error as NodeJS.ErrnoException)?.code;
	if (code === "ENOENT" || code === "ECONNREFUSED" || code === "ENOTCONN") return "offline";
	if (error instanceof Error && /timeout/i.test(error.message)) return "capture-timeout";
	return "unavailable";
}

function mapRemoteError(error: unknown): CrewSessionCaptureFailureCode {
	const text = error instanceof Error ? error.message : String(error ?? "");
	if (/not-joined/i.test(text)) return "not-joined";
	if (/offline|ECONNREFUSED|ENOENT|ENOTCONN/i.test(text)) return "offline";
	if (/untrusted/i.test(text)) return "wrong-crew";
	if (/session-evidence/i.test(text)) return "unavailable";
	if (/timeout/i.test(text)) return "capture-timeout";
	if (/ENOENT|ECONNREFUSED|ENOTCONN/i.test(text)) return "offline";
	return "unavailable";
}

function validateName(name: string): void {
	if (name.trim().length === 0 || new TextEncoder().encode(name).byteLength > 256)
		throw new Error("Crew Session name must be non-empty and at most 256 UTF-8 bytes");
}

function expectedCrewMatches(manifest: CrewManifest, evidence: SessionCaptureResult, manifestPath: string): boolean {
	return (
		path.resolve(evidence.crewLocator) === path.resolve(manifestPath) &&
		(evidence.crew.id === undefined || evidence.crew.id === manifest.crew?.id) &&
		(evidence.crew.displayName === undefined || evidence.crew.displayName === manifest.crew?.displayName)
	);
}

async function captureMember(
	manifest: CrewManifest,
	manifestPath: string,
	member: CrewMember,
	window: ReturnType<typeof createCaptureWindow>,
	deps: CrewSessionCaptureDependencies,
): Promise<CaptureMemberResult> {
	if (window.signal.aborted) return { ok: false, reason: mapCaptureError(undefined, window) };
	try {
		const endpoint = await deps.resolveEndpoint(member.socketPath);
		const { response } = await deps.sendCapture(
			endpoint,
			{ type: "session_capture" },
			{
				timeout: CAPTURE_MEMBER_TIMEOUT_MS,
				signal: window.signal,
			},
		);
		if (!response.success) return { ok: false, reason: mapRemoteError(response.error) };
		const evidence = response.data as SessionCaptureResult;
		if (!expectedCrewMatches(manifest, evidence, manifestPath)) return { ok: false, reason: "wrong-crew" };
		if (evidence.member.name !== member.name) return { ok: false, reason: "wrong-member" };
		if (evidence.member.role !== member.role) return { ok: false, reason: "wrong-member" };
		if (!evidence.session.persisted) return { ok: false, reason: "unpersisted-session" };
		if (evidence.session.file === undefined) return { ok: false, reason: "missing-session-file" };
		const evidencePaths: SessionFileEvidence = {
			id: evidence.session.id,
			file: evidence.session.file,
			cwd: evidence.session.cwd,
			root: evidence.session.root,
		};
		try {
			await deps.validateSession(evidencePaths);
		} catch (error) {
			const code = (error as { code?: CrewSessionCaptureFailureCode }).code;
			return { ok: false, reason: code ?? "malformed-session" };
		}
		return {
			ok: true,
			member: {
				...memberSessionIdentity(member),
				status: "captured",
				piSessionId: evidence.session.id,
				persistedSessionFile: evidence.session.file,
				sessionCwd: evidence.session.cwd,
				sessionRoot: evidence.session.root,
				capturedAt: deps.now().toISOString(),
			},
		};
	} catch (error) {
		return { ok: false, reason: mapCaptureError(error, window) };
	}
}

function missingReason(member: CrewMember, reason: CrewSessionCaptureFailureCode): CrewSessionMember {
	return { ...memberSessionIdentity(member), status: "missing", reason: reason as never };
}

function summaryFailure(
	code: CrewSessionCaptureFailureCode,
	message: string,
	candidateIds?: readonly string[],
): CrewSessionCaptureOutcome {
	return { ok: false, code, message, ...(candidateIds === undefined ? {} : { candidateIds }) };
}

export async function captureCrewSession(
	request: CrewSessionCaptureRequest,
	dependencies: Partial<CrewSessionCaptureDependencies> = {},
): Promise<CrewSessionCaptureOutcome> {
	const deps = { ...defaultDependencies(), ...dependencies };
	try {
		validateName(request.name);
	} catch (error) {
		return summaryFailure("invalid-record", error instanceof Error ? error.message : "invalid Crew Session name");
	}
	const window = createCaptureWindow(request.signal);
	try {
		const existing = await deps.store.list();
		const collisions = existing.filter((record) => record.name === request.name).map((record) => record.id);
		if (collisions.length > 0)
			return summaryFailure(
				"name-collision",
				"Crew Session name already exists; use an exact ID",
				collisions.slice(0, MAX_COLLISION_IDS),
			);
		const manifestPath = path.resolve(request.manifestPath);
		const manifest = await deps.readManifest(manifestPath, path.resolve(request.projectRoot));
		const results = await Promise.all(
			manifest.members.map((member) => captureMember(manifest, manifestPath, member, window, deps)),
		);
		const capturedCount = results.filter((result) => result.ok).length;
		if (capturedCount === 0)
			return summaryFailure(
				"capture-empty",
				"No configured Member produced a valid persisted Pi Session; no record was written",
			);
		const createdAt = deps.now().toISOString();
		const members = manifest.members.map((member, index) => {
			const result = results[index]!;
			if ("member" in result) return result.member;
			return missingReason(member, result.reason);
		});
		const record: CrewSessionRecord = {
			schemaVersion: 1,
			id: deps.createId(),
			name: request.name,
			crew: {
				...(manifest.crew === undefined
					? {}
					: { selector: manifest.crew.id, displayName: manifest.crew.displayName }),
				locator: manifestPath,
				manifestFingerprint: manifestFingerprint(manifest),
			},
			createdAt,
			state: crewSessionState(members),
			members,
		};
		await deps.store.write(record);
		return {
			ok: true,
			record,
			capturedCount,
			missing: members
				.filter(
					(member): member is Extract<CrewSessionMember, { status: "missing" }> =>
						member.status === "missing",
				)
				.map((member) => ({ name: member.name, reason: member.reason })),
		};
	} catch (error) {
		return summaryFailure(
			mapCaptureError(error, window),
			error instanceof Error ? error.message : "Crew Session capture failed",
		);
	} finally {
		window.close();
	}
}

export async function addCrewSessionMember(
	request: CrewSessionAddRequest,
	dependencies: Partial<CrewSessionCaptureDependencies> = {},
): Promise<CrewSessionCaptureOutcome> {
	const deps = { ...defaultDependencies(), ...dependencies };
	const window = createCaptureWindow(request.signal);
	try {
		const manifestPath = path.resolve(request.manifestPath);
		const manifest = await deps.readManifest(manifestPath, path.resolve(request.projectRoot));
		const record = await deps.store.read(request.id);
		if (
			path.resolve(record.crew.locator) !== manifestPath ||
			record.crew.manifestFingerprint !== manifestFingerprint(manifest)
		)
			return summaryFailure("manifest-drift", "Crew Session belongs to a changed or different Crew manifest");
		const memberIndex = manifest.members.findIndex((member) => member.name === request.memberName);
		if (memberIndex === -1)
			return summaryFailure("member-not-configured", "Member is not configured in the selected Crew");
		const current = record.members[memberIndex];
		if (!current || current.name !== request.memberName)
			return summaryFailure("invalid-record", "Crew Session Member order does not match the manifest");
		if (current.status === "captured")
			return summaryFailure("member-already-bound", "Member already has a captured Pi Session binding");
		const result = await captureMember(manifest, manifestPath, manifest.members[memberIndex]!, window, deps);
		if ("reason" in result) return summaryFailure(result.reason, `Member capture failed: ${result.reason}`);
		const members = record.members.map((member, index) => (index === memberIndex ? result.member : member));
		const next: CrewSessionRecord = { ...record, state: crewSessionState(members), members };
		await deps.store.write(next, { overwrite: true });
		return {
			ok: true,
			record: next,
			capturedCount: members.filter((member) => member.status === "captured").length,
			missing: members
				.filter(
					(member): member is Extract<CrewSessionMember, { status: "missing" }> =>
						member.status === "missing",
				)
				.map((member) => ({ name: member.name, reason: member.reason })),
		};
	} catch (error) {
		return summaryFailure(
			mapCaptureError(error, window),
			error instanceof Error ? error.message : "Crew Session Member addition failed",
		);
	} finally {
		window.close();
	}
}
