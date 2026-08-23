import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Value } from "@sinclair/typebox/value";
import {
	MEMBER_IDLE_WAIT_TIMEOUT_DEFAULT,
	MEMBER_IDLE_WAIT_TIMEOUT_MAX,
	MEMBER_IDLE_WAIT_TIMEOUT_MIN,
	MAX_MEMBER_IDLE_WAIT_SUBSCRIPTIONS,
	MemberIdleWaitResultSchema,
	applyIdleWaitSignal,
	createMemberIdleWaitResult,
	formatMemberIdleWaitResult,
	isMemberIdleWaitResult,
	registerOneShotIdleWait,
	resolveIdleWaitTimeoutSeconds,
	resolveMemberIdleWaitTarget,
	tryAcquireIdleWaitSubscription,
	type MemberIdleWaitSignal,
	type MemberIdleWaitState,
} from "./member-idle-wait.ts";

const bob = { name: "Bob", role: "developer" };
const kelly = { name: "Kelly", role: "qa" };
const observedAt = "2026-08-23T12:03:00.000Z";

const manifest = {
	members: [
		bob,
		kelly,
		{ name: "Mary", role: "po" },
		{ name: "Dimmy", role: "qa" }, // shares qa role -> ambiguous
	],
};

const waiting: MemberIdleWaitState = { phase: "waiting", target: bob };

