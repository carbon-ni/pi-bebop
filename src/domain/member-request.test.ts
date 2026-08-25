import assert from "node:assert/strict";
import test from "node:test";
import {
	RequestOutcomeRegistry,
	DEFAULT_MEMBER_REQUEST_TIMEOUT_SECONDS,
	DEFAULT_MEMBER_REQUEST_MAX_WAIT_SECONDS,
	MAX_MEMBER_REQUEST_BUFFERED,
	MAX_MEMBER_REQUEST_INBOUND,
	MAX_MEMBER_REQUEST_OUTBOUND,
	MAX_REQUEST_ID_BYTES,
	MAX_REQUEST_OUTCOME_TOMBSTONES,
} from "./member-request.ts";

const member = { name: "qa", role: "reviewer" };
const request = (registry: RequestOutcomeRegistry, requestId: string, now = 1_000) =>
	registry.registerOutbound({ requestId, member, now });
function arm(registry: RequestOutcomeRegistry, requestId: string): void {
	assert.equal(registry.acceptOutbound(requestId).ok, true);
	assert.equal(registry.armOutboundIdle(requestId).ok, true);
}

test("registers before acceptance, starts the hard deadline immediately, and cleans pre-accept failures", () => {
	const registry = new RequestOutcomeRegistry();
	const result = request(registry, "request-1");
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.value.deadlineAt, 1_000 + DEFAULT_MEMBER_REQUEST_MAX_WAIT_SECONDS * 1_000);
	assert.equal(registry.failBeforeAcceptance("request-1").ok, true);
	assert.equal(request(registry, "request-1").ok, true);
	assert.equal(registry.outboundCount(), 1);
	for (const timeoutSeconds of [0, -1, 601, 1.5, Number.NaN]) {
		const invalid = new RequestOutcomeRegistry();
		assert.deepEqual(
			invalid.registerOutbound({
				requestId: `bad-${String(timeoutSeconds)}`,
				member,
				now: 1_000,
				timeoutSeconds,
			}),
			{
				ok: false,
				code: "invalid-timeout",
			},
		);
		assert.equal(invalid.outboundCount(), 0);
	}
	for (const maxWaitSeconds of [59, 7201, 120, 1.5, Number.NaN]) {
		const invalid = new RequestOutcomeRegistry();
		assert.deepEqual(
			invalid.registerOutbound({
				requestId: `bad-max-${String(maxWaitSeconds)}`,
				member,
				now: 1_000,
				timeoutSeconds: 120,
				maxWaitSeconds,
			}),
			{
				ok: false,
				code: "invalid-max-wait",
			},
		);
		assert.equal(invalid.outboundCount(), 0);
	}
});

test("enforces outbound/inbound capacities and the UTF-8 request id bound before mutation", () => {
	const outbound = new RequestOutcomeRegistry();
	for (let index = 0; index < MAX_MEMBER_REQUEST_OUTBOUND; index += 1)
		assert.equal(request(outbound, `out-${index}`).ok, true);
	assert.deepEqual(request(outbound, "out-overflow"), { ok: false, code: "outbound-capacity" });
	assert.deepEqual(request(new RequestOutcomeRegistry(), "😀".repeat(MAX_REQUEST_ID_BYTES)), {
		ok: false,
		code: "invalid-request-id",
	});
	const inbound = new RequestOutcomeRegistry();
	for (let index = 0; index < MAX_MEMBER_REQUEST_INBOUND; index += 1)
		assert.equal(
			inbound.registerInbound({ requestId: `in-${index}`, requester: member, message: "m", instructions: [] }).ok,
			true,
		);
	assert.deepEqual(
		inbound.registerInbound({ requestId: "in-overflow", requester: member, message: "m", instructions: [] }),
		{
			ok: false,
			code: "inbound-capacity",
		},
	);
});

test("TASK-0080: pre-request/pre-context idle never resolves an outbound or inbound request; idle is nonterminal", () => {
	const registry = new RequestOutcomeRegistry();
	// Outbound: idle arming before registration, acceptance is ignored.
	assert.deepEqual(registry.armOutboundIdle("none", 1_000), { ok: false, code: "unknown-request" });
	assert.equal(request(registry, "out-1").ok, true);
	assert.deepEqual(registry.armOutboundIdle("out-1", 1_000), { ok: false, code: "unknown-request" });
	assert.equal(registry.acceptOutbound("out-1").ok, true);
	assert.equal(registry.armOutboundIdle("out-1", 1_000).ok, true);
	// Idle preserves the slot: the request stays pending (nonterminal).
	assert.equal(registry.outboundCount(), 1);
	// Inbound: idle arming before registration or acceptance is ignored; after
	// acceptance it preserves the inbound slot.
	assert.deepEqual(registry.armInboundIdleNow("in-1", 1_000), { ok: false, code: "unknown-request" });
	assert.equal(
		registry.registerInbound({ requestId: "in-1", requester: member, message: "m", instructions: [] }).ok,
		true,
	);
	assert.deepEqual(registry.armInboundIdleNow("in-1", 1_000), { ok: false, code: "unknown-request" });
	assert.equal(registry.acceptInbound("in-1").ok, true);
	assert.equal(registry.armInboundIdleNow("in-1", 1_000).ok, true);
	assert.equal(registry.inboundCount(), 1);
});

