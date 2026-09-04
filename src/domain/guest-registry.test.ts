import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	isGuestRegistryCapabilityDigest,
	isGuestRegistryEntry,
	isGuestRegistryFile,
	nextGuestRegistryRevision,
	type GuestRegistryEntry,
} from "./guest-registry.ts";

const crew = { id: "alpha", displayName: "Alpha" } as const;

function approvedEntry(overrides: Partial<GuestRegistryEntry> = {}): GuestRegistryEntry {
	return {
		status: "approved",
		crew,
		guestIdentity: "guest-session",
		guestName: "Alex",
		callbackEndpoint: "/tmp/callback.sock",
		capabilityDigest: "a".repeat(64),
		approver: "lead",
		order: 1,
		revision: 1,
		...overrides,
	};
}

describe("Guest registry contract", () => {
	test("accepts tombstone entries with exact crew, identity, name, endpoint, digest, approver, order, revision", () => {
		assert.equal(isGuestRegistryEntry(approvedEntry()), true);
		assert.equal(isGuestRegistryEntry(approvedEntry({ status: "revoked" })), true);
		assert.equal(isGuestRegistryEntry(approvedEntry({ status: "denied", callbackEndpoint: "/tmp/cb.sock" })), true);
		assert.equal(
			isGuestRegistryEntry(
				approvedEntry({ status: "pending", approver: undefined, capabilityDigest: "b".repeat(64) }),
			),
			true,
		);
	});

	test("rejects tampered entries: bad digest, bad status, padded names, missing fields", () => {
		assert.equal(isGuestRegistryEntry(approvedEntry({ capabilityDigest: "zz" })), false);
		assert.equal(isGuestRegistryEntry(approvedEntry({ capabilityDigest: "A".repeat(64) })), false);
		assert.equal(isGuestRegistryEntry(approvedEntry({ status: "unknown" as never })), false);
		assert.equal(isGuestRegistryEntry(approvedEntry({ guestName: " Alex" })), false);
		assert.equal(isGuestRegistryEntry(approvedEntry({ approver: undefined })), false);
		assert.equal(isGuestRegistryEntry(approvedEntry({ order: 0 })), false);
		assert.equal(isGuestRegistryEntry(approvedEntry({ revision: 0 })), false);
	});

	test("validates the whole registry file including crew binding and revision", () => {
		assert.equal(isGuestRegistryFile({ version: 1, crew, revision: 3, entries: [approvedEntry()] }), true);
		assert.equal(isGuestRegistryFile({ version: 2, crew, revision: 3, entries: [approvedEntry()] }), false);
		assert.equal(isGuestRegistryFile({ version: 1, revision: 3, entries: [approvedEntry()] }), false);
		assert.equal(
			isGuestRegistryFile({
				version: 1,
				crew: { id: "beta", displayName: "Beta" },
				revision: 3,
				entries: [approvedEntry()],
			}),
			false,
			"entries must belong to the registry's crew",
		);
		assert.equal(isGuestRegistryFile({ version: 1, crew, revision: 0, entries: [] }), false);
	});

	test("next revision is strictly monotonic", () => {
		assert.equal(nextGuestRegistryRevision(null), 1);
		assert.equal(nextGuestRegistryRevision({ version: 1, crew, revision: 7, entries: [] }), 8);
	});

	test("capability verifier digest field is exactly lowercase hex sha256", () => {
		assert.equal(isGuestRegistryCapabilityDigest("a".repeat(64)), true);
		assert.equal(isGuestRegistryCapabilityDigest("a".repeat(63)), false);
		assert.equal(isGuestRegistryCapabilityDigest("A".repeat(64)), false);
	});
});
