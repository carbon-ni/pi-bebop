import assert from "node:assert/strict";
import test from "node:test";
import {
	RequestOutcomeRegistry,
	DEFAULT_MEMBER_REQUEST_TIMEOUT_SECONDS,
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

test("registers before acceptance, starts the default deadline immediately, and cleans pre-accept failures", () => {
	const registry = new RequestOutcomeRegistry();
	const result = request(registry, "request-1");
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.value.deadlineAt, 1_000 + DEFAULT_MEMBER_REQUEST_TIMEOUT_SECONDS * 1_000);
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

test("response wins when resolved first, while idle closes and late response expires", () => {
	const responseFirst = new RequestOutcomeRegistry();
	request(responseFirst, "response-first");
	arm(responseFirst, "response-first");
	assert.equal(
		responseFirst.resolveResponse({ requestId: "response-first", member, message: "done", instructions: [] }).ok,
		true,
	);
	assert.deepEqual(responseFirst.resolveIdle("response-first"), { ok: false, code: "already-terminal" });
	const idleFirst = new RequestOutcomeRegistry();
	request(idleFirst, "idle-first");
	arm(idleFirst, "idle-first");
	assert.equal(idleFirst.resolveIdle("idle-first").ok, true);
	assert.deepEqual(
		idleFirst.resolveResponse({ requestId: "idle-first", member, message: "late", instructions: [] }),
		{ ok: false, code: "response-expired" },
	);
	assert.deepEqual(
		idleFirst.resolveResponse({ requestId: "idle-first", member, message: "replay", instructions: [] }),
		{
			ok: false,
			code: "response-expired",
		},
	);
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

test("inbound response selection defaults only for one request", () => {
	const registry = new RequestOutcomeRegistry();
	assert.deepEqual(registry.selectInbound(), { ok: false, code: "no-pending-request" });
	registry.registerInbound({ requestId: "one", requester: member, message: "m", instructions: [] });
	assert.equal(registry.selectInbound()?.ok, true);
	registry.registerInbound({ requestId: "two", requester: member, message: "m", instructions: [] });
	assert.deepEqual(registry.selectInbound(), { ok: false, code: "ambiguous-request" });
	assert.equal(registry.resolveInboundResponse("one").ok, true);
	assert.equal(registry.resolveInboundResponse("two").ok, true);
	assert.deepEqual(registry.resolveInboundResponse("two"), { ok: false, code: "already-terminal" });
	registry.registerInbound({ requestId: "idle", requester: member, message: "m", instructions: [] });
	registry.acceptInbound("idle");
	registry.armInboundIdle("idle");
	assert.equal(registry.resolveInboundIdle("idle").ok, true);
	assert.deepEqual(registry.selectInbound("idle"), { ok: false, code: "response-expired" });
	assert.deepEqual(registry.resolveInboundResponse("idle"), { ok: false, code: "response-expired" });
});

test("tombstones are bounded while the newest idle late-response recovery remains available", () => {
	const registry = new RequestOutcomeRegistry();
	for (let index = 0; index < MAX_REQUEST_OUTCOME_TOMBSTONES + 1; index += 1) {
		const id = `tombstone-${index}`;
		assert.equal(request(registry, id).ok, true);
		assert.deepEqual(registry.resolveIdle(id), { ok: false, code: "unknown-request" });
		arm(registry, id);
		assert.equal(registry.resolveIdle(id).ok, true);
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
			code: "response-expired",
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
