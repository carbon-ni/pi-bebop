import assert from "node:assert/strict";
import test from "node:test";
import { MemberRequestFlow } from "./member-request-flow.ts";
import type { MemberRequestFlowDependencies, MemberRequestResponseChannel } from "./member-request-flow.ts";
import { parseCrewManifest } from "../domain/index.ts";
import { RpcProtocolError } from "../infra/rpc-client.ts";

const manifest = parseCrewManifest(
	{
		version: 1,
		members: [
			{ name: "dev", role: "developer", socket: "sockets/dev.sock" },
			{ name: "qa", role: "reviewer", socket: "sockets/qa.sock" },
		],
	},
	"/project/.pi/bebop/crew.json",
);
const membership = {
	manifestPath: "/project/.pi/bebop/crew.json",
	manifest,
	member: { ...manifest.members[0], socketPath: "/project/.pi/bebop/sockets/dev.sock" },
	socketPath: "/project/.pi/bebop/sockets/dev.sock",
	globalSocketPath: "/project/global.sock",
};
function setup(overrides: Partial<MemberRequestFlowDependencies> = {}) {
	let callback: ((update: any) => void) | undefined;
	const dependencies: MemberRequestFlowDependencies = {
		resolveEndpoint: async (socketPath) => socketPath,
		transport: {
			open: async (_endpoint, _command, options) => {
				callback = options.onUpdate;
				return { close: () => undefined };
			},
			respond: async (_channel, _update) => undefined,
		},
		now: () => 1_000,
		createRequestId: () => "request-1",
		setTimeout: (() => undefined) as unknown as MemberRequestFlowDependencies["setTimeout"],
		clearTimeout: (() => undefined) as unknown as MemberRequestFlowDependencies["clearTimeout"],
		...overrides,
	};
	return { flow: new MemberRequestFlow(dependencies), emit: (update: any) => callback?.(update) };
}

test("request registers before endpoint/open and returns accepted without waiting for response", async () => {
	const events: string[] = [];
	const { flow } = setup({
		resolveEndpoint: async (socketPath) => {
			events.push(`resolve:${socketPath}`);
			assert.equal(flow.registry.outboundCount(), 1);
			return socketPath;
		},
		transport: {
			open: async (_endpoint, command, options) => {
				events.push(`open:${command.requestId}`);
				assert.equal(flow.registry.outboundCount(), 1);
				options.onUpdate;
				return { close: () => undefined };
			},
			respond: async () => undefined,
		},
	});
	const accepted = await flow.sendMemberRequest({ membership, member: "qa", message: "Review" });
	assert.deepEqual(accepted.member, membership.manifest.members[1]);
	assert.deepEqual(events, ["resolve:/project/.pi/bebop/sockets/qa.sock", "open:request-1"]);
	// Close the accepted request channel so this test does not leave its 300s lifecycle timer active.
	assert.equal(flow.registry.resolveOffline("request-1").ok, true);
});

test("TASK-0144: requester reminder starts at accepted delivery and stays nonterminal", async () => {
	let now = 1_000;
	const timers: Array<{ callback: () => void; delay: number }> = [];
	const { flow } = setup({
		now: () => now,
		setTimeout: (callback, delay) => {
			const timer = { callback, delay };
			timers.push(timer);
			return timer as never;
		},
		clearTimeout: () => undefined,
	});
	await flow.sendMemberRequest({ membership, member: "qa", message: "Review" });
	assert.equal(timers[0]?.delay, 180_000);
	now += 179_999;
	timers[0]!.callback();
	assert.equal(flow.registry.bufferedCount(), 0);
	now += 1;
	timers[timers.length - 1]!.callback();
	const waited = flow.waitForRequestOutcome(() => {
		throw new Error("reminder is buffered before the requester waits");
	});
	assert.equal(waited.ok, true);
	if (waited.ok) {
		assert.deepEqual(waited.update, {
			kind: "still-pending",
			requestId: "request-1",
			member: { name: "qa", role: "reviewer" },
			ageSeconds: 180,
		});
	}
	assert.equal(flow.registry.outboundCount(), 1, "a reminder never settles the Request");
});

