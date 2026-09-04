import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { CrewIdentityConfig, CrewManifest, GuestAdmissionConfig } from "./crew-manifest.ts";

/**
 * TASK-0160: Guest is an external Pi session explicitly admitted to one exact
 * crew. This module defines the pure contract only; socket admission,
 * persistence, and lifecycle belong to TASK-0161.
 */

export const MAX_GUEST_IDENTITY_BYTES = 256;
export const MAX_GUEST_NAME_BYTES = 256;
export const MAX_GUEST_ENDPOINT_BYTES = 512;
export const MAX_GUEST_CAPABILITY_BYTES = 512;

/** Ordinary messaging only. This is a closed set, not negotiable capability input. */
export const GUEST_CAPABILITIES = ["follow-up", "member-request", "member-response", "broadcast"] as const;
export type GuestCapabilityName = (typeof GUEST_CAPABILITIES)[number];
export const GuestCapabilitySchema = Type.Union(GUEST_CAPABILITIES.map((capability) => Type.Literal(capability)));

export const GUEST_THREATS = [
	"guessed-or-stolen-socket",
	"replayed-approval",
	"capability-leakage",
	"stale-endpoint",
	"name-collision",
	"cross-crew-confusion",
	"unauthorized-approval-or-revocation",
	"compromised-crew",
] as const;
export type GuestThreat = (typeof GUEST_THREATS)[number];
export const GuestThreatSchema = Type.Union(GUEST_THREATS.map((threat) => Type.Literal(threat)));
export const GuestThreatModelSchema = Type.Object(
	{
		threats: Type.Array(GuestThreatSchema, {
			minItems: GUEST_THREATS.length,
			maxItems: GUEST_THREATS.length,
			uniqueItems: true,
		}),
	},
	{ additionalProperties: false },
);
export type GuestThreatModel = Static<typeof GuestThreatModelSchema>;

const BoundedText = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: "^[^\\u0000\\r\\n]+$" });
const isBoundedText = (value: unknown, maxBytes: number): value is string =>
	typeof value === "string" &&
	value.length > 0 &&
	value.trim() === value &&
	!value.includes("\0") &&
	!/[\r\n]/.test(value) &&
	Buffer.byteLength(value, "utf8") <= maxBytes;

/** One Pi session's stable identity and live callback endpoint. */
export const GuestSchema = Type.Object(
	{
		identity: BoundedText(MAX_GUEST_IDENTITY_BYTES),
		callbackEndpoint: BoundedText(MAX_GUEST_ENDPOINT_BYTES),
	},
	{ additionalProperties: false },
);
export type Guest = Static<typeof GuestSchema>;

/** Public selector shown to a Guest; it contains no manifest path or socket route. */
export const CrewSelectorSchema = Type.Object(
	{
		id: BoundedText(MAX_GUEST_IDENTITY_BYTES),
		displayName: BoundedText(MAX_GUEST_NAME_BYTES),
	},
	{ additionalProperties: false },
);
export type CrewSelector = Static<typeof CrewSelectorSchema>;

/** Stable identity and display metadata projected from a manifest. */
export function crewSelectorFromConfig(config: CrewIdentityConfig): CrewSelector {
	return { id: config.id, displayName: config.displayName };
}

export type CrewSelectorLookup =
	| { readonly kind: "match"; readonly crew: CrewSelector }
	| { readonly kind: "no-match"; readonly id: string }
	| { readonly kind: "ambiguous"; readonly displayName: string; readonly crews: readonly CrewSelector[] };

/**
 * Selects by stable identity, never by display name. Duplicate display names
 * are therefore harmless; a UI may show them but must retain the selector.
 */
export function selectCrewBySelector(crews: readonly CrewSelector[], id: string): CrewSelectorLookup {
	const matches = crews.filter((crew) => crew.id === id);
	if (matches.length === 0) return { kind: "no-match", id };
	if (matches.length > 1) {
		return {
			kind: "ambiguous",
			displayName: matches[0]!.displayName,
			crews: matches,
		};
	}
	return { kind: "match", crew: matches[0]! };
}

/** Exact configured Member names allowed to approve Guests. */
export type GuestAdmissionPolicy =
	| { readonly enabled: true; readonly approvers: readonly string[] }
	| { readonly enabled: false; readonly reason: "missing" }
	| { readonly enabled: false; readonly reason: "empty" };

export function guestAdmissionPolicy(config: GuestAdmissionConfig | undefined): GuestAdmissionPolicy {
	if (!config) return { enabled: false, reason: "missing" };
	if (config.approvers.length === 0) return { enabled: false, reason: "empty" };
	return { enabled: true, approvers: [...config.approvers] };
}

