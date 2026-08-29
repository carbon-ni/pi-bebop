import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { handlerContext, joinedMembership } from "./test-support.ts";
import { handleWaitState } from "./wait-state.ts";
import { BlockingWaitSlot } from "../../domain/index.ts";

const clock = () => {
	let tick = 0;
	return { now: () => new Date(1_700_000_000_000 + tick++ * 1_000).toISOString() };
};

function contextWithSlot(overrides: Partial<Parameters<typeof handlerContext>[0]> = {}) {
	const c = handlerContext();
	c.state.blockingWait = new BlockingWaitSlot(clock());
	c.state.membershipRuntime = { getMembership: () => joinedMembership() } as never;
	c.ctx.isProjectTrusted = () => true;
	return Object.assign(c, overrides);
}

test("wait_state rejects unjoined and untrusted runtimes", async () => {
	const unjoined = handlerContext();
	unjoined.state.blockingWait = new BlockingWaitSlot(clock());
	unjoined.ctx.isProjectTrusted = () => true;
	await handleWaitState({ type: "wait_state", member: "Mary", id: "1" }, unjoined);
	assert.equal((unjoined.responses[0] as { error?: string }).error, "not-joined");

	const untrusted = contextWithSlot();
	untrusted.ctx.isProjectTrusted = () => false;
	await handleWaitState({ type: "wait_state", member: "Mary", id: "2" }, untrusted);
	assert.equal((untrusted.responses[0] as { error?: string }).error, "untrusted");
});

test("wait_state rejects foreign, ambiguous, self, and unknown caller labels", async () => {
	const c = contextWithSlot();
	await handleWaitState({ type: "wait_state", member: "Nobody", id: "1" }, c);
	assert.equal((c.responses[0] as { error?: string }).error, "unknown-member");

	const self = contextWithSlot();
	await handleWaitState({ type: "wait_state", member: "Dave", id: "2" }, self);
	assert.equal((self.responses[0] as { error?: string }).error, "self");

	const outsider = contextWithSlot();
	outsider.state.membershipRuntime = {
		getMembership: () => ({
			...joinedMembership(),
			member: { ...joinedMembership().member, name: "Outsider" },
		}),
	} as never;
	await handleWaitState({ type: "wait_state", member: "Mary", id: "3" }, outsider);
	assert.equal((outsider.responses[0] as { error?: string }).error, "not-a-member");
});

test("wait_state answers a joined trusted peer with a bounded snapshot and one-shot subscription", async () => {
	const c = contextWithSlot();
	await handleWaitState({ type: "wait_state", member: "Mary", id: "9" }, c);
	const data = (c.responses[0] as { data?: unknown }).data as {
		subscriptionId: string;
		snapshot: { member: { name: string }; wait: unknown };
	};
	assert.equal(data.subscriptionId, "test-id");
	assert.deepEqual(data.snapshot, { member: { name: "Dave", role: "dev" }, wait: null });
	assert.equal(c.state.waitStateSubscriptions.length, 1);
});

test("wait_state snapshot exposes an active runtime marker without wait target or content", async () => {
	const c = contextWithSlot();
	assert.equal(c.state.blockingWait.acquire("member-idle").ok, true);
	await handleWaitState({ type: "wait_state", member: "Mary", id: "10" }, c);
	const data = (c.responses[0] as { data?: unknown }).data as {
		snapshot: { wait: { kind: string; observedAt: string } | null };
	};
	assert.equal(data.snapshot.wait?.kind, "member-idle");
	assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(data.snapshot.wait?.observedAt ?? ""));
	assert.equal(JSON.stringify(data).includes("socket"), false);
	assert.equal(JSON.stringify(data).includes("Mary"), false, "caller identity is not echoed into data");
});

test("wait_state subscription fires exactly once on the next transition, then removes itself", async () => {
	const c = contextWithSlot();
	const written: unknown[] = [];
	(c.socket as EventEmitter as { write: (value: string) => void }).write = ((value: string) => {
		written.push(JSON.parse(value));
	}) as never;
	await handleWaitState({ type: "wait_state", member: "Mary", id: "11" }, c);
	assert.equal(written.length, 0, "no notification before a transition");
	assert.equal(c.state.blockingWait.acquire("member-idle").ok, true);
	assert.equal(written.length, 1);
	const notification = written[0] as { method?: string; params?: { subscriptionId: string; snapshot: unknown } };
	assert.equal(notification.method, "member.wait_state");
	assert.equal(notification.params?.subscriptionId, "test-id");
	assert.deepEqual((notification.params?.snapshot as { wait: { kind: string } }).wait, {
		kind: "member-idle",
		observedAt: (notification.params?.snapshot as { wait: { observedAt: string } }).wait.observedAt,
	});
	assert.equal(c.state.waitStateSubscriptions.length, 0, "one-shot subscription consumed");
	// A later transition produces no further notification.
	assert.equal(c.state.blockingWait.release(), true);
	assert.equal(written.length, 1);
});

test("wait_state enforces finite subscription capacity", async () => {
	const c = contextWithSlot();
	for (let i = 0; i < 8; i += 1) {
		const response = await handleWaitState({ type: "wait_state", member: "Mary", id: String(i) }, c);
		void response;
	}
	assert.equal(c.state.waitStateSubscriptions.length, 8);
	await handleWaitState({ type: "wait_state", member: "Mary", id: "9" }, c);
	assert.equal((c.responses[8] as { error?: string }).error, "capacity-exceeded");
});
