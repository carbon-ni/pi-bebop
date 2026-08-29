import test from "node:test";
import assert from "node:assert/strict";
import { Value } from "@sinclair/typebox/value";
import {
	BlockingWaitMarkerSchema,
	BlockingWaitSlot,
	WaitStateSnapshotSchema,
	detectCrewIdleLock,
	isBlockingWaitMarker,
	isWaitStateSnapshot,
	resolveWaitStateCaller,
} from "./blocking-wait-state.ts";
import { parseRequest } from "./protocol.ts";

const clock = () => {
	let tick = 0;
	return {
		now: () => new Date(1_700_000_000_000 + tick++ * 1_000).toISOString(),
	};
};

const member = { name: "Dave", role: "dev" };

test("slot starts none, accepts only runtime kinds, and is transient", () => {
	const slot = new BlockingWaitSlot(clock());
	assert.deepEqual(slot.activeMarker(), null);
	const acquired = slot.acquire("member-idle");
	assert.equal(acquired.ok, true);
	if (acquired.ok) assert.equal(acquired.marker.kind, "member-idle");
	assert.equal(slot.release(), true);
	assert.deepEqual(slot.activeMarker(), null);
	// Transient: the same slot can serve a later wait, including crew-idle.
	const crew = slot.acquire("crew-idle");
	assert.equal(crew.ok, true);
	assert.equal(slot.release(), true);
});

test("a second local blocking wait of any kind rejects wait-in-progress and cannot replace the owner", () => {
	const slot = new BlockingWaitSlot(clock());
	assert.equal(slot.acquire("member-idle").ok, true);
	const second = slot.acquire("member-idle");
	assert.deepEqual(second, { ok: false, code: "wait-in-progress", owner: "member-idle" });
	const crewSecond = slot.acquire("crew-idle");
	assert.deepEqual(crewSecond, { ok: false, code: "wait-in-progress", owner: "member-idle" });
	// The failed acquire changed nothing.
	assert.equal(slot.activeMarker()?.kind, "member-idle");
});

test("release is exactly-once idempotent and firing transitions never mutates state", () => {
	const slot = new BlockingWaitSlot(clock());
	slot.acquire("member-idle");
	assert.equal(slot.release(), true);
	assert.equal(slot.release(), false);
	assert.equal(slot.release(), false);
	assert.deepEqual(slot.activeMarker(), null);
});

test("subscribeOnce returns the current marker atomically and fires exactly once per transition", () => {
	const slot = new BlockingWaitSlot(clock());
	const seen: Array<string | null> = [];
	const first = slot.subscribeOnce((marker) => seen.push(marker ? marker.kind : null));
	// Snapshot taken at subscribe time — a transition between a separate
	// check and subscribe cannot be lost.
	assert.deepEqual(first.marker, null);
	assert.equal(slot.acquire("member-idle").ok, true);
	assert.deepEqual(seen, ["member-idle"]);
	const second = slot.subscribeOnce((marker) => seen.push(marker ? marker.kind : null));
	assert.equal(second.marker?.kind, "member-idle");
	assert.equal(slot.release(), true);
	assert.deepEqual(seen, ["member-idle", null]);
	// One-shot: no later transition reaches a consumed subscription.
	slot.acquire("crew-idle");
	slot.release();
	assert.deepEqual(seen, ["member-idle", null]);
});

test("multiple one-shot subscribers each fire exactly once in subscription order", () => {
	const slot = new BlockingWaitSlot(clock());
	const order: string[] = [];
	slot.subscribeOnce((marker) => order.push(`a:${marker ? marker.kind : "none"}`));
	slot.subscribeOnce((marker) => order.push(`b:${marker ? marker.kind : "none"}`));
	slot.acquire("member-idle");
	slot.subscribeOnce((marker) => order.push(`c:${marker ? marker.kind : "none"}`));
	slot.release();
	assert.deepEqual(order, ["a:member-idle", "b:member-idle", "c:none"]);
});

test("snapshot and marker schemas are strict and privacy-safe", () => {
	assert.equal(BlockingWaitMarkerSchema.additionalProperties, false);
	assert.equal(WaitStateSnapshotSchema.additionalProperties, false);
	assert.ok(isBlockingWaitMarker({ kind: "member-idle", observedAt: "2026-08-29T10:00:00.000Z" }));
	assert.equal(isBlockingWaitMarker({ kind: "member-idle", observedAt: "2026-08-29T10:00:00.000Z", target: "Kelly" }), false);
	assert.equal(isBlockingWaitMarker({ kind: "working", observedAt: "2026-08-29T10:00:00.000Z" }), false);
	assert.equal(isBlockingWaitMarker({ kind: "crew-idle", observedAt: "not-a-time" }), false);
	assert.equal(isBlockingWaitMarker({ kind: "crew-idle", observedAt: Number.NaN }), false);
	const snapshot = { member: { name: "Dave", role: "dev" }, wait: null };
	assert.ok(isWaitStateSnapshot(snapshot));
	assert.ok(
		isWaitStateSnapshot({
			member: { name: "Dave", role: "dev" },
			wait: { kind: "crew-idle", observedAt: "2026-08-29T10:00:00.000Z" },
		}),
	);
	assert.equal(
		isWaitStateSnapshot({ member: { name: "Dave", role: "dev" }, wait: null, sessionId: "01-abc" }),
		false,
	);
	assert.equal(Value.Check(WaitStateSnapshotSchema, snapshot), true);
});

