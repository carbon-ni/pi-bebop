import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { CrewSessionMember, CrewSessionRecord } from "../domain/index.ts";
import { createCrewSessionStore, manifestFingerprint } from "../infra/crew-session-store.ts";
import type { CrewSessionStore, CrewSessionStoreEntry } from "../infra/crew-session-store.ts";
import { isTrustedCrewManifestPath, readTrustedCrewManifestMetadata } from "../infra/crew-manifest-store.ts";
import { validateSessionFileEvidence, type SessionFileValidationCode } from "../infra/session-file-security.ts";

export const DEFAULT_CREW_SESSION_LIST_LIMIT = 25;
export const MAX_CREW_SESSION_LIST_LIMIT = 100;

export type CrewSessionObservationReason =
	| "manifest-drift"
	| "manifest-missing"
	| "member-removed"
	| "member-role-drift"
	| "endpoint-drift"
	| "invalid-record"
	| "missing-session-file"
	| "cwd-missing"
	| SessionFileValidationCode;

export interface CrewSessionListItem {
	readonly id: string;
	readonly name: string;
	readonly crew: { readonly selector?: string; readonly displayName?: string };
	readonly createdAt: string;
	readonly capturedCount: number;
	readonly expectedCount: number;
	readonly status: "complete" | "partial" | "stale" | "invalid";
	readonly reason?: CrewSessionObservationReason;
}

export interface CrewSessionListRequest {
	readonly projectRoot: string;
	readonly crewLocator?: string;
	readonly limit?: number;
	readonly offset?: number;
}

export interface CrewSessionListResult {
	readonly sessions: readonly CrewSessionListItem[];
	readonly total: number;
	readonly returned: number;
	readonly omitted: number;
	readonly truncated: boolean;
}

export interface CrewSessionMemberInspection {
	readonly name: string;
	readonly role: string;
	readonly status: CrewSessionMember["status"];
	readonly reason?: string;
	readonly piSessionId?: string;
	readonly persistedSessionFile?: string;
	readonly sessionCwd?: string;
	readonly sessionRoot?: string;
	readonly sessionFileAvailable?: boolean;
	readonly cwdAvailable?: boolean;
	readonly activeProcess: "unknown";
}

export interface CrewSessionShowResult {
	readonly id: string;
	readonly name: string;
	readonly crew: CrewSessionRecord["crew"];
	readonly createdAt: string;
	readonly state: "complete" | "partial" | "stale" | "invalid";
	readonly reason?: CrewSessionObservationReason;
	readonly members: readonly CrewSessionMemberInspection[];
}

export interface CrewSessionInspectionDependencies {
	readonly store: CrewSessionStore;
	readonly readManifest: typeof readTrustedCrewManifestMetadata;
	readonly validateSession: typeof validateSessionFileEvidence;
	readonly access: (target: string) => Promise<void>;
}

function defaultDependencies(): CrewSessionInspectionDependencies {
	return {
		store: createCrewSessionStore(),
		readManifest: readTrustedCrewManifestMetadata,
		validateSession: validateSessionFileEvidence,
		access: async (target) => {
			await fs.access(target);
		},
	};
}

function boundedLimit(limit: number | undefined): number {
	if (limit === undefined) return DEFAULT_CREW_SESSION_LIST_LIMIT;
	if (!Number.isInteger(limit) || limit < 1) return DEFAULT_CREW_SESSION_LIST_LIMIT;
	return Math.min(limit, MAX_CREW_SESSION_LIST_LIMIT);
}

function boundedOffset(offset: number | undefined): number {
	return offset !== undefined && Number.isInteger(offset) && offset >= 0 ? offset : 0;
}

function invalidItem(entry: Extract<CrewSessionStoreEntry, { invalid: true }>): CrewSessionListItem {
	return {
		id: entry.id,
		name: "",
		crew: {},
		createdAt: "",
		capturedCount: 0,
		expectedCount: 0,
		status: "invalid",
		reason: entry.code === "storage-untrusted" ? "untrusted-session-root" : "invalid-record",
	};
}

function capturedCount(record: CrewSessionRecord): number {
	return record.members.filter((member) => member.status === "captured").length;
}

function errorReason(error: unknown): CrewSessionObservationReason {
	const code = (error as { code?: string }).code;
	if (
		code === "missing-session-file" ||
		code === "malformed-session" ||
		code === "untrusted-session-root" ||
		code === "session-id-mismatch" ||
		code === "session-cwd-mismatch"
	)
		return code;
	return "missing-session-file";
}

async function manifestReason(
	record: CrewSessionRecord,
	projectRoot: string,
	deps: CrewSessionInspectionDependencies,
): Promise<CrewSessionObservationReason | undefined> {
	if (!isTrustedCrewManifestPath(record.crew.locator, projectRoot)) return "manifest-drift";
	try {
		const manifest = await deps.readManifest(record.crew.locator, projectRoot, () => true);
		if (manifestFingerprint(manifest) === record.crew.manifestFingerprint) return undefined;
		const names = new Set(manifest.members.map((member) => member.name));
		if (record.members.some((member) => !names.has(member.name))) return "member-removed";
		const roleDrift = record.members.some((member) => {
			const current = manifest.members.find((candidate) => candidate.name === member.name);
			return current !== undefined && current.role !== member.role;
		});
		if (roleDrift) return "member-role-drift";
		return "endpoint-drift";
	} catch {
		return "manifest-missing";
	}
}

