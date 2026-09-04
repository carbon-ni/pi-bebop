import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	bindGuestApprovalCapability,
	GuestSchema,
	GuestThreatModelSchema,
	crewSelectorFromConfig,
	guestAdmissionPolicy,
	GUEST_CAPABILITIES,
	isGuestCapability,
	isGuestApproval,
	isGuestJoinRequest,
	isGuestMembershipRecord,
	isGuestRevocation,
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
	test("defines stable Guest identity/callback and the threat model as closed schemas", () => {
		assert.equal(GuestSchema.type, "object");
		assert.equal(GuestThreatModelSchema.type, "object");
	});

	test("selects an exact stable crew identity and never guesses duplicate display names", () => {
		const alpha = crewSelectorFromConfig({ id: "alpha", displayName: "Shared name" });
		const beta = crewSelectorFromConfig({ id: "beta", displayName: "Shared name" });
		assert.deepEqual(selectCrewBySelector([alpha, beta], "beta"), { kind: "match", crew: beta });
		assert.deepEqual(selectCrewBySelector([alpha, beta], "Shared name"), {
			kind: "no-match",
			identity: "Shared name",
		});
		assert.equal(selectCrewBySelector([alpha, alpha], "alpha").kind, "ambiguous");
		assert.equal(selectCrewBySelector([alpha], "missing").kind, "no-match");
	});

	test("missing Guest admission disables it; configured names are exact", () => {
		assert.deepEqual(guestAdmissionPolicy(undefined), { enabled: false, reason: "missing" });
		assert.deepEqual(guestAdmissionPolicy({ approvers: [] }), { enabled: false, reason: "empty" });
		assert.deepEqual(guestAdmissionPolicy({ approvers: ["lead"] }), { enabled: true, approvers: ["lead"] });
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

	test("models untrusted join, Crew-local approval, and Crew-local revocation", () => {
		const request = {
			requestId: "request-1",
			crew: { identity: "alpha", displayName: "Alpha" },
			guestIdentity: "guest-session",
			guestName: "Taylor",
			callbackEndpoint: "callback.sock",
			submittedByMember: "lead",
		};
		assert.equal(isGuestJoinRequest(request), true);
		assert.equal(
			isGuestApproval({
				requestId: request.requestId,
				crew: request.crew,
				guestIdentity: request.guestIdentity,
				guestName: request.guestName,
				callbackEndpoint: request.callbackEndpoint,
				approver: "lead",
			}),
			true,
		);
		assert.equal(
			isGuestRevocation({ crew: request.crew, guestIdentity: request.guestIdentity, revokedBy: "lead" }),
			true,
		);
		assert.equal(
			isGuestApproval({
				requestId: request.requestId,
				crew: request.crew,
				guestIdentity: request.guestIdentity,
				guestName: request.guestName,
				callbackEndpoint: request.callbackEndpoint,
				approver: "unknown",
				extra: true,
			}),
			false,
		);
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