describe("member idle wait timeout validation", () => {
	test("defaults to 300 seconds when omitted", () => {
		assert.equal(resolveIdleWaitTimeoutSeconds(undefined), MEMBER_IDLE_WAIT_TIMEOUT_DEFAULT);
	});

	test("accepts the full 1-600 second range", () => {
		assert.equal(resolveIdleWaitTimeoutSeconds(1), 1);
		assert.equal(resolveIdleWaitTimeoutSeconds(600), 600);
		assert.equal(resolveIdleWaitTimeoutSeconds(300), 300);
	});

	test("rejects out-of-range, non-finite, and fractional timeouts deterministically", () => {
		for (const value of [0, -1, 601, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			assert.throws(() => resolveIdleWaitTimeoutSeconds(value), TypeError);
		}
	});
});

describe("member idle wait target resolution", () => {
	test("resolves by exact configured name", () => {
		const outcome = resolveMemberIdleWaitTarget(manifest, "Mary", "Bob");
		assert.equal(outcome.ok, true);
		if (outcome.ok) assert.equal(outcome.target.name, "Bob");
	});

	test("resolves by unique role", () => {
		const outcome = resolveMemberIdleWaitTarget(manifest, "Mary", "developer");
		assert.equal(outcome.ok, true);
		if (outcome.ok) assert.equal(outcome.target.name, "Bob");
	});

	test("rejects unknown target before any network IO", () => {
		const outcome = resolveMemberIdleWaitTarget(manifest, "Mary", "Zoe");
		assert.deepEqual(outcome, { ok: false, code: "unknown-member" });
	});

	test("rejects ambiguous role before any network IO", () => {
		const outcome = resolveMemberIdleWaitTarget(manifest, "Mary", "qa");
		assert.deepEqual(outcome, { ok: false, code: "ambiguous-member" });
	});

	test("rejects waiting on self", () => {
		const outcome = resolveMemberIdleWaitTarget(manifest, "Bob", "Bob");
		assert.deepEqual(outcome, { ok: false, code: "self-wait" });
	});

	test("rejects sender that is not a current member", () => {
		const outcome = resolveMemberIdleWaitTarget(manifest, "Zoe", "Bob");
		assert.deepEqual(outcome, { ok: false, code: "not-a-member" });
	});

	test("rejects blank or unsafe target labels", () => {
		for (const label of ["", "   ", "bad\u0000label"]) {
			assert.deepEqual(resolveMemberIdleWaitTarget(manifest, "Mary", label), {
				ok: false,
				code: "unknown-member",
			});
		}
	});

	test("roles grant no extra authority: any member may wait for any other member", () => {
		for (const sender of ["Bob", "Kelly", "Mary", "Dimmy"]) {
			const target = sender === "Bob" ? "Kelly" : "Bob";
			const outcome = resolveMemberIdleWaitTarget(manifest, sender, target);
			assert.equal(outcome.ok, true, `${sender} -> ${target}`);
		}
	});
});

describe("one-shot idle wait registration (subscribe-and-snapshot)", () => {
	test("already-idle snapshot completes immediately without registering a lingering subscription", () => {
		const { state, result } = registerOneShotIdleWait({ target: bob, snapshotIsIdle: true, observedAt });
		assert.equal(state.phase, "terminal");
		assert.equal(result?.outcome, "idle");
		assert.equal(result?.disposition, "already-idle");
		assert.equal(result?.observedAt, observedAt);
		// A terminal state never transitions again.
		const after = applyIdleWaitSignal(state, { type: "settled" }, observedAt);
		assert.equal(after.state.phase, "terminal");
		assert.equal(after.result?.disposition, "already-idle");
	});

	test("busy snapshot registers a waiting subscription", () => {
		const { state, result } = registerOneShotIdleWait({ target: bob, snapshotIsIdle: false, observedAt });
		assert.equal(state.phase, "waiting");
		assert.equal(result, undefined);
	});
});

describe("one-shot idle wait state race", () => {
	test("busy target completes with became-idle only on the settled signal", () => {
		const { state, result } = applyIdleWaitSignal(waiting, { type: "settled" }, observedAt);
		assert.equal(state.phase, "terminal");
		assert.equal(result?.outcome, "idle");
		assert.equal(result?.disposition, "became-idle");
		assert.equal(result?.observedAt, observedAt);
	});

	test("agent_end alone is insufficient: the wait keeps waiting while retry/compaction/continuation remains", () => {
		const after = applyIdleWaitSignal(waiting, { type: "agent_end" }, observedAt);
		assert.equal(after.state.phase, "waiting");
		assert.equal(after.result, undefined);
		// A later settled signal is still observed after agent_end.
		const settled = applyIdleWaitSignal(after.state, { type: "settled" }, observedAt);
		assert.equal(settled.state.phase, "terminal");
		assert.equal(settled.result?.disposition, "became-idle");
	});

	test("disconnect during wait completes as offline rather than hanging or resubscribing", () => {
		const { state, result } = applyIdleWaitSignal(waiting, { type: "disconnect" }, observedAt);
		assert.equal(state.phase, "terminal");
		assert.equal(result?.outcome, "offline");
		assert.equal(result?.observedAt, observedAt);
	});

	test("bounded deadline expiry produces the deterministic timeout outcome", () => {
		const { state, result } = applyIdleWaitSignal(waiting, { type: "timeout" }, observedAt);
		assert.equal(state.phase, "terminal");
		assert.equal(result?.outcome, "timeout");
		assert.equal(result?.observedAt, observedAt);
	});

	test("exactly one terminal outcome wins: first terminal signal wins and later signals are no-ops", () => {
		const settled = applyIdleWaitSignal(waiting, { type: "settled" }, observedAt);
		const afterTimeout = applyIdleWaitSignal(settled.state, { type: "timeout" }, observedAt);
		assert.equal(afterTimeout.result?.outcome, "idle");
		assert.equal(afterTimeout.result?.disposition, "became-idle");

		const timed = applyIdleWaitSignal(waiting, { type: "timeout" }, observedAt);
		const afterSettle = applyIdleWaitSignal(timed.state, { type: "settled" }, observedAt);
		assert.equal(afterSettle.result?.outcome, "timeout");
	});

	test("duplicate terminal events never change the terminal outcome", () => {
		const settled = applyIdleWaitSignal(waiting, { type: "settled" }, observedAt);
		const again = applyIdleWaitSignal(settled.state, { type: "settled" }, observedAt);
		assert.equal(again.state.phase, "terminal");
		assert.equal(again.result?.outcome, "idle");
		const disconnected = applyIdleWaitSignal(again.state, { type: "disconnect" }, observedAt);
		assert.equal(disconnected.result?.outcome, "idle");
	});

	test("cancellation releases the subscription promptly and later signals are no-ops", () => {
		const cancelled = applyIdleWaitSignal(waiting, { type: "cancel" }, observedAt);
		assert.equal(cancelled.state.phase, "released");
		assert.equal(cancelled.released, true);
		assert.equal(cancelled.result, undefined);
		// No lingering subscription: settle/disconnect/timeout after cancel are no-ops.
		const afterSettle = applyIdleWaitSignal(cancelled.state, { type: "settled" }, observedAt);
		assert.equal(afterSettle.state.phase, "released");
		assert.equal(afterSettle.released, false);
		assert.equal(afterSettle.result, undefined);
	});

	test("cancelling an already-terminal wait is a no-op", () => {
		const settled = applyIdleWaitSignal(waiting, { type: "settled" }, observedAt);
		const afterCancel = applyIdleWaitSignal(settled.state, { type: "cancel" }, observedAt);
		assert.equal(afterCancel.state.phase, "terminal");
		assert.equal(afterCancel.result?.outcome, "idle");
	});
});

describe("member idle wait result privacy", () => {
	test("result contains only name/role, terminal outcome/disposition, and observation timestamp", () => {
		const result = createMemberIdleWaitResult(bob, { outcome: "idle", disposition: "became-idle" }, observedAt);
		assert.deepEqual(result, {
			member: bob,
			outcome: "idle",
			disposition: "became-idle",
			observedAt,
		});
		assert.equal(isMemberIdleWaitResult(result), true);
		assert.equal(Value.Check(MemberIdleWaitResultSchema, result), true);
	});

	test("offline result omits disposition", () => {
		const result = createMemberIdleWaitResult(bob, { outcome: "offline" }, observedAt);
		assert.deepEqual(result, { member: bob, outcome: "offline", observedAt });
		assert.equal(isMemberIdleWaitResult(result), true);
	});

	test("rejects extra privacy-sensitive fields: messages, focus, session ids, aliases, paths, model data, instructions", () => {
		const extraFields: Array<[string, unknown]> = [
			["message", { content: "hello" }],
			["focus", { state: "reported", text: "secret", updatedAt: observedAt }],
			["sessionId", "01a02dcb"],
			["alias", "intra-dev"],
			["socketPath", "/project/.pi/bebop/sockets/dev.sock"],
			["model", "gpt-4"],
			["instructions", ["do something"]],
		];
		for (const [key, value] of extraFields) {
			const candidate = {
				member: bob,
				outcome: "idle",
				disposition: "already-idle",
				observedAt,
				[key]: value,
			};
			assert.equal(isMemberIdleWaitResult(candidate), false, `must reject extra field: ${key}`);
			assert.equal(Value.Check(MemberIdleWaitResultSchema, candidate), false, `schema rejects ${key}`);
		}
	});

	test("rejects invalid identity labels, malformed timestamps, and missing disposition", () => {
		for (const candidate of [
			{ member: { name: "Bob", role: "developer" }, outcome: "idle", observedAt },
			{ member: { name: "", role: "developer" }, outcome: "idle", disposition: "already-idle", observedAt },
			{
				member: { name: "Bob", role: "developer" },
				outcome: "idle",
				disposition: "already-idle",
				observedAt: "yesterday",
			},
			{ member: { name: "Bob", role: "developer" }, outcome: "idle", disposition: "suspended", observedAt },
			{ member: { name: "Bob", role: "developer" }, outcome: "unknown", observedAt },
		]) {
			assert.equal(isMemberIdleWaitResult(candidate), false);
		}
	});
});

describe("member idle wait subscription capacity", () => {
	test("acquires a slot when below capacity", () => {
		assert.deepEqual(tryAcquireIdleWaitSubscription(new Set(["Kelly"]), "Bob", 1), { ok: true });
	});

	test("rejects a duplicate wait for the same target", () => {
		assert.deepEqual(tryAcquireIdleWaitSubscription(new Set(["Bob"]), "Bob", 1), {
			ok: false,
			code: "already-waiting",
		});
	});

	test("rejects overflow explicitly at bounded capacity", () => {
		const full = new Set(["Mary", "Kelly", "Dimmy", "Dave", "Tony", "Zoe", "Ann", "Eve"]);
		assert.equal(full.size, MAX_MEMBER_IDLE_WAIT_SUBSCRIPTIONS);
		assert.deepEqual(tryAcquireIdleWaitSubscription(full, "Bob", full.size), {
			ok: false,
			code: "capacity-exceeded",
		});
	});

	test("capacity is finite and documented", () => {
		assert.equal(MAX_MEMBER_IDLE_WAIT_SUBSCRIPTIONS, 8);
	});
});

describe("signal exhaustiveness", () => {
	test("every documented signal is handled deterministically from waiting", () => {
		const signals: Array<{ signal: MemberIdleWaitSignal; outcome?: string; phase: MemberIdleWaitState["phase"] }> =
			[
				{ signal: { type: "settled" }, outcome: "idle", phase: "terminal" },
				{ signal: { type: "agent_end" }, phase: "waiting" },
				{ signal: { type: "disconnect" }, outcome: "offline", phase: "terminal" },
				{ signal: { type: "timeout" }, outcome: "timeout", phase: "terminal" },
				{ signal: { type: "cancel" }, phase: "released" },
			];
		for (const entry of signals) {
			const { state, result } = applyIdleWaitSignal(waiting, entry.signal, observedAt);
			assert.equal(state.phase, entry.phase, `signal ${entry.signal.type}`);
			if (entry.outcome !== undefined) assert.equal(result?.outcome, entry.outcome);
			else assert.equal(result, undefined);
		}
	});
});

describe("member idle wait result formatting", () => {
	test("formats idle/became-idle result with identity, disposition, and timestamp only", () => {
		const result = createMemberIdleWaitResult(bob, { outcome: "idle", disposition: "became-idle" }, observedAt);
		assert.equal(
			formatMemberIdleWaitResult(result),
			"[Bob (developer)] idle — became-idle at 2026-08-23T12:03:00.000Z",
		);
	});

	test("formats idle/already-idle, offline, and timeout outcomes compactly", () => {
		const already = createMemberIdleWaitResult(bob, { outcome: "idle", disposition: "already-idle" }, observedAt);
		assert.equal(
			formatMemberIdleWaitResult(already),
			"[Bob (developer)] idle — already-idle at 2026-08-23T12:03:00.000Z",
		);
		const offline = createMemberIdleWaitResult(bob, { outcome: "offline" }, observedAt);
		assert.equal(formatMemberIdleWaitResult(offline), "[Bob (developer)] offline at 2026-08-23T12:03:00.000Z");
		const timeout = createMemberIdleWaitResult(bob, { outcome: "timeout" }, observedAt);
		assert.equal(formatMemberIdleWaitResult(timeout), "[Bob (developer)] timeout at 2026-08-23T12:03:00.000Z");
	});

	test("formatter rejects invalid results", () => {
		assert.throws(
			() => formatMemberIdleWaitResult({ member: bob, outcome: "unknown", observedAt } as never),
			TypeError,
		);
	});
});

describe("defensive validation", () => {
	test("register rejects invalid target identity and observation timestamps", () => {
		assert.throws(
			() =>
				registerOneShotIdleWait({ target: { name: "", role: "developer" }, snapshotIsIdle: false, observedAt }),
			TypeError,
		);
		assert.throws(
			() => registerOneShotIdleWait({ target: bob, snapshotIsIdle: false, observedAt: "not-a-timestamp" }),
			TypeError,
		);
	});

	test("result builder rejects invalid member labels and timestamps", () => {
		assert.throws(
			() =>
				createMemberIdleWaitResult(
					{ name: "Bad\nName", role: "developer" },
					{ outcome: "offline" },
					observedAt,
				),
			TypeError,
		);
		assert.throws(() => createMemberIdleWaitResult(bob, { outcome: "offline" }, "yesterday"), TypeError);
	});

	test("signal application rejects invalid observation timestamps", () => {
		assert.throws(() => applyIdleWaitSignal(waiting, { type: "timeout" }, "nope"), TypeError);
	});
});