const frozenManifest = [
	{ name: "Mony", role: "lead" },
	{ name: "Dave", role: "dev" },
	{ name: "Kelly", role: "qa" },
];

function lockedObservations(names: readonly string[]) {
	return names.map((name) => ({
		name,
		status: "online" as const,
		wait: { kind: "member-idle" as const, observedAt: "2026-08-29T10:00:00.000Z" },
	}));
}

test("lock detector returns wait-lock only for full-roster explicit blocking waits under a crew gate", () => {
	const result = detectCrewIdleLock({
		callerWait: { kind: "crew-idle", observedAt: "2026-08-29T10:00:00.000Z" },
		callerName: "Mony",
		manifestMembers: frozenManifest,
		selection: ["Dave", "Kelly"],
		observations: lockedObservations(["Dave", "Kelly"]),
	});
	assert.deepEqual(result, { locked: true });
});

test("lock detector rejects caller without an active crew gate", () => {
	const result = detectCrewIdleLock({
		callerWait: { kind: "member-idle", observedAt: "2026-08-29T10:00:00.000Z" },
		callerName: "Mony",
		manifestMembers: frozenManifest,
		selection: ["Dave", "Kelly"],
		observations: lockedObservations(["Dave", "Kelly"]),
	});
	assert.deepEqual(result, { locked: false, reason: "caller-not-crew-gate" });
	assert.equal(
		detectCrewIdleLock({
			callerWait: null,
			callerName: "Mony",
			manifestMembers: frozenManifest,
			selection: ["Dave", "Kelly"],
			observations: lockedObservations(["Dave", "Kelly"]),
		}).locked,
		false,
	);
});

test("lock detector rejects any proper subset selection", () => {
	const result = detectCrewIdleLock({
		callerWait: { kind: "crew-idle", observedAt: "2026-08-29T10:00:00.000Z" },
		callerName: "Mony",
		manifestMembers: frozenManifest,
		selection: ["Dave"],
		observations: lockedObservations(["Dave"]),
	});
	assert.deepEqual(result, { locked: false, reason: "selection-subset" });
});

test("lock detector never turns non-explicit observations into lock evidence", () => {
	const base = {
		callerWait: { kind: "crew-idle" as const, observedAt: "2026-08-29T10:00:00.000Z" },
		callerName: "Mony",
		manifestMembers: frozenManifest,
		selection: ["Dave", "Kelly"],
	};
	const nonLocks: Array<[string, unknown]> = [
		["offline", [...lockedObservations(["Dave"]), { name: "Kelly", status: "offline" }]],
		["missing", [...lockedObservations(["Dave"]), { name: "Kelly", status: "missing" }]],
		["stale", [...lockedObservations(["Dave"]), { name: "Kelly", status: "stale" }]],
		["failed", [...lockedObservations(["Dave"]), { name: "Kelly", status: "failed" }]],
		[
			"target-not-blocking",
			[
				...lockedObservations(["Dave"]),
				{ name: "Kelly", status: "online", wait: null },
			],
		],
	];
	for (const [reason, observations] of nonLocks) {
		const result = detectCrewIdleLock({ ...base, observations: observations as never });
		assert.deepEqual(result, { locked: false, reason }, reason);
	}
	// Generic busy/compacting is never wait evidence: it arrives as wait:null
	// online observation and must fail safe as target-not-blocking.
});

test("lock detector rejects observation/selection mismatch", () => {
	const result = detectCrewIdleLock({
		callerWait: { kind: "crew-idle", observedAt: "2026-08-29T10:00:00.000Z" },
		callerName: "Mony",
		manifestMembers: frozenManifest,
		selection: ["Dave", "Kelly"],
		observations: lockedObservations(["Kelly", "Dave"]),
	});
	assert.deepEqual(result, { locked: true }, "order-independent full set still locks");
	const mismatch = detectCrewIdleLock({
		callerWait: { kind: "crew-idle", observedAt: "2026-08-29T10:00:00.000Z" },
		callerName: "Mony",
		manifestMembers: frozenManifest,
		selection: ["Dave", "Kelly"],
		observations: lockedObservations(["Dave"]),
	});
	assert.deepEqual(mismatch, { locked: false, reason: "target-missing" });
});

test("caller label resolves against the frozen manifest like member messaging authority", () => {
	const ok = resolveWaitStateCaller(frozenManifest, "Mony", "Kelly");
	assert.equal(ok.ok, true);
	assert.deepEqual(resolveWaitStateCaller(frozenManifest, "Mony", "Nobody"), { ok: false, code: "unknown-member" });
	assert.deepEqual(resolveWaitStateCaller(frozenManifest, "Mony", "Mony"), { ok: false, code: "self" });
	assert.deepEqual(resolveWaitStateCaller(frozenManifest, "Outsider", "Kelly"), {
		ok: false,
		code: "not-a-member",
	});
});

test("wait_state wire request decodes into the closed command", () => {
	const parsed = parseRequest(
		JSON.stringify({ jsonrpc: "2.0", id: 7, method: "member.wait_state", params: { member: "Mony" } }),
	);
	assert.equal(parsed.error, undefined);
	if (!parsed.error && parsed.request) {
		const command = parseRequest(JSON.stringify(parsed.request)).request;
		assert.ok(command);
		assert.equal((command as { method?: string }).method, "member.wait_state");
	}
	// Extra params are rejected.
	const bad = parseRequest(
		JSON.stringify({ jsonrpc: "2.0", id: 8, method: "member.wait_state", params: { member: "Mony", extra: 1 } }),
	);
	assert.notEqual(bad.error, undefined);
});
