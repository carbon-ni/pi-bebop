import assert from "node:assert/strict";
import test from "node:test";
import {
	RequestOutcomeRegistry,
	MEMBER_REQUEST_ACCEPT_DEADLINE_MS,
	DEFAULT_MEMBER_REQUEST_TIMEOUT_SECONDS,
	MAX_MEMBER_REQUEST_OUTBOUND,
	type RequestOutcomeTimeout,
} from "./member-request.ts";

const member = { name: "qa", role: "reviewer" };
const now = 1_000;

function register(
	registry: RequestOutcomeRegistry,
	requestId: string,
	options?: { maxWaitSeconds?: number; timeoutSeconds?: number },
) {
	return registry.registerOutbound({
		requestId,
		member,
		now,
		timeoutSeconds: options?.timeoutSeconds,
		maxWaitSeconds: options?.maxWaitSeconds,
	});
}

test("TASK-0080 A1: acceptance deadline constant is exactly 5000ms", () => {
	assert.equal(MEMBER_REQUEST_ACCEPT_DEADLINE_MS, 5000);
});

test("TASK-0080 A2: timeout_seconds default is 120 (post-idle grace), range 1..600 -> invalid-timeout", () => {
	assert.equal(DEFAULT_MEMBER_REQUEST_TIMEOUT_SECONDS, 120);
	const registry = new RequestOutcomeRegistry();
	for (const timeoutSeconds of [0, -1, 601, 1.5, Number.NaN]) {
		assert.deepEqual(register(registry, `bad-timeout-${String(timeoutSeconds)}`, { timeoutSeconds }), {
			ok: false,
			code: "invalid-timeout",
		});
	}
});

test("TASK-0080 A3: max_wait_seconds default 1800, range 60..7200 and strictly greater than timeout -> invalid-max-wait", () => {
	const registry = new RequestOutcomeRegistry();
	const ok = register(registry, "ok-default");
	assert.equal(ok.ok, true);
	if (ok.ok) assert.equal(ok.value.maxWaitSeconds, 1800);
	for (const maxWaitSeconds of [59, 7201, 1.5, Number.NaN, 120]) {
		const bad = new RequestOutcomeRegistry();
		assert.deepEqual(register(bad, `bad-max-${String(maxWaitSeconds)}`, { timeoutSeconds: 120, maxWaitSeconds }), {
			ok: false,
			code: "invalid-max-wait",
		});
	}
	const withMax = new RequestOutcomeRegistry();
	const accepted = register(withMax, "with-max", { maxWaitSeconds: 600 });
	assert.equal(accepted.ok, true);
	if (accepted.ok) assert.equal(accepted.value.maxWaitSeconds, 600);
});

test("TASK-0080 A4: hard deadline is acceptedAt + max_wait_seconds; default hard deadline is 1000 + 1800_000", () => {
	const registry = new RequestOutcomeRegistry();
	const result = register(registry, "deadline");
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.value.deadlineAt, now + 1800_000);
});

test("TASK-0080 A5: idle is NONTERMINAL - it preserves the slot; response still resolves after idle", () => {
	const registry = new RequestOutcomeRegistry();
	assert.equal(register(registry, "idle-keeps-slot").ok, true);
	assert.equal(registry.acceptOutbound("idle-keeps-slot").ok, true);
	assert.equal(registry.armOutboundIdle("idle-keeps-slot").ok, true);
	// idle-awaiting-response is not a terminal: outbound slot is preserved.
	assert.equal(registry.outboundCount(), 1);
	const responded = registry.resolveResponse({
		requestId: "idle-keeps-slot",
		member,
		message: "answer",
		instructions: [],
	});
	assert.equal(responded.ok, true);
	if (responded.ok) assert.equal(responded.value.kind, "response");
	assert.equal(registry.outboundCount(), 0);
});

test("TASK-0080 A6: timeout carries a reason; hard expiry from any state -> max-wait, grace expiry only after idle -> response-after-idle", () => {
	const registry = new RequestOutcomeRegistry();
	assert.equal(register(registry, "hard-before-idle").ok, true);
	assert.equal(registry.acceptOutbound("hard-before-idle").ok, true);
	const hard = registry.resolveTimeout("hard-before-idle", "max-wait");
	assert.equal(hard.ok, true);
	if (hard.ok) {
		assert.equal(hard.value.kind, "timeout");
		assert.equal((hard.value as RequestOutcomeTimeout).reason, "max-wait");
	}
	// Grace expiry before idle arming is impossible (idleArmed gate) and never
	// yields a response-after-idle outcome without a real idle first.
	const gated = new RequestOutcomeRegistry();
	assert.equal(register(gated, "grace-gated").ok, true);
	assert.equal(gated.acceptOutbound("grace-gated").ok, true);
	assert.equal(gated.armOutboundIdle("grace-gated").ok, true);
	const grace = gated.resolveTimeout("grace-gated", "response-after-idle");
	assert.equal(grace.ok, true);
	if (grace.ok) {
		assert.equal(grace.value.kind, "timeout");
		assert.equal((grace.value as RequestOutcomeTimeout).reason, "response-after-idle");
	}
});

test("TASK-0080 A7: first terminal wins atomically; later transitions are rejected", () => {
	const registry = new RequestOutcomeRegistry();
	assert.equal(register(registry, "atomic").ok, true);
	assert.equal(registry.acceptOutbound("atomic").ok, true);
	assert.equal(registry.resolveOffline("atomic").ok, true);
	assert.deepEqual(registry.resolveTimeout("atomic", "max-wait"), { ok: false, code: "already-terminal" });
	assert.deepEqual(registry.resolveResponse({ requestId: "atomic", member, message: "late", instructions: [] }), {
		ok: false,
		code: "already-terminal",
	});
});

test("TASK-0080 A8: response after offline in the same logical handler wins (registry keeps first claim; flow enforces precedence)", () => {
	const registry = new RequestOutcomeRegistry();
	assert.equal(register(registry, "precedence").ok, true);
	assert.equal(registry.acceptOutbound("precedence").ok, true);
	const offline = registry.resolveOffline("precedence");
	assert.equal(offline.ok, true);
	// The flow must attempt response BEFORE offline in one handler; the
	// registry's second claim (offline) is rejected as already-terminal.
	assert.deepEqual(
		registry.resolveResponse({ requestId: "precedence", member, message: "answer", instructions: [] }),
		{ ok: false, code: "already-terminal" },
	);
});

test("TASK-0080 A9: capacity gates unchanged under the new registration shape", () => {
	const registry = new RequestOutcomeRegistry();
	for (let index = 0; index < MAX_MEMBER_REQUEST_OUTBOUND; index += 1)
		assert.equal(register(registry, `out-${index}`).ok, true);
	assert.deepEqual(register(registry, "out-overflow"), { ok: false, code: "outbound-capacity" });
});
