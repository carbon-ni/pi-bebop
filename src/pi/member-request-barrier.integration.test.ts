import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { MemberRequestFlow } from "../application/member-request-flow.ts";
import { sendMemberRequest } from "../infra/rpc-client.ts";
import { resolveMemberEndpoint } from "../infra/socket-endpoint.ts";
import { createRpcServer, closeRpcServer } from "../infra/rpc-server.ts";
import { createSocketState, emitIdleSettled, handleCommand } from "./control-runtime.ts";

/**
 * TASK-0080 Phase 4 barrier matrix (real two-runtime, no wall-clock sleeps;
 * grace windows use real 1s timeouts where the contract allows).
 *
 * G1 (same-handler response > offline), G2 (hard truncates late grace),
 * G3 (post-idle grace expiry) are proven deterministically by the fake-clock
 * flow contract tests (C4/C5) and the real grace-expiry integration test in
 * member-request-outcome.integration.test.ts. This file proves the real-socket
 * barriers that need both runtimes: pre-request idle never arms (G4), reminder
 * once + inert (G5), nonterminal parked slot with response during grace (G6),
 * and mutual idle waits + nested requests resolve without deadlock (G11).
 */

function joinedMembership(
	member: { name: string; role: string; socketPath: string },
	others: Array<{ name: string; role: string; socketPath: string }>,
) {
	return {
		manifestPath: "/project/.pi/bebop/crew.json",
		socketPath: member.socketPath,
		member,
		manifest: { members: [member, ...others] },
	};
}

async function targetRuntime(
	t: test.TestContext,
	root: string,
	self: { name: string; role: string; socketPath: string },
	other: { name: string; role: string; socketPath: string },
	onFirstIdleReminder?: (requestId: string, requester: { name: string; role: string }) => void,
) {
	const state = createSocketState();
	state.membershipRuntime = {
		getMembership: () => joinedMembership(self, [other]),
	} as never;
	state.context = {
		hasUI: false,
		sessionManager: { getSessionId: () => self.name, getSessionName: () => null, getEntries: () => [] },
		isIdle: () => true,
		isProjectTrusted: () => true,
	} as never;
	const reminders: string[] = [];
	state.memberRequestFlow = new MemberRequestFlow({
		transport: {
			open: async () => ({ close: () => undefined }),
			respond: async () => undefined,
		},
		resolveEndpoint: resolveMemberEndpoint,
		onFirstIdleReminder: (requestId, requester) => {
			reminders.push(`${requestId}:${requester.name}`);
			onFirstIdleReminder?.(requestId, requester);
		},
	});
	const server = await createRpcServer(self.socketPath, (command, socket) =>
		handleCommand(
			{
				sendMessage: () => undefined,
			} as never,
			state,
			command,
			socket,
		),
	);
	t.after(async () => {
		await closeRpcServer(server);
	});
	return { state, reminders };
}

function sourceFlow(now: () => number) {
	return new MemberRequestFlow({
		transport: {
			open: (endpoint, command, options) =>
				sendMemberRequest(endpoint, command, {
					timeout: options.timeoutMs,
					signal: options.signal,
					onUpdate: options.onUpdate,
				}),
			respond: async (channel, update) => channel.send(update),
		},
		resolveEndpoint: resolveMemberEndpoint,
		now,
		createRequestId: () => "request-real",
		// Real 1s grace; the hard timer is cleared at the terminal.
		setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
		clearTimeout: (handle) => clearTimeout(handle),
	});
}

function waitOutcome(flow: MemberRequestFlow): Promise<unknown> {
	return new Promise((resolve) => {
		const result = flow.waitForRequestOutcome((update) => resolve(update));
		assert.equal(result.ok, true);
		if (result.ok) assert.equal(result.kind, "waiting");
	});
}