/** Guest names are unique within one crew across configured Members and Guests. */
export function isGuestNameAvailable(
	manifest: Pick<CrewManifest, "members">,
	approvedGuestNames: readonly string[],
	candidate: string,
): boolean {
	return !manifest.members.some((member) => member.name === candidate) && !approvedGuestNames.includes(candidate);
}

/** Fixed capabilities available to an approved Guest; privileged operations are excluded. */
export function isGuestCapability(value: string): value is GuestCapabilityName {
	return (GUEST_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * Opaque runtime-held approval capability. It is intentionally not part of any
 * model-facing message schema and must never be rendered or sent in content.
 */
export type GuestApprovalCapability = string & { readonly __guestApprovalCapability: unique symbol };

export function bindGuestApprovalCapability(value: string): GuestApprovalCapability {
	if (
		value.length === 0 ||
		value.trim() !== value ||
		value.includes("\0") ||
		Buffer.byteLength(value, "utf8") > MAX_GUEST_CAPABILITY_BYTES
	)
		throw new Error("invalid Guest approval capability");
	return value as GuestApprovalCapability;
}

/** Untrusted admission request received through one explicit live Member socket. */
export const GuestJoinRequestSchema = Type.Object(
	{
		requestId: BoundedText(MAX_GUEST_IDENTITY_BYTES),
		crew: CrewSelectorSchema,
		guestIdentity: BoundedText(MAX_GUEST_IDENTITY_BYTES),
		guestName: BoundedText(MAX_GUEST_NAME_BYTES),
		callbackEndpoint: BoundedText(MAX_GUEST_ENDPOINT_BYTES),
		submittedByMember: BoundedText(MAX_GUEST_NAME_BYTES),
	},
	{ additionalProperties: false },
);
export type GuestJoinRequest = Static<typeof GuestJoinRequestSchema>;

/** Crew-local approval; capability issuance remains runtime-owned and opaque. */
export const GuestApprovalSchema = Type.Object(
	{
		requestId: BoundedText(MAX_GUEST_IDENTITY_BYTES),
		crew: CrewSelectorSchema,
		guestIdentity: BoundedText(MAX_GUEST_IDENTITY_BYTES),
		guestName: BoundedText(MAX_GUEST_NAME_BYTES),
		callbackEndpoint: BoundedText(MAX_GUEST_ENDPOINT_BYTES),
		approver: BoundedText(MAX_GUEST_NAME_BYTES),
	},
	{ additionalProperties: false },
);
export type GuestApproval = Static<typeof GuestApprovalSchema>;

/** Crew-local revocation; it cannot address another Crew membership. */
export const GuestRevocationSchema = Type.Object(
	{
		crew: CrewSelectorSchema,
		guestIdentity: BoundedText(MAX_GUEST_IDENTITY_BYTES),
		revokedBy: BoundedText(MAX_GUEST_NAME_BYTES),
	},
	{ additionalProperties: false },
);
export type GuestRevocation = Static<typeof GuestRevocationSchema>;

function isValidSelector(selector: CrewSelector): boolean {
	return (
		isBoundedText(selector.id, MAX_GUEST_IDENTITY_BYTES) &&
		isBoundedText(selector.displayName, MAX_GUEST_NAME_BYTES)
	);
}

export function isGuestJoinRequest(value: unknown): value is GuestJoinRequest {
	if (!Value.Check(GuestJoinRequestSchema, value)) return false;
	const request = value as GuestJoinRequest;
	return (
		isValidSelector(request.crew) &&
		isBoundedText(request.requestId, MAX_GUEST_IDENTITY_BYTES) &&
		isBoundedText(request.guestIdentity, MAX_GUEST_IDENTITY_BYTES) &&
		isBoundedText(request.guestName, MAX_GUEST_NAME_BYTES) &&
		isBoundedText(request.callbackEndpoint, MAX_GUEST_ENDPOINT_BYTES) &&
		isBoundedText(request.submittedByMember, MAX_GUEST_NAME_BYTES)
	);
}

export function isGuestApproval(value: unknown): value is GuestApproval {
	if (!Value.Check(GuestApprovalSchema, value)) return false;
	const approval = value as GuestApproval;
	return (
		isValidSelector(approval.crew) &&
		isBoundedText(approval.requestId, MAX_GUEST_IDENTITY_BYTES) &&
		isBoundedText(approval.guestIdentity, MAX_GUEST_IDENTITY_BYTES) &&
		isBoundedText(approval.guestName, MAX_GUEST_NAME_BYTES) &&
		isBoundedText(approval.callbackEndpoint, MAX_GUEST_ENDPOINT_BYTES) &&
		isBoundedText(approval.approver, MAX_GUEST_NAME_BYTES)
	);
}

export function isGuestRevocation(value: unknown): value is GuestRevocation {
	if (!Value.Check(GuestRevocationSchema, value)) return false;
	const revocation = value as GuestRevocation;
	return (
		isValidSelector(revocation.crew) &&
		isBoundedText(revocation.guestIdentity, MAX_GUEST_IDENTITY_BYTES) &&
		isBoundedText(revocation.revokedBy, MAX_GUEST_NAME_BYTES)
	);
}

/** Internal binding checked by lifecycle code before every Guest operation. */
export interface GuestMembershipBinding {
	readonly crew: CrewSelector;
	readonly guestIdentity: string;
	readonly guestName: string;
	readonly callbackEndpoint: string;
	readonly approvedBy: string;
	readonly capability: GuestApprovalCapability;
}

/** Presence is an observation of an approved callback endpoint, never membership. */
export type GuestPresence = "online" | "offline";
export interface GuestRosterRow {
	readonly membership: GuestMembershipRecord;
	readonly presence: GuestPresence;
}

/**
 * Replaces only the membership for one exact Crew selector. Memberships for
 * other Crews remain untouched, which is the core multi-crew invariant.
 */
export function replaceGuestMembership(
	memberships: readonly GuestMembershipRecord[],
	replacement: GuestMembershipRecord,
): readonly GuestMembershipRecord[] {
	const index = memberships.findIndex((membership) => membership.crew.id === replacement.crew.id);
	if (index < 0) return [...memberships, replacement];
	return memberships.map((membership, candidate) => (candidate === index ? replacement : membership));
}

/** Removes only one exact Crew membership; leaving a Crew cannot release others. */
export function removeGuestMembership(
	memberships: readonly GuestMembershipRecord[],
	crewIdentity: string,
): readonly GuestMembershipRecord[] {
	return memberships.filter((membership) => membership.crew.id !== crewIdentity);
}

/** Fails closed when any restored identity, endpoint, approver, or Crew binding differs. */
export function bindingMatchesRecord(binding: GuestMembershipBinding, record: GuestMembershipRecord): boolean {
	return (
		binding.crew.id === record.crew.id &&
		binding.crew.displayName === record.crew.displayName &&
		binding.guestIdentity === record.guestIdentity &&
		binding.guestName === record.guestName &&
		binding.callbackEndpoint === record.callbackEndpoint &&
		binding.approvedBy === record.approvedBy
	);
}

/** Capability equality is checked separately because the capability is never persisted in a model-facing record. */
export function bindingMatchesCapability(binding: GuestMembershipBinding, expected: GuestApprovalCapability): boolean {
	return binding.capability === expected;
}

/** Persistable identity/endpoint binding; approval capability is runtime-only. */
export const GuestMembershipRecordSchema = Type.Object(
	{
		crew: CrewSelectorSchema,
		guestIdentity: BoundedText(MAX_GUEST_IDENTITY_BYTES),
		guestName: BoundedText(MAX_GUEST_NAME_BYTES),
		callbackEndpoint: BoundedText(MAX_GUEST_ENDPOINT_BYTES),
		approvedBy: BoundedText(MAX_GUEST_NAME_BYTES),
	},
	{ additionalProperties: false },
);
export type GuestMembershipRecord = Static<typeof GuestMembershipRecordSchema>;

export function isGuestMembershipRecord(value: unknown): value is GuestMembershipRecord {
	if (!Value.Check(GuestMembershipRecordSchema, value)) return false;
	const record = value as GuestMembershipRecord;
	return (
		isBoundedText(record.crew.id, MAX_GUEST_IDENTITY_BYTES) &&
		isBoundedText(record.crew.displayName, MAX_GUEST_NAME_BYTES) &&
		isBoundedText(record.guestIdentity, MAX_GUEST_IDENTITY_BYTES) &&
		isBoundedText(record.guestName, MAX_GUEST_NAME_BYTES) &&
		isBoundedText(record.callbackEndpoint, MAX_GUEST_ENDPOINT_BYTES) &&
		isBoundedText(record.approvedBy, MAX_GUEST_NAME_BYTES)
	);
}

/** Guest Origin is attribution labelled `(guest)`, not a crew role or authority claim. */
export const GuestOriginSchema = Type.Object(
	{
		kind: Type.Literal("guest"),
		identity: BoundedText(MAX_GUEST_IDENTITY_BYTES),
		name: BoundedText(MAX_GUEST_NAME_BYTES),
	},
	{ additionalProperties: false },
);
export type GuestOrigin = Static<typeof GuestOriginSchema>;

export function isGuestOrigin(value: unknown): value is GuestOrigin {
	if (!Value.Check(GuestOriginSchema, value)) return false;
	const origin = value as GuestOrigin;
	return isBoundedText(origin.identity, MAX_GUEST_IDENTITY_BYTES) && isBoundedText(origin.name, MAX_GUEST_NAME_BYTES);
}