test("response wins when resolved first; idle is nonterminal so a response after idle still works", () => {
	const responseFirst = new RequestOutcomeRegistry();
	request(responseFirst, "response-first");
	arm(responseFirst, "response-first");
	assert.equal(
		responseFirst.resolveResponse({ requestId: "response-first", member, message: "done", instructions: [] }).ok,
		true,
	);
	assert.deepEqual(responseFirst.resolveOffline("response-first"), { ok: false, code: "already-terminal" });
	assert.deepEqual(responseFirst.resolveTimeout("response-first", "max-wait"), {
		ok: false,
		code: "already-terminal",
	});
	const idleFirst = new RequestOutcomeRegistry();
	request(idleFirst, "idle-first");
	arm(idleFirst, "idle-first");
	// Idle is NONTERMINAL: the response during the post-idle grace wins.
	assert.equal(
		idleFirst.resolveResponse({ requestId: "idle-first", member, message: "late", instructions: [] }).ok,
		true,
	);
	assert.deepEqual(
		idleFirst.resolveResponse({ requestId: "idle-first", member, message: "replay", instructions: [] }),
		{
			ok: false,
			code: "already-terminal",
		},
	);
});

test("hasPendingOutcome covers pending outbound and buffered terminal updates", () => {
	const registry = new RequestOutcomeRegistry();
	assert.equal(registry.hasPendingOutcome(), false, "empty registry has nothing pending");
	request(registry, "pending-1");
	assert.equal(registry.hasPendingOutcome(), true, "pending outbound request counts");
	assert.equal(registry.resolveTimeout("pending-1", "max-wait").ok, true);
	assert.equal(registry.hasPendingOutcome(), true, "terminal update buffered until consumed");
	const update = registry.waitForUpdate(() => undefined);
	assert.equal(update.ok, true);
	assert.equal(registry.hasPendingOutcome(), false, "buffered update consumed");
});

test("wait has one waiter, cancellation preserves state, and terminal updates are consumed once", () => {
	const registry = new RequestOutcomeRegistry();
	request(registry, "waiting-1");
	const first = registry.waitForUpdate(() => undefined);
	assert.equal(first.ok, true);
	assert.equal(registry.waitForUpdate(() => undefined).ok, false);
	if (first.ok && first.kind === "waiting") first.cancel();
	// The current waiter is cancelled; no buffered update is lost by cancellation.
	const updates: string[] = [];
	request(registry, "terminal-1");
	assert.equal(registry.resolveTimeout("terminal-1").ok, true);
	const immediate = registry.waitForUpdate((update) => updates.push(update.requestId));
	assert.equal(immediate.ok, true);
	if (immediate.ok) assert.equal(immediate.kind, "update");
	assert.deepEqual(updates, []);
	assert.equal(registry.waitForUpdate((update) => updates.push(update.requestId)).ok, true);
	request(registry, "terminal-2");
	assert.equal(registry.resolveOffline("terminal-2").ok, true);
	assert.deepEqual(updates, ["terminal-2"]);
});

test("inbound response selection defaults only for one request; idle preserves the pending selection", () => {
	const registry = new RequestOutcomeRegistry();
	assert.deepEqual(registry.selectInbound(), { ok: false, code: "no-pending-request" });
	registry.registerInbound({ requestId: "one", requester: member, message: "m", instructions: [] });
	assert.equal(registry.selectInbound()?.ok, true);
	registry.registerInbound({ requestId: "two", requester: member, message: "m", instructions: [] });
	assert.deepEqual(registry.selectInbound(), { ok: false, code: "ambiguous-request" });
	assert.equal(registry.resolveInboundResponse("one").ok, true);
	assert.equal(registry.resolveInboundResponse("two").ok, true);
	assert.deepEqual(registry.resolveInboundResponse("two"), { ok: false, code: "already-terminal" });
	// TASK-0080: inbound idle is NONTERMINAL - the request stays selectable and
	// a Response remains possible after the idle notification.
	registry.registerInbound({ requestId: "idle", requester: member, message: "m", instructions: [] });
	registry.acceptInbound("idle");
	assert.equal(registry.armInboundIdleNow("idle", 1_000).ok, true);
	assert.equal(registry.selectInbound("idle")?.ok, true);
	assert.equal(registry.resolveInboundResponse("idle").ok, true);
});

test("tombstones are bounded while the newest terminal late-response recovery remains available", () => {
	const registry = new RequestOutcomeRegistry();
	for (let index = 0; index < MAX_REQUEST_OUTCOME_TOMBSTONES + 1; index += 1) {
		const id = `tombstone-${index}`;
		assert.equal(request(registry, id).ok, true);
		arm(registry, id);
		assert.equal(registry.resolveTimeout(id, "response-after-idle").ok, true);
		assert.equal(registry.waitForUpdate(() => undefined).ok, true);
	}
	assert.deepEqual(
		registry.resolveResponse({ requestId: "tombstone-0", member, message: "late", instructions: [] }),
		{
			ok: false,
			code: "unknown-request",
		},
	);
	assert.deepEqual(
		registry.resolveResponse({
			requestId: `tombstone-${MAX_REQUEST_OUTCOME_TOMBSTONES}`,
			member,
			message: "late",
			instructions: [],
		}),
		{
			ok: false,
			code: "already-terminal",
		},
	);
});

test("buffer capacity is reserved by active requests and rejects before delivery", () => {
	const registry = new RequestOutcomeRegistry();
	for (let index = 0; index < MAX_MEMBER_REQUEST_BUFFERED; index += 1) {
		const id = `buffer-${index}`;
		assert.equal(request(registry, id).ok, true);
		assert.equal(registry.resolveTimeout(id).ok, true);
	}
	assert.equal(registry.bufferedCount(), MAX_MEMBER_REQUEST_BUFFERED);
	assert.deepEqual(request(registry, "buffer-overflow"), { ok: false, code: "buffer-capacity" });
	const next = registry.waitForUpdate(() => undefined);
	assert.equal(next.ok, true);
	assert.equal(registry.bufferedCount(), MAX_MEMBER_REQUEST_BUFFERED - 1);
});
