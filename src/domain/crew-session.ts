import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { CrewManifest, CrewMember } from "./crew-manifest.ts";

export const CREW_SESSION_SCHEMA_VERSION = 1 as const;
export const CREW_SESSION_ID_PATTERN = /^cs_[A-Za-z0-9][A-Za-z0-9_-]{7,95}$/;
export const CREW_SESSION_NAME_MAX_BYTES = 256;

export const CrewSessionMissingReasonSchema = Type.Union([
	Type.Literal("offline"),
	Type.Literal("unavailable"),
	Type.Literal("unpersisted-session"),
	Type.Literal("malformed-session"),
	Type.Literal("wrong-crew"),
	Type.Literal("wrong-member"),
	Type.Literal("untrusted-session-root"),
	Type.Literal("missing-session-file"),
	Type.Literal("capture-timeout"),
	Type.Literal("capture-aborted"),
]);
export type CrewSessionMissingReason = Static<typeof CrewSessionMissingReasonSchema>;

const CrewSessionCrewSchema = Type.Object(
	{
		selector: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
		displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
		locator: Type.String({ minLength: 1, maxLength: 4096 }),
		manifestFingerprint: Type.String({ minLength: 1, maxLength: 256 }),
	},
	{ additionalProperties: false },
);
const CapturedMemberSessionSchema = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: 128 }),
		role: Type.String({ minLength: 1, maxLength: 128 }),
		status: Type.Literal("captured"),
		piSessionId: Type.String({ minLength: 1, maxLength: 256 }),
		persistedSessionFile: Type.String({ minLength: 1, maxLength: 4096 }),
		sessionCwd: Type.String({ minLength: 1, maxLength: 4096 }),
		sessionRoot: Type.String({ minLength: 1, maxLength: 4096 }),
		capturedAt: Type.String({ minLength: 1, maxLength: 64 }),
	},
	{ additionalProperties: false },
);
const MissingMemberSessionSchema = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: 128 }),
		role: Type.String({ minLength: 1, maxLength: 128 }),
		status: Type.Literal("missing"),
		reason: CrewSessionMissingReasonSchema,
	},
	{ additionalProperties: false },
);
export const CrewSessionMemberSchema = Type.Union([CapturedMemberSessionSchema, MissingMemberSessionSchema]);
export const CrewSessionRecordSchema = Type.Object(
	{
		schemaVersion: Type.Literal(CREW_SESSION_SCHEMA_VERSION),
		id: Type.String({ pattern: CREW_SESSION_ID_PATTERN.source, maxLength: 100 }),
		name: Type.String({ minLength: 1, maxLength: CREW_SESSION_NAME_MAX_BYTES }),
		crew: CrewSessionCrewSchema,
		createdAt: Type.String({ minLength: 1, maxLength: 64 }),
		state: Type.Union([Type.Literal("complete"), Type.Literal("partial")]),
		members: Type.Array(CrewSessionMemberSchema, { minItems: 1, maxItems: 128 }),
	},
	{ additionalProperties: false },
);
export type CrewSessionRecord = Static<typeof CrewSessionRecordSchema>;
export type CrewSessionMember = Static<typeof CrewSessionMemberSchema>;
export type CapturedCrewSessionMember = Static<typeof CapturedMemberSessionSchema>;
export type MissingCrewSessionMember = Static<typeof MissingMemberSessionSchema>;
export type CrewSessionCrew = Static<typeof CrewSessionCrewSchema>;

export function isCrewSessionRecord(value: unknown): value is CrewSessionRecord {
	return Value.Check(CrewSessionRecordSchema, value);
}

export function crewSessionState(members: readonly CrewSessionMember[]): "complete" | "partial" {
	return members.every((member) => member.status === "captured") ? "complete" : "partial";
}

/** Stable, non-secret input for the versioned manifest fingerprint. */
export function manifestFingerprintInput(manifest: CrewManifest): Record<string, unknown> {
	return {
		version: manifest.version,
		crew: manifest.crew ? { id: manifest.crew.id, displayName: manifest.crew.displayName } : undefined,
		members: manifest.members.map((member) => ({
			name: member.name,
			role: member.role,
			socket: member.socket,
		})),
		presence: manifest.presence,
		intake: manifest.intake,
		guestAdmission: manifest.guestAdmission,
	};
}

export function memberSessionIdentity(member: CrewMember): Pick<CrewSessionMember, "name" | "role"> {
	return { name: member.name, role: member.role };
}