async function inspectMember(
	member: CrewSessionMember,
	manifestReasonValue: CrewSessionObservationReason | undefined,
	deps: CrewSessionInspectionDependencies,
): Promise<CrewSessionMemberInspection> {
	if (member.status === "missing")
		return {
			name: member.name,
			role: member.role,
			status: "missing",
			reason: member.reason,
			activeProcess: "unknown",
		};
	const base = {
		name: member.name,
		role: member.role,
		status: "captured" as const,
		piSessionId: member.piSessionId,
		persistedSessionFile: member.persistedSessionFile,
		sessionCwd: member.sessionCwd,
		sessionRoot: member.sessionRoot,
		activeProcess: "unknown" as const,
	};
	if (manifestReasonValue !== undefined) return { ...base, reason: manifestReasonValue };
	try {
		await deps.access(member.sessionCwd);
	} catch {
		return { ...base, cwdAvailable: false, sessionFileAvailable: false, reason: "cwd-missing" };
	}
	try {
		await deps.access(member.persistedSessionFile);
	} catch {
		return { ...base, cwdAvailable: true, sessionFileAvailable: false, reason: "missing-session-file" };
	}
	try {
		await deps.validateSession({
			id: member.piSessionId,
			file: member.persistedSessionFile,
			cwd: member.sessionCwd,
			root: member.sessionRoot,
		});
	} catch (error) {
		return {
			...base,
			cwdAvailable: true,
			sessionFileAvailable: true,
			reason: errorReason(error),
		};
	}
	return { ...base, cwdAvailable: true, sessionFileAvailable: true };
}

export async function listCrewSessions(
	request: CrewSessionListRequest,
	dependencies: Partial<CrewSessionInspectionDependencies> = {},
): Promise<CrewSessionListResult> {
	const deps = { ...defaultDependencies(), ...dependencies };
	if (request.crewLocator !== undefined && !isTrustedCrewManifestPath(request.crewLocator, request.projectRoot))
		throw new Error("Crew Locator is outside trusted project layout");
	const entries = await deps.store.listDetailed();
	const filtered = request.crewLocator
		? entries.filter(
				(entry) =>
					"invalid" in entry ||
					path.resolve(entry.record.crew.locator) === path.resolve(request.crewLocator!),
			)
		: entries;
	const observations = await Promise.all(
		filtered.map(async (entry): Promise<CrewSessionListItem> => {
			if ("invalid" in entry) return invalidItem(entry);
			const reason = await manifestReason(entry.record, request.projectRoot, deps);
			const memberReasons = await Promise.all(
				entry.record.members.map((member) => inspectMember(member, reason, deps)),
			);
			const firstReason = (reason ?? memberReasons.find((member) => member.reason)?.reason) as
				| CrewSessionObservationReason
				| undefined;
			const stale =
				firstReason !== undefined && entry.record.members.some((member) => member.status === "captured");
			return {
				id: entry.record.id,
				name: entry.record.name,
				crew: {
					...(entry.record.crew.selector === undefined ? {} : { selector: entry.record.crew.selector }),
					...(entry.record.crew.displayName === undefined
						? {}
						: { displayName: entry.record.crew.displayName }),
				},
				createdAt: entry.record.createdAt,
				capturedCount: capturedCount(entry.record),
				expectedCount: entry.record.members.length,
				status: stale ? "stale" : entry.record.state,
				...(firstReason === undefined ? {} : { reason: firstReason }),
			};
		}),
	);
	const offset = boundedOffset(request.offset);
	const limit = boundedLimit(request.limit);
	const sessions = observations.slice(offset, offset + limit);
	return {
		sessions,
		total: observations.length,
		returned: sessions.length,
		omitted: Math.max(0, observations.length - offset - sessions.length) + offset,
		truncated: offset + sessions.length < observations.length,
	};
}

export async function showCrewSession(
	id: string,
	request: { readonly projectRoot: string },
	dependencies: Partial<CrewSessionInspectionDependencies> = {},
): Promise<CrewSessionShowResult> {
	const deps = { ...defaultDependencies(), ...dependencies };
	const entries = await deps.store.listDetailed();
	const entry = entries.find((candidate) => candidate.id === id);
	if (!entry) throw new Error("Crew Session record was not found");
	if ("invalid" in entry)
		return {
			id,
			name: "",
			crew: { locator: "", manifestFingerprint: "" },
			createdAt: "",
			state: "invalid",
			reason: "invalid-record",
			members: [],
		};
	const reason = await manifestReason(entry.record, request.projectRoot, deps);
	const members = await Promise.all(entry.record.members.map((member) => inspectMember(member, reason, deps)));
	const memberReason = members.find((member) => member.reason)?.reason as CrewSessionObservationReason | undefined;
	return {
		id: entry.record.id,
		name: entry.record.name,
		crew: entry.record.crew,
		createdAt: entry.record.createdAt,
		state: reason || memberReason ? "stale" : entry.record.state,
		...((reason ?? memberReason) ? { reason: reason ?? memberReason } : {}),
		members,
	};
}
