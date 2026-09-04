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
		const persisted: unknown[] = [];
		const source = runtime({ persist: (records) => persisted.push(records) });
		source.receive(request());
		source.deny("generated-1", "lead");
		const restored = runtime();
		assert.deepEqual(restored.restore(persisted[0] as readonly unknown[]), { restored: ["guest-1"], rejected: [] });
		assert.deepEqual(restored.receive(request({ requestId: "replay-2" })), { ok: false, code: "denied" });
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

describe("Guest admission restore and interleaving", () => {
	test("restore keeps denied and revoked tombstones and re-approvals fail closed", () => {
		let nextCapability = 0;
		const persisted: unknown[][] = [];
		const admission = runtime({ persist: (records) => persisted.push(records) });
		assert.ok(admission.receive(request({ requestId: "incoming" })).ok);
		assert.ok(admission.approve("generated-1", "lead").ok);
		assert.ok(
			admission.receive(request({ requestId: "incoming", guestIdentity: "guest-2", guestName: "Rowan" })).ok,
		);
		assert.ok(admission.deny("generated-2", "lead").ok);
		assert.ok(admission.remove("Taylor", "lead").ok);

		// Crash: rebuild from the final persisted snapshot only.
		const rebuilt = runtime({
			createCapability: () => `restored-capability-${++nextCapability}`,
		});
		const snapshot = persisted.at(-1)!;
		const result = rebuilt.restore(snapshot);
		assert.deepEqual(result.restored.sort(), ["guest-1", "guest-2"]);
		assert.deepEqual(result.rejected, []);
		assert.deepEqual(
			rebuilt.list().map((row) => [row.guestName, row.status]),
			[
				["Rowan", "denied"],
				["Taylor", "revoked"],
			],
		);

		// Tombstones survive: replayed joins after restore stay rejected.
		assert.deepEqual(rebuilt.receive(request({ guestIdentity: "guest-2", guestName: "Rowan" })), {
			ok: false,
			code: "denied",
		});
		assert.deepEqual(rebuilt.receive(request()), { ok: false, code: "revoked" });
	});

	test("interleaved requests, denials, and revocations stay deterministic and atomic", () => {
		const admission = runtime();
		// Two identities request; approving one cannot consume the other's request.
		assert.ok(admission.receive(request({ guestIdentity: "guest-1", guestName: "Taylor" })).ok);
		assert.ok(admission.receive(request({ guestIdentity: "guest-2", guestName: "Rowan" })).ok);
		const approved = admission.approve("generated-2", "lead");
		assert.ok(approved.ok);
		assert.equal(approved.record.guestName, "Rowan");
		// The stale request id of the other identity neither approves nor denies it.
		assert.deepEqual(admission.approve("generated-2", "lead"), {
			ok: true,
			record: approved.record,
			capability: approved.capability,
			idempotent: true,
		});
		assert.ok(admission.deny("generated-1", "lead").ok);
		// Revoking the removed binding then denying a pending entry never cross.
		assert.deepEqual(admission.remove("Rowan", "lead"), { ok: true, changed: true });
		assert.deepEqual(admission.remove("Rowan", "lead"), { ok: false, code: "not-found" });
		assert.deepEqual(
			admission.list().map((row) => [row.guestName, row.status]),
			[
				["Rowan", "revoked"],
				["Taylor", "denied"],
			],
		);
	});
});
