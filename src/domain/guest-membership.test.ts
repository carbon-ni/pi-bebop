import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	bindGuestApprovalCapability,
	crewSelectorFromConfig,
	guestAdmissionPolicy,
	GUEST_CAPABILITIES,
	isGuestCapability,
	isGuestMembershipRecord,
	isGuestNameAvailable,
	isGuestOrigin,
	bindingMatchesRecord,
	bindingMatchesCapability,
	removeGuestMembership,
	replaceGuestMembership,
	selectCrewBySelector,
	type CrewManifest,
} from "./index.ts";

const manifest: Pick<CrewManifest, "members"> = {
	members: [
		{ name: "lead", role: "lead", socket: "sockets/lead.sock", socketPath: "/crew/sockets/lead.sock" },
		{ name: "dev", role: "developer", socket: "sockets/dev.sock", socketPath: "/crew/sockets/dev.sock" },
	],
};

describe("Guest membership contract", () => {
	test("selects an exact stable crew identity and never guesses duplicate display names", () => {
		const alpha = crewSelectorFromConfig({ identity: "alpha", displayName: "Shared name" });
		const beta = crewSelectorFromConfig({ identity: "beta", displayName: "Shared name" });
		assert.deepEqual(selectCrewBySelector([alpha, beta], "beta"), { kind: "match", crew: beta });
		assert.deepEqual(selectCrewBySelector([alpha, beta], "Shared name"), {
			kind: "no-match",
			identity: "Shared name",
		});
		assert.equal(selectCrewBySelector([alpha, alpha], "alpha").kind, "ambiguous");
		assert.equal(selectCrewBySelector([alpha], "missing").kind, "no-match");
	});

	test("missing or empty Guest approvers disable admission; configured names are exact", () => {
		assert.deepEqual(guestAdmissionPolicy(undefined), { enabled: false });
		assert.deepEqual(guestAdmissionPolicy({ identity: "alpha", displayName: "Alpha" }), { enabled: false });
		assert.deepEqual(guestAdmissionPolicy({ identity: "alpha", displayName: "Alpha", guestApprovers: [] }), {
			enabled: false,
		});
		assert.deepEqual(guestAdmissionPolicy({ identity: "alpha", displayName: "Alpha", guestApprovers: ["lead"] }), {
			enabled: true,
			approvers: ["lead"],
		});
		assert.equal(isGuestNameAvailable(manifest, [], "guest"), true);
		assert.equal(isGuestNameAvailable(manifest, [], "lead"), false);
		assert.equal(isGuestNameAvailable(manifest, ["guest"], "guest"), false);
	});

	test("keeps Guest capability closed to ordinary messaging and excludes privileged operations", () => {
		assert.deepEqual(GUEST_CAPABILITIES, ["follow-up", "member-request", "member-response", "broadcast"]);
		for (const capability of GUEST_CAPABILITIES) assert.equal(isGuestCapability(capability), true);
		for (const capability of ["inbox", "redirect", "interrupt", "crew-control", "approve-guest"])
			assert.equal(isGuestCapability(capability), false);
	});

	test("keeps each Crew membership independent for one multi-crew Guest", () => {
		const alpha = {
			crew: { identity: "alpha", displayName: "Alpha" },
			guestIdentity: "guest-session",
			guestName: "Taylor",
			callbackEndpoint: "alpha.sock",
			approvedBy: "lead",
		};
		const beta = { ...alpha, crew: { identity: "beta", displayName: "Beta" }, callbackEndpoint: "beta.sock" };
		const replaced = { ...alpha, guestName: "Renamed" };
		assert.deepEqual(replaceGuestMembership([alpha, beta], replaced), [replaced, beta]);
		assert.deepEqual(removeGuestMembership([alpha, beta], "alpha"), [beta]);
		const capability = bindGuestApprovalCapability("runtime");
		assert.equal(bindingMatchesRecord({ ...alpha, capability }, alpha), true);
		assert.equal(bindingMatchesCapability({ ...alpha, capability }, capability), true);
		assert.equal(bindingMatchesCapability({ ...alpha, capability }, bindGuestApprovalCapability("other")), false);
		assert.equal(bindingMatchesRecord({ ...alpha, callbackEndpoint: "other.sock", capability }, alpha), false);
	});

	test("validates the persistable binding while keeping approval capability runtime-only", () => {
		const capability = bindGuestApprovalCapability("opaque-runtime-capability");
		assert.equal(typeof capability, "string");
		assert.equal(
			isGuestMembershipRecord({
				crew: { identity: "alpha", displayName: "Alpha" },
				guestIdentity: "guest-session",
				guestName: "Taylor",
				callbackEndpoint: "callback.sock",
				approvedBy: "lead",
			}),
			true,
		);
		assert.equal(
			isGuestMembershipRecord({
				crew: { identity: "alpha", displayName: "Alpha" },
				guestIdentity: "guest-session",
				guestName: "Taylor",
				callbackEndpoint: "callback.sock",
				approvedBy: "lead",
				capability,
			}),
			false,
		);
		assert.equal(
			isGuestMembershipRecord({
				crew: { identity: " alpha", displayName: "Alpha" },
				guestIdentity: "guest-session",
				guestName: "Taylor",
				callbackEndpoint: "callback.sock",
				approvedBy: "lead",
			}),
			false,
		);
		assert.equal(isGuestOrigin({ kind: "guest", identity: "guest-session", name: "Taylor" }), true);
		assert.equal(isGuestOrigin({ kind: "guest", identity: "guest-session", name: "Taylor", role: "lead" }), false);
		assert.throws(() => bindGuestApprovalCapability(" capability"));
	});
});