test("TASK-0144: terminal outcome discards an undelivered reminder but remains buffered", async () => {
	let now = 1_000;
	const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
	const { flow, emit } = setup({
		now: () => now,
		setTimeout: (callback) => {
			const timer = { callback, cancelled: false };
			timers.push(timer);
			return timer as never;
		},
		clearTimeout: (handle) => {
			(handle as unknown as { cancelled: boolean }).cancelled = true;
		},
	});
	await flow.sendMemberRequest({ membership, member: "qa", message: "Review" });
	now += 180_000;
	timers[0]!.callback();
	emit({
		kind: "response",
		requestId: "request-1",
		member: { name: "qa", role: "reviewer" },
		message: "Done",
		instructions: [],
	});
	assert.equal(flow.registry.bufferedCount(), 1, "stale reminder is removed; terminal remains");
	const waited = flow.waitForRequestOutcome(() => undefined);
	assert.equal(waited.ok, true);
	if (waited.ok) assert.equal(waited.kind, "update");
	if (waited.ok && waited.kind === "update") assert.equal(waited.update.kind, "response");
});

test("TASK-0144: terminal Request outcome cancels its requester reminder", async () => {
	const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
	const { flow, emit } = setup({
		setTimeout: (callback) => {
			const timer = { callback, cancelled: false };
			timers.push(timer);
			return timer as never;
		},
		clearTimeout: (handle) => {
			(handle as unknown as { cancelled: boolean }).cancelled = true;
		},
	});
	await flow.sendMemberRequest({ membership, member: "qa", message: "Review" });
	emit({
		kind: "response",
		requestId: "request-1",
		member: { name: "qa", role: "reviewer" },
		message: "Done",
		instructions: [],
	});
	timers[0]!.callback();
	assert.equal(flow.registry.bufferedCount(), 1, "only the terminal Response remains buffered");
	assert.equal(timers[0]!.cancelled, true);
});

test("TASK-0144: Response, offline, timeout, abort, and channel loss cancel reminders before deadline", async () => {
	const cases = [
		{
			name: "Response",
			finish: (emit: (update: any) => void) =>
				emit({
					kind: "response",
					requestId: "request-1",
					member: { name: "qa", role: "reviewer" },
					message: "Done",
					instructions: [],
				}),
		},
		{
			name: "offline",
			finish: (emit: (update: any) => void) =>
				emit({ kind: "offline", requestId: "request-1", member: { name: "qa", role: "reviewer" } }),
		},
		{
			name: "channel loss",
			finish: (emit: (update: any) => void) =>
				emit({ kind: "offline", requestId: "request-1", member: { name: "qa", role: "reviewer" } }),
		},
	] as const;
	for (const scenario of cases) {
		const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
		const reminders: unknown[] = [];
		const { flow, emit } = setup({
			onRequesterReminder: (updates) => reminders.push(...updates),
			setTimeout: (callback) => {
				const timer = { callback, cancelled: false };
				timers.push(timer);
				return timer as never;
			},
			clearTimeout: (handle) => {
				(handle as unknown as { cancelled: boolean }).cancelled = true;
			},
		});
		await flow.sendMemberRequest({ membership, member: "qa", message: scenario.name });
		scenario.finish(emit);
		timers[0]!.callback();
		assert.deepEqual(reminders, [], `${scenario.name} before deadline emits no requester reminder`);
		assert.equal(timers[0]!.cancelled, true, `${scenario.name} cancels the exact reminder timer`);
	}

	const timeoutTimers: Array<{ callback: () => void; cancelled: boolean }> = [];
	const timeoutReminders: unknown[] = [];
	const timeout = setup({
		onRequesterReminder: (updates) => timeoutReminders.push(...updates),
		setTimeout: (callback) => {
			const timer = { callback, cancelled: false };
			timeoutTimers.push(timer);
			return timer as never;
		},
		clearTimeout: (handle) => {
			(handle as unknown as { cancelled: boolean }).cancelled = true;
		},
	});
	const timeoutEmit = timeout.emit;
	await timeout.flow.sendMemberRequest({
		membership,
		member: "qa",
		message: "timeout",
		timeoutSeconds: 1,
		maxWaitSeconds: 301,
	});
	timeoutEmit({ kind: "idle", requestId: "request-1", member: { name: "qa", role: "reviewer" } });
	timeoutTimers[2]!.callback();
	timeoutTimers[0]!.callback();
	assert.deepEqual(timeoutReminders, [], "Request timeout before the reminder deadline emits no reminder");
	assert.equal(timeoutTimers[0]!.cancelled, true);

	const abortTimers: Array<{ callback: () => void; cancelled: boolean }> = [];
	const abortReminders: unknown[] = [];
	const aborted = setup({
		onRequesterReminder: (updates) => abortReminders.push(...updates),
		setTimeout: (callback) => {
			const timer = { callback, cancelled: false };
			abortTimers.push(timer);
			return timer as never;
		},
		clearTimeout: (handle) => {
			(handle as unknown as { cancelled: boolean }).cancelled = true;
		},
	});
	await aborted.flow.sendMemberRequest({ membership, member: "qa", message: "abort" });
	aborted.flow.cancelAllOutbound();
	abortTimers[0]!.callback();
	assert.deepEqual(abortReminders, [], "abort before the reminder deadline emits no reminder");
	assert.equal(abortTimers[0]!.cancelled, true);
});