async function untilIdleArmed(flow: MemberRequestFlow, requestId: string): Promise<void> {
	const deadline = new Promise<never>((_, reject) => {
		const handle = setTimeout(() => reject(new Error("idle never armed the source grace")), 3_000);
		void handle;
	});
	await Promise.race([
		(async () => {
			for (;;) {
				if (flow.registry.getOutbound(requestId)?.idleArmed) return;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		})(),
		deadline,
	]);
}

test("TASK-0080 G4: pre-request idle never arms grace; first post-context idle arms once; later settles do not reset it", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-g4-"));
	const targetPath = path.join(root, "target.sock");
	const sourcePath = path.join(root, "source.sock");
	const target = await targetRuntime(
		t,
		root,
		{ name: "Kelly", role: "qa", socketPath: targetPath },
		{ name: "Tony", role: "lead", socketPath: sourcePath },
	);
	const flow = sourceFlow(() => 1_000);
	const sourceMembership = joinedMembership({ name: "Tony", role: "lead", socketPath: sourcePath }, [
		{ name: "Kelly", role: "qa", socketPath: targetPath },
	]);
	// A settle BEFORE the request exists must not arm anything (no inbound yet).
	emitIdleSettled(target.state, { isIdle: () => true } as never);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(flow.registry.getOutbound("request-real")?.idleArmed, undefined);
	// Real request + first post-context idle arms the grace once.
	await flow.sendMemberRequest({
		membership: sourceMembership,
		member: "Kelly",
		message: "Deliver",
		timeoutSeconds: 1,
	});
	emitIdleSettled(target.state, { isIdle: () => true } as never);
	await untilIdleArmed(flow, "request-real");
	assert.equal(flow.registry.outboundCount(), 1, "idle is nonterminal");
	// A later settle does not reset the grace: the terminal still arrives at the
	// original grace deadline (1s from the FIRST idle).
	await new Promise((resolve) => setTimeout(resolve, 300));
	emitIdleSettled(target.state, { isIdle: () => true } as never);
	const update = await waitOutcome(flow);
	assert.deepEqual(update, {
		kind: "timeout",
		requestId: "request-real",
		member: { name: "Kelly", role: "qa" },
		reason: "response-after-idle",
	});
	await fs.rm(root, { recursive: true, force: true });
});

test("TASK-0080 G5: reminder queued exactly once with the original requestId; inbound slot preserved (inert under terminal)", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-g5-"));
	const targetPath = path.join(root, "target.sock");
	const sourcePath = path.join(root, "source.sock");
	const target = await targetRuntime(
		t,
		root,
		{ name: "Kelly", role: "qa", socketPath: targetPath },
		{ name: "Tony", role: "lead", socketPath: sourcePath },
	);
	const flow = sourceFlow(() => 1_000);
	const sourceMembership = joinedMembership({ name: "Tony", role: "lead", socketPath: sourcePath }, [
		{ name: "Kelly", role: "qa", socketPath: targetPath },
	]);
	await flow.sendMemberRequest({
		membership: sourceMembership,
		member: "Kelly",
		message: "Deliver",
		timeoutSeconds: 1,
	});
	emitIdleSettled(target.state, { isIdle: () => true } as never);
	await untilIdleArmed(flow, "request-real");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(target.reminders, ["request-real:Tony"], "exactly one reminder with the original requestId");
	assert.equal(target.state.memberRequestFlow!.registry.inboundCount(), 1, "idle preserves the inbound slot");
	// A second settle does not queue a second reminder.
	emitIdleSettled(target.state, { isIdle: () => true } as never);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(target.reminders, ["request-real:Tony"]);
	// Terminal (grace) arrives; the already-queued reminder is inert: it never
	// resolves or alters the Request outcome.
	const update = await waitOutcome(flow);
	assert.deepEqual(update, {
		kind: "timeout",
		requestId: "request-real",
		member: { name: "Kelly", role: "qa" },
		reason: "response-after-idle",
	});
	await fs.rm(root, { recursive: true, force: true });
});

