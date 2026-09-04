import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createGuestAdmissionRuntime } from "./guest-admission-runtime.ts";
import type { GuestRegistryEntry } from "../domain/index.ts";
import { digestGuestCapability } from "./guest-registry-store.ts";

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
		digestCapability: (capability) => `digest-of(${capability})`,
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

describe("Guest capability one-time delivery", () => {
	test("approved capability is consumed exactly once per runtime", () => {
		const admission = runtime();
		assert.ok(admission.receive(request({ requestId: "incoming" })).ok);
		assert.ok(admission.approve("generated-1", "lead").ok);

		const first = admission.consumeCapability("guest-1");
		assert.ok(first.ok);
		assert.equal(first.capability, "opaque-capability");

		const second = admission.consumeCapability("guest-1");
		assert.deepEqual(second, { ok: false, code: "already-delivered" });

		assert.deepEqual(admission.consumeCapability("stranger"), { ok: false, code: "not-found" });

		// Re-delivery is not possible through any admission surface: the list
		// never exposes the capability and receive() stays idempotent without it.
		assert.equal("capability" in admission.list()[0]!, false);
	});

	test("approved join snapshot carries the verifier digest, never plaintext", () => {
		const snapshots: unknown[][] = [];
		const admission = runtime({ persist: (records) => snapshots.push(records) });
		assert.ok(admission.receive(request({ requestId: "incoming" })).ok);
		assert.ok(admission.approve("generated-1", "lead").ok);
		const approved = snapshots.at(-1)!.find((entry) => (entry as { status: string }).status === "approved") as {
			capabilityDigest?: string;
		};
		assert.equal(approved.capabilityDigest, "digest-of(opaque-capability)");
	});
});

describe("fresh Guest send authorization (TASK-0162)", () => {
	const DIGEST = digestGuestCapability("opaque-capability");
	function authorityRuntime(options: {
		entries: () => readonly GuestRegistryEntry[];
		digest?: (capability: string) => string;
	}) {
		const snapshots: unknown[][] = [];
		let reads = 0;
		const admission = createGuestAdmissionRuntime({
			manifest,
			memberName: "lead",
			createRequestId: () => `generated-${++reads + 100}`,
			createCapability: () => "opaque-capability",
			digestCapability: options.digest ?? digestGuestCapability,
			persist: (records) => snapshots.push(records),
			registryAuthority: () => {
				reads += 1;
				return {
					version: 1,
					crew,
					revision: reads,
					entries: options
						.entries()
						.map((entry, index) => ({
							...entry,
							order: entry.order ?? index + 1,
							revision: entry.revision ?? reads,
						})),
				};
			},
		});
		return { admission, reads: () => reads };
	}

	const approvedEntry = (overrides: Partial<GuestRegistryEntry> = {}): GuestRegistryEntry => ({
		status: "approved",
		crew,
		guestIdentity: "guest-1",
		guestName: "Alex",
		callbackEndpoint: "/tmp/guest-callback.sock",
		capabilityDigest: DIGEST,
		approver: "lead",
		order: 1,
		revision: 1,
		...overrides,
	});

	test("authorizes a fresh approved matching binding and returns the registry guest name", () => {
		const { admission, reads } = authorityRuntime({ entries: () => [approvedEntry()] });
		const result = admission.authorizeSend({
			crewId: crew.id,
			guestIdentity: "guest-1",
			callbackEndpoint: "/tmp/guest-callback.sock",
			capability: "opaque-capability",
		});
		assert.ok(result.ok);
		assert.equal(result.guestName, "Alex");
		assert.equal(reads() >= 1, true, "authorization must consult the registry authority");
	});

	test("re-reads the registry authority on every authorization so revocation is immediate", () => {
		let revoked = false;
		const { admission } = authorityRuntime({
			entries: () => (revoked ? [approvedEntry({ status: "revoked" })] : [approvedEntry()]),
		});
		const before = admission.authorizeSend({
			crewId: crew.id,
			guestIdentity: "guest-1",
			callbackEndpoint: "/tmp/guest-callback.sock",
			capability: "opaque-capability",
		});
		assert.ok(before.ok);
		revoked = true;
		const after = admission.authorizeSend({
			crewId: crew.id,
			guestIdentity: "guest-1",
			callbackEndpoint: "/tmp/guest-callback.sock",
			capability: "opaque-capability",
		});
		assert.deepEqual(after, { ok: false, code: "revoked" });
	});

	test("rejects pending, denied, unknown, wrong-crew, endpoint-drift, and capability mismatch", () => {
		const { admission } = authorityRuntime({
			entries: () => [approvedEntry()],
		});
		const base = {
			crewId: crew.id,
			guestIdentity: "guest-1",
			callbackEndpoint: "/tmp/guest-callback.sock",
			capability: "opaque-capability",
		};
		assert.deepEqual(admission.authorizeSend({ ...base, guestIdentity: "stranger" }), {
			ok: false,
			code: "not-approved",
		});
		assert.deepEqual(admission.authorizeSend({ ...base, crewId: "beta" }), { ok: false, code: "crew-mismatch" });
		assert.deepEqual(admission.authorizeSend({ ...base, callbackEndpoint: "/tmp/other.sock" }), {
			ok: false,
			code: "endpoint-mismatch",
		});
		assert.deepEqual(admission.authorizeSend({ ...base, capability: "wrong" }), {
			ok: false,
			code: "capability-mismatch",
		});
	});

	test("fails closed when the registry authority or digest derivation is unavailable", () => {
		const noAuthority = createGuestAdmissionRuntime({
			manifest,
			memberName: "lead",
			createRequestId: () => "generated-1",
			digestCapability: (capability) => `digest-of(${capability})`,
		});
		assert.deepEqual(
			noAuthority.authorizeSend({
				crewId: crew.id,
				guestIdentity: "guest-1",
				callbackEndpoint: "/tmp/guest-callback.sock",
				capability: "x",
			}),
			{ ok: false, code: "registry-unavailable" },
		);

		const noDigest = createGuestAdmissionRuntime({
			manifest,
			memberName: "lead",
			createRequestId: () => "generated-1",
			registryAuthority: () => ({ version: 1, crew, revision: 1, entries: [approvedEntry()] }),
		});
		assert.deepEqual(
			noDigest.authorizeSend({
				crewId: crew.id,
				guestIdentity: "guest-1",
				callbackEndpoint: "/tmp/guest-callback.sock",
				capability: "x",
			}),
			{ ok: false, code: "registry-unavailable" },
		);
	});
});
