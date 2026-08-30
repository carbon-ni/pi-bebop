import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { MemberRequestFlow } from "../application/member-request-flow.ts";
import { sendMemberRequest, sendRpcCommand } from "../infra/rpc-client.ts";
import { resolveMemberEndpoint } from "../infra/socket-endpoint.ts";
import { createRpcServer, closeRpcServer } from "../infra/rpc-server.ts";
import { createSocketState, emitIdleSettled, handleCommand } from "./control-runtime.ts";
import { isMessagePayload, YieldingWaitRegistry } from "../domain/index.ts";
import { YieldingWaitRuntime } from "./wait-resume.ts";
import { registerWaitForRequestOutcomeTool } from "../tools/member-request.ts";

/**
 * TASK-0076 affordance integration: real two runtimes over Unix sockets.
 *
 * Happy path: requester sends a Member request; the responder's model context
 * visibly carries the bounded `[member request]` marker + Request ID +
 * respond instruction; the responder sends one correlated Response; the
 * requester alone receives the response outcome.
 *
 * Negative path: an ordinary Follow-up renders with the `[follow-up]` marker
 * (no correlated Response expected), creates zero request state on the target,
 * and the sender's request-outcome wait fails immediately — message content is
 * never heuristically parsed or upgraded.
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
	targetPath: string,
	requesterPath: string,
): Promise<{
	state: ReturnType<typeof createSocketState>;
	acceptedIntoContext: Array<{ message: unknown; options: unknown }>;
	server: Awaited<ReturnType<typeof createRpcServer>>;
}> {
	const state = createSocketState();
	state.membershipRuntime = {
		getMembership: () =>
			joinedMembership({ name: "Kelly", role: "qa", socketPath: targetPath }, [
				{ name: "Tony", role: "lead", socketPath: requesterPath },
			]),
	} as never;
	state.context = {
		hasUI: false,
		sessionManager: { getSessionId: () => "target", getSessionName: () => null, getEntries: () => [] },
		isIdle: () => false,
		isProjectTrusted: () => true,
	} as never;
	const acceptedIntoContext: Array<{ message: unknown; options: unknown }> = [];
	const pi = {
		sendMessage: (message: unknown, options: unknown) => {
			acceptedIntoContext.push({ message, options });
		},
	} as never;
	state.memberRequestFlow = new MemberRequestFlow({
		transport: {
			open: async () => ({ close: () => undefined }),
			respond: async () => undefined,
		},
		resolveEndpoint: resolveMemberEndpoint,
	});
	const server = await createRpcServer(targetPath, (command, socket) => handleCommand(pi, state, command, socket));
	return { state, acceptedIntoContext, server };
}

function waitForOutcome(flow: MemberRequestFlow): Promise<unknown> {
	return new Promise((resolve) => {
		const result = flow.waitForRequestOutcome((update) => resolve(update));
		assert.equal(result.ok, true);
		if (result.ok) assert.equal(result.kind, "waiting");
	});
}

function within<T>(ms: number, promise: Promise<T>, message: string): Promise<T> {
	let handle: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		handle = setTimeout(() => reject(new Error(message)), ms);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(handle));
}

class DeterministicClock {
	private current = 0;
	private readonly timers: Array<{ at: number; callback: () => void; cancelled: boolean }> = [];

	now = (): number => this.current;

	setTimeout = (callback: () => void, delayMs: number) => {
		const timer = { at: this.current + delayMs, callback, cancelled: false };
		this.timers.push(timer);
		return timer as unknown as ReturnType<typeof globalThis.setTimeout>;
	};

	clearTimeout = (handle: ReturnType<typeof globalThis.setTimeout>) => {
		(handle as unknown as { cancelled: boolean }).cancelled = true;
	};

	advance(ms: number): void {
		this.current += ms;
		for (;;) {
			const next = this.timers
				.filter((timer) => !timer.cancelled && timer.at <= this.current)
				.sort((left, right) => left.at - right.at)[0];
			if (!next) return;
			next.cancelled = true;
			next.callback();
		}
	}
}

function nextTurn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

async function until(condition: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (condition()) return;
		await nextTurn();
	}
	throw new Error(message);
}

test("TASK-0076 happy: requester sends, responder sees the request marker, responder responds, requester alone receives outcome", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-request-affordance-"));
	const targetPath = path.join(root, "target.sock");
	const requesterPath = path.join(root, "requester.sock");
	try {
		const target = await targetRuntime(targetPath, requesterPath);
		t.after(async () => {
			await closeRpcServer(target.server);
		});

		const requesterMembership = joinedMembership({ name: "Tony", role: "lead", socketPath: requesterPath }, [
			{ name: "Kelly", role: "qa", socketPath: targetPath },
		]);
		const requesterFlow = new MemberRequestFlow({
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
			createRequestId: () => "request-afford-1",
		});

		const accepted = await requesterFlow.sendMemberRequest({
			membership: requesterMembership,
			member: "Kelly",
			message: "Please QA the TASK-0076 changes and report a verdict",
		});
		assert.equal(accepted.requestId, "request-afford-1");

		// Responder's model context structurally carries the request marker.
		const inbound = target.acceptedIntoContext[0]!.message as { content: string; details?: unknown };
		assert.match(inbound.content, /^\[member request\]/);
		assert.match(inbound.content, /request-afford-1/);
		assert.match(inbound.content, /respond_to_member_request/);
		const payload = (inbound.details as { messagePayload?: unknown }).messagePayload;
		assert.equal(isMessagePayload(payload), true);
		assert.match(inbound.content, /Please QA the TASK-0076 changes and report a verdict/);

		// Requester waits; responder sends one correlated Response.
		const pending = waitForOutcome(requesterFlow);
		await target.state.memberRequestFlow!.respondToMemberRequest({
			message: "QA verdict: approved, coverage 96.8% and gate green",
			member: { name: "Kelly", role: "qa" },
		});
		const update = await within(2_000, pending, "requester did not receive the correlated Response");
		assert.deepEqual(update, {
			kind: "response",
			requestId: "request-afford-1",
			member: { name: "Kelly", role: "qa" },
			message: "QA verdict: approved, coverage 96.8% and gate green",
			instructions: [],
		});
		// Terminal exactly once; the requester alone received it.
		assert.deepEqual(
			requesterFlow.waitForRequestOutcome(() => undefined),
			{
				ok: false,
				code: "no-pending-requests",
			},
		);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("TASK-0144 acceptance: two real runtimes preserve independent triggers through reminder, Follow-up, Response, and all-settled", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-request-loop-"));
	const targetPath = path.join(root, "target.sock");
	const requesterPath = path.join(root, "requester.sock");
	const target = await targetRuntime(targetPath, requesterPath);
	const clock = new DeterministicClock();
	const requesterState = createSocketState();
	requesterState.membershipRuntime = {
		getMembership: () =>
			joinedMembership(
				{ name: "Tony", role: "lead", socketPath: requesterPath },
				[{ name: "Kelly", role: "qa", socketPath: targetPath }],
			),
	} as never;
	requesterState.context = {
		hasUI: false,
		sessionManager: { getSessionId: () => "requester", getSessionName: () => null, getEntries: () => [] },
		isIdle: () => true,
		isProjectTrusted: () => true,
	} as never;
	const delivered: Array<{ content: string; deliverAs: string }> = [];
	const requesterRuntime = new YieldingWaitRuntime({
		registry: new YieldingWaitRegistry(),
		deliver: (message) => delivered.push({ content: message.content, deliverAs: message.deliverAs }),
		isRunIdle: () => true,
		now: clock.now,
		createId: () => `wait-${delivered.length + 1}`,
	});
	const requestIds = ["request-a", "request-b", "request-c"];
	requesterState.memberRequestFlow = new MemberRequestFlow({
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
		now: clock.now,
		createRequestId: () => requestIds.shift()!,
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		onRequesterReminder: (reminders, parked) => {
			if (!parked) requesterRuntime.deliverReminders(reminders);
		},
	});
	const requesterServer = await createRpcServer(requesterPath, (command, socket) =>
		handleCommand(
			{ sendMessage: () => undefined } as never,
			requesterState,
			command,
			socket,
		),
	);
	t.after(async () => {
		await closeRpcServer(requesterServer);
		await closeRpcServer(target.server);
		await fs.rm(root, { recursive: true, force: true });
	});
	const membership = joinedMembership(
		{ name: "Tony", role: "lead", socketPath: requesterPath },
		[{ name: "Kelly", role: "qa", socketPath: targetPath }],
	);
	const flow = requesterState.memberRequestFlow;
	assert.ok(flow);
	await Promise.all([
		flow.sendMemberRequest({ membership, member: "Kelly", message: "A: compile the release evidence", maxWaitSeconds: 600 }),
		flow.sendMemberRequest({ membership, member: "Kelly", message: "B: check the docs link", maxWaitSeconds: 600 }),
	]);
	assert.equal(flow.registry.outboundCount(), 2);
	assert.equal(target.state.memberRequestFlow!.registry.inboundCount(), 2);

	const armWait = () => {
		const parked = requesterRuntime.park({ kind: "request-outcome", target: "request", sessionId: "requester" });
		assert.equal(parked.ok, true);
		const deliverOutcome = (update: any) => {
			requesterRuntime.resolve({
				kind: "request-outcome",
				target: update.requestId,
				outcome: update.kind === "response" ? "response" : update.kind,
				observedAt: clock.now(),
				pending_count: flow.pendingRequestCount(),
				...(update.kind === "response"
					? { response: { message: update.message, instructions: update.instructions } }
					: update.kind === "still-pending"
						? { reminder: { member: update.member, ageSeconds: update.ageSeconds } }
						: {}),
			});
		};
		const waiting = flow.waitForRequestOutcome(deliverOutcome);
		assert.equal(waiting.ok, true);
		if (waiting.ok && waiting.kind === "update") {
			deliverOutcome(waiting.update);
			armWait();
		}
	};

	// B terminates first; only B's reminder is cancelled.
	armWait();
	await target.state.memberRequestFlow!.respondToMemberRequest({
		requestId: "request-b",
		member: { name: "Kelly", role: "qa" },
		message: "B complete",
	});
	await until(() => flow.registry.outboundCount() === 1, "B response did not settle the B Request");
	clock.advance(180_000);
	const reminders = delivered.filter((message) => message.content.startsWith("[request reminder]"));
	assert.equal(reminders.length, 1);
	assert.match(reminders[0]!.content, /request-a/);
	assert.doesNotMatch(reminders[0]!.content, /request-b/);
	assert.match(reminders[0]!.content, /180s/);

	// An ordinary Follow-up is unrelated to A and does not change its slot.
	const followUp = await sendRpcCommand(targetPath, {
		type: "send",
		payload: { content: "FYI only", origin: { kind: "crew", name: "Tony", role: "lead" } },
		delivery: "follow_up",
	});
	assert.equal(followUp.response.success, true);
	assert.equal(flow.registry.outboundCount(), 1);
	assert.equal(target.state.memberRequestFlow!.registry.inboundCount(), 1);

	// A responds after its reminder, then a fresh wait observes all-settled.
	armWait();
	await target.state.memberRequestFlow!.respondToMemberRequest({
		requestId: "request-a",
		member: { name: "Kelly", role: "qa" },
		message: "A complete",
	});
	await until(() => flow.registry.outboundCount() === 0, "A response did not settle the A Request");
	const tools = new Map<string, any>();
	registerWaitForRequestOutcomeTool(
		{ registerTool: (tool: any) => tools.set(tool.name, tool) } as never,
		requesterState,
		requesterRuntime,
	);
	const settled = await tools.get("wait_for_request_outcome").execute("id", {}, new AbortController().signal);
	assert.equal(settled.details.outcome, "all-settled");
	assert.equal(settled.details.pending_count, 0);

	// A new Request after the completed loop gets a new independent reminder.
	await flow.sendMemberRequest({
		membership,
		member: "Kelly",
		message: "C: start a new conversation",
		maxWaitSeconds: 600,
	});
	assert.deepEqual(flow.registry.outboundRequestIds(), ["request-c"]);
	clock.advance(180_000);
	const newReminders = delivered.filter((message) => message.content.startsWith("[request reminder]"));
	assert.equal(newReminders.length, 2);
	assert.match(newReminders[1]!.content, /request-c/);
	armWait();
	await target.state.memberRequestFlow!.respondToMemberRequest({
		requestId: "request-c",
		member: { name: "Kelly", role: "qa" },
		message: "C complete",
	});
	await until(() => flow.registry.outboundCount() === 0, "C response did not settle the new Request");
	const settledAgain = await tools.get("wait_for_request_outcome").execute("id", {}, new AbortController().signal);
	assert.equal(settledAgain.details.outcome, "all-settled");
});

test("TASK-0076 negative: ordinary Follow-up is marked no-correlated-Response and creates no request state", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-followup-affordance-"));
	const targetPath = path.join(root, "target.sock");
	const requesterPath = path.join(root, "requester.sock");
	try {
		const target = await targetRuntime(targetPath, requesterPath);
		t.after(async () => {
			await closeRpcServer(target.server);
		});

		// Ordinary Follow-up through the real send command path.
		const payload = {
			content: "FYI: CI is green, no response needed",
			origin: { kind: "crew" as const, name: "Tony", role: "lead" },
		};
		const sent = await sendRpcCommand(
			targetPath,
			{ type: "send", payload, delivery: "follow_up" },
			{ timeout: 5_000 },
		);
		assert.equal(sent.response.success, true);

		// Model context carries the structural follow-up marker.
		const inbound = target.acceptedIntoContext[0]!.message as { content: string };
		assert.match(inbound.content, /^\[follow-up\]/);
		assert.match(inbound.content, /no correlated Response expected/i);
		assert.doesNotMatch(inbound.content, /respond_to_member_request|wait_for_request_outcome|\[member request\]/);

		// No request state was created on the target.
		assert.equal(target.state.memberRequestFlow!.registry.inboundCount(), 0);

		// The sender's request-outcome wait fails immediately: ordinary
		// Follow-up never creates a pending outbound request.
		const requesterFlow = new MemberRequestFlow({
			transport: {
				open: async () => ({ close: () => undefined }),
				respond: async () => undefined,
			},
			resolveEndpoint: resolveMemberEndpoint,
		});
		assert.deepEqual(
			requesterFlow.waitForRequestOutcome(() => undefined),
			{
				ok: false,
				code: "no-pending-requests",
			},
		);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