test("TASK-0144: lifecycle cancellation removes every requester reminder", async () => {
	const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
	let sequence = 0;
	const { flow } = setup({
		createRequestId: () => `request-${++sequence}`,
		setTimeout: (callback) => {
			const timer = { callback, cancelled: false };
			timers.push(timer);
			return timer as never;
		},
		clearTimeout: (handle) => {
			(handle as unknown as { cancelled: boolean }).cancelled = true;
		},
	});
	await flow.sendMemberRequest({ membership, member: "qa", message: "Review A" });
	await flow.sendMemberRequest({ membership, member: "qa", message: "Review B" });
	flow.cancelAllOutbound();
	assert.equal(flow.registry.outboundCount(), 0);
	assert.equal(timers.filter((timer) => timer.cancelled).length, 4);
});

test("pre-accept failure cleans request while lost acknowledgement closes as outcome-unknown", async () => {
	const failed = setup({
		transport: {
			open: async () => {
				throw new Error("offline");
			},
			respond: async () => undefined,
		},
	});
	await assert.rejects(
		() => failed.flow.sendMemberRequest({ membership, member: "qa", message: "Review" }),
		/offline/,
	);
	assert.equal(failed.flow.registry.outboundCount(), 0);
	const lost = setup({
		transport: {
			open: async () => {
				throw new RpcProtocolError("outcome-unknown", "lost");
			},
			respond: async () => undefined,
		},
	});
	await assert.rejects(
		() => lost.flow.sendMemberRequest({ membership, member: "qa", message: "Review" }),
		/outcome-unknown/,
	);
	assert.equal(lost.flow.registry.outboundCount(), 0);
});

test("terminal response is buffered exactly once and wait returns it", async () => {
	const setupResult = setup();
	await setupResult.flow.sendMemberRequest({ membership, member: "qa", message: "Review" });
	setupResult.emit({
		kind: "response",
		requestId: "request-1",
		member: { name: "qa", role: "reviewer" },
		message: "Done",
		instructions: [],
	});
	let update: unknown;
	const waited = setupResult.flow.waitForRequestOutcome((value) => {
		update = value;
	});
	assert.equal(waited.ok, true);
	if (waited.ok) assert.equal(waited.kind, "update");
	assert.deepEqual(update, undefined);
	const second = setupResult.flow.waitForRequestOutcome(() => undefined);
	assert.deepEqual(second, { ok: false, code: "no-pending-requests" });
});

test("TASK-0077: hasPendingRequestOutcome covers pending outbound and buffered terminal updates", async () => {
	const setupResult = setup();
	assert.equal(setupResult.flow.hasPendingRequestOutcome(), false);
	await setupResult.flow.sendMemberRequest({ membership, member: "qa", message: "Review" });
	assert.equal(setupResult.flow.hasPendingRequestOutcome(), true, "pending outbound request");
	setupResult.emit({
		kind: "response",
		requestId: "request-1",
		member: { name: "qa", role: "reviewer" },
		message: "Done",
		instructions: [],
	});
	assert.equal(setupResult.flow.hasPendingRequestOutcome(), true, "terminal update buffered until consumed");
	setupResult.flow.waitForRequestOutcome(() => undefined);
	assert.equal(setupResult.flow.hasPendingRequestOutcome(), false);
});