test("TASK-0080 G6: parked outbound slot survives idle; a Response during the post-idle grace resolves the wait", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-g6-"));
	const targetPath = path.join(root, "target.sock");
	const sourcePath = path.join(root, "source.sock");
	const target = await targetRuntime(
		t,
		root,
		{ name: "Kelly", role: "qa", socketPath: targetPath },
		{ name: "Tony", role: "lead", socketPath: sourcePath },
	);
	const flow = sourceFlow(() => 1_000);
	const sourceMembership = joinedMembership({ name: "Tony", role: "lead", socketPath: sourcePath }, [
		{ name: "Kelly", role: "qa", socketPath: targetPath },
	]);
	await flow.sendMemberRequest({
		membership: sourceMembership,
		member: "Kelly",
		message: "Deliver",
		timeoutSeconds: 60,
	});
	emitIdleSettled(target.state, { isIdle: () => true } as never);
	await untilIdleArmed(flow, "request-real");
	assert.equal(flow.registry.outboundCount(), 1, "outbound slot is preserved through idle");
	// The responder answers during the grace window.
	const pending = waitOutcome(flow);
	const inbound = target.state.memberRequestFlow!.registry.selectInbound("request-real");
	assert.equal(inbound.ok, true);
	if (inbound.ok) {
		await target.state.memberRequestFlow!.respondToMemberRequest({
			message: "done",
			requestId: "request-real",
			member: { name: "Kelly", role: "qa" },
		});
	}
	const update = await pending;
	assert.deepEqual(update, {
		kind: "response",
		requestId: "request-real",
		member: { name: "Kelly", role: "qa" },
		message: "done",
		instructions: [],
	});
	assert.equal(flow.registry.outboundCount(), 0);
	await fs.rm(root, { recursive: true, force: true });
});

test("TASK-0080 G11: mutual idle waits and nested Member requests resolve without blocking tool promises", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-g11-"));
	const aPath = path.join(root, "a.sock");
	const bPath = path.join(root, "b.sock");
	// A -> B and B -> A (mutual/nested requests).
	const a = await targetRuntime(
		t,
		root,
		{ name: "Tony", role: "lead", socketPath: aPath },
		{ name: "Kelly", role: "qa", socketPath: bPath },
	);
	const b = await targetRuntime(
		t,
		root,
		{ name: "Kelly", role: "qa", socketPath: bPath },
		{ name: "Tony", role: "lead", socketPath: aPath },
	);
	const flowA = sourceFlow(() => 1_000);
	const flowB = sourceFlow(() => 2_000);
	// Dispatch both ways through the real channels.
	const membershipA = joinedMembership({ name: "Tony", role: "lead", socketPath: aPath }, [
		{ name: "Kelly", role: "qa", socketPath: bPath },
	]);
	const membershipB = joinedMembership({ name: "Kelly", role: "qa", socketPath: bPath }, [
		{ name: "Tony", role: "lead", socketPath: aPath },
	]);
	const sentA = flowA.sendMemberRequest({
		membership: membershipA,
		member: "Kelly",
		message: "A asks B",
		timeoutSeconds: 60,
	});
	const sentB = flowB.sendMemberRequest({
		membership: membershipB,
		member: "Tony",
		message: "B asks A",
		timeoutSeconds: 60,
	});
	const [acceptedA, acceptedB] = await Promise.all([sentA, sentB]);
	assert.equal(acceptedA.requestId, "request-real");
	assert.equal(acceptedB.requestId, "request-real");
	// Both sides reach idle without answering: both arm their grace (no deadlock).
	emitIdleSettled(a.state, { isIdle: () => true } as never);
	emitIdleSettled(b.state, { isIdle: () => true } as never);
	await untilIdleArmed(flowA, "request-real");
	await untilIdleArmed(flowB, "request-real");
	assert.equal(flowA.registry.outboundCount(), 1);
	assert.equal(flowB.registry.outboundCount(), 1);
	// Both sides answer each other's inbound request during the grace window.
	const pendingA = waitOutcome(flowA);
	const pendingB = waitOutcome(flowB);
	await a.state.memberRequestFlow!.respondToMemberRequest({
		message: "A answers B",
		requestId: "request-real",
		member: { name: "Tony", role: "lead" },
	});
	await b.state.memberRequestFlow!.respondToMemberRequest({
		message: "B answers A",
		requestId: "request-real",
		member: { name: "Kelly", role: "qa" },
	});
	const [updateA, updateB] = await Promise.all([pendingA, pendingB]);
	assert.deepEqual(updateA, {
		kind: "response",
		requestId: "request-real",
		member: { name: "Kelly", role: "qa" },
		message: "B answers A",
		instructions: [],
	});
	assert.deepEqual(updateB, {
		kind: "response",
		requestId: "request-real",
		member: { name: "Tony", role: "lead" },
		message: "A answers B",
		instructions: [],
	});
	assert.equal(flowA.registry.outboundCount(), 0);
	assert.equal(flowB.registry.outboundCount(), 0);
	await fs.rm(root, { recursive: true, force: true });
});
