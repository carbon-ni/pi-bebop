import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { CrewSelectorSchema, MAX_GUEST_IDENTITY_BYTES, MAX_GUEST_NAME_BYTES } from "./guest-membership.ts";

/**
 * Crew-owned Guest approval registry contract.
 *
 * The registry is the single crew-shared authority for Guest admission state
 * (pending / approved / denied / revoked tombstones). It lives next to the
 * trusted crew manifest, is authoritative across every Member runtime, and
 * never stores a plaintext capability: approved entries carry only a verifier
 * digest of the runtime-held capability. Order and revision make concurrent
 * writes deterministic and crash recovery monotonic.
 */

export const GUEST_REGISTRY_VERSION = 1;
export const GUEST_REGISTRY_STATUSES = ["pending", "approved", "denied", "revoked"] as const;
export type GuestRegistryStatus = (typeof GUEST_REGISTRY_STATUSES)[number];

/** Verifier digest of the runtime-held capability (lowercase hex sha256). */
export const GUEST_REGISTRY_DIGEST_LENGTH = 64;

export function isGuestRegistryCapabilityDigest(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

const GuestRegistryText = (maxLength: number) =>
	Type.String({ minLength: 1, maxLength, pattern: "^[^\\u0000\\r\\n]+$" });

function isBounded(value: unknown, maxBytes: number): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.trim() === value &&
		!value.includes("\0") &&
		!/[\r\n]/.test(value) &&
		Buffer.byteLength(value, "utf8") <= maxBytes
	);
}

export const GuestRegistryEntrySchema = Type.Object(
	{
		status: Type.Union(GUEST_REGISTRY_STATUSES.map((status) => Type.Literal(status))),
		crew: CrewSelectorSchema,
		guestIdentity: Type.String({ minLength: 1 }),
		guestName: GuestRegistryText(MAX_GUEST_NAME_BYTES),
		callbackEndpoint: GuestRegistryText(512),
		capabilityDigest: Type.String({
			minLength: GUEST_REGISTRY_DIGEST_LENGTH,
			maxLength: GUEST_REGISTRY_DIGEST_LENGTH,
		}),
		approver: Type.Optional(GuestRegistryText(MAX_GUEST_IDENTITY_BYTES)),
		order: Type.Integer({ minimum: 1 }),
		revision: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

export type GuestRegistryEntry = Static<typeof GuestRegistryEntrySchema>;

export function isGuestRegistryEntry(value: unknown): value is GuestRegistryEntry {
	if (!Value.Check(GuestRegistryEntrySchema, value)) return false;
	const entry = value as GuestRegistryEntry;
	if (!isBounded(entry.guestIdentity, MAX_GUEST_IDENTITY_BYTES)) return false;
	if (!isBounded(entry.guestName, MAX_GUEST_NAME_BYTES)) return false;
	if (!isBounded(entry.callbackEndpoint, 512)) return false;
	if (!isGuestRegistryCapabilityDigest(entry.capabilityDigest)) return false;
	// A pending tombstone has no approver yet; every decided tombstone does.
	if (entry.status === "pending") return true;
	return isBounded(entry.approver, MAX_GUEST_IDENTITY_BYTES);
}

export const GuestRegistryFileSchema = Type.Object(
	{
		version: Type.Literal(GUEST_REGISTRY_VERSION),
		crew: CrewSelectorSchema,
		revision: Type.Integer({ minimum: 1 }),
		entries: Type.Array(GuestRegistryEntrySchema, { maxItems: 256 }),
	},
	{ additionalProperties: false },
);

export type GuestRegistryFile = Static<typeof GuestRegistryFileSchema>;

/** Validates the whole file, including that every entry belongs to the crew. */
export function isGuestRegistryFile(value: unknown): value is GuestRegistryFile {
	if (!Value.Check(GuestRegistryFileSchema, value)) return false;
	const file = value as GuestRegistryFile;
	return file.entries.every(
		(entry) => entry.crew.id === file.crew.id && entry.crew.displayName === file.crew.displayName,
	);
}

export function nextGuestRegistryRevision(file: GuestRegistryFile | null): number {
	return (file?.revision ?? 0) + 1;
}