test("TASK-0080: idle before the wait is nonterminal; post-idle grace expiry is buffered and returned immediately", async () => {
	const captured: Array<() => void> = [];
	const { flow, emit } = setup({
		setTimeout: (callback) => {
			captured.push(callback);
			return captured.length;
		},
		clearTimeout: () => undefined,
	});
	await flow.sendMemberRequest({ membership, member: "qa", message: "Review" });
	// The target's internal idle notification arrives BEFORE the source waits.
	// It is NONTERMINAL: it only arms the post-idle grace.
	emit({ kind: "idle", requestId: "request-1", member: { name: "qa", role: "reviewer" } });
	assert.equal(flow.registry.outboundCount(), 1, "idle must be nonterminal");
	// Post-idle grace expires without a Response -> terminal, buffered.
	const graceTimer = captured[captured.length - 1];
	graceTimer();
	const waited = flow.waitForRequestOutcome(() => {
		throw new Error("buffered outcome must not require another lifecycle event");
	});
	assert.equal(waited.ok, true);
	if (waited.ok) {
		assert.equal(waited.kind, "update");
		assert.deepEqual(waited.update, {
			kind: "timeout",
			requestId: "request-1",
			member: { name: "qa", role: "reviewer" },
			reason: "response-after-idle",
		});
	}
	// Terminal exactly once: nothing is pending afterwards.
	assert.deepEqual(
		flow.waitForRequestOutcome(() => undefined),
		{ ok: false, code: "no-pending-requests" },
	);
});

test("TASK-0075: a broken inbound channel never leaves other settled requests stuck", async () => {
	const { flow } = setup();
	const sent: unknown[] = [];
	flow.registerInboundRequest({
		requestId: "in-broken",
		requester: { name: "lead", role: "lead" },
		message: "a",
		instructions: [],
		channel: {
			send: async () => {
				throw new Error("socket gone");
			},
		},
	});
	flow.registerInboundRequest({
		requestId: "in-ok",
		requester: { name: "lead", role: "lead" },
		message: "b",
		instructions: [],
		channel: { send: async (update) => sent.push(update) },
	});
	flow.acceptInboundRequest("in-broken");
	flow.armInboundRequest("in-broken");
	flow.acceptInboundRequest("in-ok");
	flow.armInboundRequest("in-ok");
	await flow.settleAllInboundIdle();
	assert.equal(sent.length, 1, "only the healthy channel receives its idle notification");
	assert.equal((sent[0] as { requestId: string }).requestId, "in-ok");
	// TASK-0080: idle is NONTERMINAL - both inbound requests keep their slots
	// until a real terminal (response/offline/grace/hard) closes them.
	assert.equal(flow.registry.inboundCount(), 2, "idle must preserve inbound slots");
});

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

test("inbound responder selection is zero/one/multiple and sends only through active channel", async () => {
	const sent: unknown[] = [];
	const setupResult = setup({
		transport: {
			open: async () => ({ close: () => undefined }),
			respond: async (_channel, update) => sent.push(update),
		},
	});
	await assert.rejects(
		() => setupResult.flow.respondToMemberRequest({ member: { name: "dev", role: "developer" }, message: "x" }),
		/no-pending-request/,
	);
	const channel: MemberRequestResponseChannel = { send: async (update) => sent.push(update) };
	setupResult.flow.registerInboundRequest({
		requestId: "in-1",
		requester: { name: "dev", role: "developer" },
		message: "x",
		instructions: [],
		channel,
	});
	setupResult.flow.registerInboundRequest({
		requestId: "in-2",
		requester: { name: "lead", role: "lead" },
		message: "y",
		instructions: [],
		channel,
	});
	await assert.rejects(
		() =>
			setupResult.flow.respondToMemberRequest({ member: { name: "qa", role: "reviewer" }, message: "response" }),
		(error: unknown) => error instanceof Error && /ambiguous-request.*in-1.*in-2/.test(error.message),
	);
	setupResult.flow.acceptInboundRequest("in-1");
	setupResult.flow.removeInboundRequest("in-2");
	await setupResult.flow.respondToMemberRequest({ member: { name: "qa", role: "reviewer" }, message: "response" });
	assert.equal(sent.length, 1);
	await assert.rejects(
		() => setupResult.flow.respondToMemberRequest({ member: { name: "qa", role: "reviewer" }, message: "replay" }),
		/no-pending-request/,
	);
});
