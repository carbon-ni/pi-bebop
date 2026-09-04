import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createGuestAdmissionRuntime } from "./guest-admission-runtime.ts";

const crew = { id: "alpha", displayName: "Alpha" } as const;
const manifest = {
	version: 1 as const,
	crew,
	guestAdmission: { approvers: ["lead"] },
	members: [{ name: "lead", role: "lead", socket: "sockets/lead.sock", socketPath: "/crew/lead.sock" }],
};

function request(overrides: Record<string, unknown> = {}) {
	return {
		requestId: "request-1",
		crew,
		guestIdentity: "guest-1",
		guestName: "Taylor",
		callbackEndpoint: "/tmp/callback.sock",
		submittedByMember: "lead",
		...overrides,
	};
}

function runtime(overrides: Partial<Parameters<typeof createGuestAdmissionRuntime>[0]> = {}) {
	let nextRequest = 0;
	return createGuestAdmissionRuntime({
		manifest,
		memberName: "lead",
		createRequestId: () => `generated-${++nextRequest}`,
		createCapability: () => "opaque-capability",
		...overrides,
	});
}

describe("Guest admission runtime", () => {
	test("accepts one pending request, makes replay idempotent, and approves only exact approvers", () => {
		const admission = runtime();
		assert.deepEqual(admission.receive(request()), {
			ok: true,
			status: "pending",
			requestId: "generated-1",
			crew,
			idempotent: false,
		});
		assert.deepEqual(admission.receive(request({ requestId: "different" })), {
			ok: true,
			status: "pending",
			requestId: "generated-1",
			crew,
			idempotent: true,
		});
		assert.deepEqual(admission.approve("generated-1", "developer"), { ok: false, code: "unauthorized" });
		const approved = admission.approve("generated-1", "lead");
		assert.equal(approved.ok, true);
		if (approved.ok) {
			assert.equal(approved.record.guestName, "Taylor");
			assert.equal("callbackEndpoint" in admission.list()[0]!, false);
			assert.equal("capability" in admission.list()[0]!, false);
		}
		const replay = admission.approve("generated-1", "lead");
		assert.equal(replay.ok, true);
		if (replay.ok) assert.equal(replay.idempotent, true);
	});

	test("denies pending requests and rejects their replay", () => {
		const admission = runtime();
		admission.receive(request());
		assert.deepEqual(admission.deny("generated-1", "lead"), { ok: true, changed: true });
		assert.deepEqual(admission.receive(request({ requestId: "replay" })), { ok: false, code: "denied" });
	});

	test("rejects name collision, crew confusion, and replay after revocation", () => {
		const admission = runtime();
		admission.receive(request());
		assert.deepEqual(admission.receive(request({ guestIdentity: "guest-2", requestId: "request-2" })), {
			ok: true,
			status: "pending",
			requestId: "generated-2",
			crew,
			idempotent: false,
		});
		const approval = admission.approve("generated-1", "lead");
		assert.equal(approval.ok, true);
		if (approval.ok) {
			assert.equal(approval.record.guestName, "Taylor");
			assert.equal(approval.capability, "opaque-capability");
		}
		assert.deepEqual(
			admission.receive(request({ requestId: "request-3", guestIdentity: "guest-2", guestName: "Taylor" })),
			{
				ok: false,
				code: "name-collision",
			},
		);
		assert.deepEqual(admission.receive(request({ crew: { id: "other", displayName: "Other" } })), {
			ok: false,
			code: "crew-mismatch",
		});
		assert.deepEqual(admission.remove("Taylor", "lead"), { ok: true, changed: true });
		assert.deepEqual(admission.receive(request({ requestId: "replay" })), { ok: false, code: "revoked" });
	});
});
