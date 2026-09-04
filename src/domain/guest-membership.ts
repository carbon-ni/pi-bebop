import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { CrewGuestConfig, CrewManifest } from "./crew-manifest.ts";

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

const BoundedText = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: "^[^\\u0000\\r\\n]+$" });
const isBoundedText = (value: unknown, maxBytes: number): value is string =>
	typeof value === "string" &&
	value.length > 0 &&
	value.trim() === value &&
	!value.includes("\0") &&
	!/[\r\n]/.test(value) &&
	Buffer.byteLength(value, "utf8") <= maxBytes;

/** Public selector shown to a Guest; it contains no manifest path or socket route. */
export const CrewSelectorSchema = Type.Object(
	{
		identity: BoundedText(MAX_GUEST_IDENTITY_BYTES),
		displayName: BoundedText(MAX_GUEST_NAME_BYTES),
	},
	{ additionalProperties: false },
);
export type CrewSelector = Static<typeof CrewSelectorSchema>;

/** Stable identity and display metadata projected from a manifest. */
export function crewSelectorFromConfig(config: CrewGuestConfig): CrewSelector {
	return { identity: config.identity, displayName: config.displayName };
}

export type CrewSelectorLookup =
	| { readonly kind: "match"; readonly crew: CrewSelector }
	| { readonly kind: "no-match"; readonly identity: string }
	| { readonly kind: "ambiguous"; readonly displayName: string; readonly crews: readonly CrewSelector[] };

/**
 * Selects by stable identity, never by display name. Duplicate display names
 * are therefore harmless; a UI may show them but must retain the selector.
 */
export function selectCrewBySelector(crews: readonly CrewSelector[], identity: string): CrewSelectorLookup {
	const matches = crews.filter((crew) => crew.identity === identity);
	if (matches.length === 0) return { kind: "no-match", identity };
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
export function guestAdmissionPolicy(
	config: CrewGuestConfig | undefined,
): { readonly enabled: true; readonly approvers: readonly string[] } | { readonly enabled: false } {
	const approvers = config?.guestApprovers;
	if (!approvers || approvers.length === 0) return { enabled: false };
	return { enabled: true, approvers: [...approvers] };
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
	const index = memberships.findIndex((membership) => membership.crew.identity === replacement.crew.identity);
	if (index < 0) return [...memberships, replacement];
	return memberships.map((membership, candidate) => (candidate === index ? replacement : membership));
}

/** Removes only one exact Crew membership; leaving a Crew cannot release others. */
export function removeGuestMembership(
	memberships: readonly GuestMembershipRecord[],
	crewIdentity: string,
): readonly GuestMembershipRecord[] {
	return memberships.filter((membership) => membership.crew.identity !== crewIdentity);
}

/** Fails closed when any restored identity, endpoint, approver, or Crew binding differs. */
export function bindingMatchesRecord(binding: GuestMembershipBinding, record: GuestMembershipRecord): boolean {
	return (
		binding.crew.identity === record.crew.identity &&
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
		isBoundedText(record.crew.identity, MAX_GUEST_IDENTITY_BYTES) &&
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
