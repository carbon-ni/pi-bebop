import assert from "node:assert/strict";
import test from "node:test";
import { MemberRequestFlow } from "./member-request-flow.ts";
import type { MemberRequestFlowDependencies, MemberRequestResponseChannel } from "./member-request-flow.ts";
import { MEMBER_REQUEST_ACCEPT_DEADLINE_MS, parseCrewManifest, type MemberChannelUpdate } from "../domain/index.ts";

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
const requester = { name: "qa", role: "reviewer" };

/** Deterministic fake clock + captured timers (no wall-clock sleeps). */
class FakeClock {
	now = 1_000;
	private readonly timers = new Map<number, { dueAt: number; callback: () => void }>();
	private seq = 1;

	setTimeout = (callback: () => void, delayMs: number): number => {
		const id = this.seq++;
		this.timers.set(id, { dueAt: this.now + delayMs, callback });
		return id;
	};
	clearTimeout = (handle: number): void => {
		this.timers.delete(handle);
	};
	/** Advance the clock and fire every timer that is due at or before the new time,
	 * in due order; timers scheduled while firing use the (already advanced) now. */
	advance(ms: number): void {
		this.now += ms;
		for (;;) {
			let earliest: number | undefined;
			for (const [id, timer] of this.timers) {
				if (
					timer.dueAt <= this.now &&
					(earliest === undefined || timer.dueAt < this.timers.get(earliest)!.dueAt)
				)
					earliest = id;
			}
			if (earliest === undefined) break;
			const timer = this.timers.get(earliest)!;
			this.timers.delete(earliest);
			timer.callback();
		}
	}
	remaining(): number {
		return this.timers.size;
	}
}

interface Harness {
	flow: MemberRequestFlow;
	clock: FakeClock;
	emit: (update: MemberChannelUpdate) => void;
	reminders: string[];
	acceptedTimeoutMs?: number;
	close?: () => void;
}

function setup(overrides: { timeoutSeconds?: number; maxWaitSeconds?: number } = {}): Harness {
	const clock = new FakeClock();
	const reminders: string[] = [];
	let emit: (update: MemberChannelUpdate) => void = () => undefined;
	let close: (() => void) | undefined;
	const harness: Harness = {
		flow: new MemberRequestFlow({
			resolveEndpoint: async (socketPath) => socketPath,
			transport: {
				open: async (_endpoint, _command, options) => {
					harness.acceptedTimeoutMs = options.timeoutMs;
					emit = options.onUpdate;
					close = () => undefined;
					return { close: () => close?.() };
				},
				respond: async () => undefined,
			},
			now: () => clock.now,
			createRequestId: () => "request-1",
			setTimeout: clock.setTimeout,
			clearTimeout: clock.clearTimeout,
			onFirstIdleReminder: (requestId, member) => reminders.push(`${requestId}:${member.name}`),
		}),
		clock,
		emit: (update) => emit(update),
		reminders,
		close: () => close?.(),
	};
	return harness;
}

async function send(h: Harness, overrides: { timeoutSeconds?: number; maxWaitSeconds?: number } = {}) {
	return h.flow.sendMemberRequest({
		membership,
		member: "qa",
		message: "Review",
		timeoutSeconds: overrides.timeoutSeconds,
		maxWaitSeconds: overrides.maxWaitSeconds,
	});
}

test("TASK-0080 C1: transport acceptance window is the fixed 5s constant; pre-accept failure leaves no slot and no timers", async () => {
	const h = setup();
	await send(h);
	assert.equal(h.acceptedTimeoutMs, MEMBER_REQUEST_ACCEPT_DEADLINE_MS);
	// Pre-accept failure: transport throws before acceptance -> no slot, no timers.
	const failed = setup();
	failed.flow.registry.failBeforeAcceptance("request-1");
	// Simulate a pre-accept rejection path via a throwing transport.
	const throwing = new MemberRequestFlow({
		resolveEndpoint: async (socketPath) => socketPath,
		transport: {
			open: async () => {
				throw new Error("offline");
			},
			respond: async () => undefined,
		},
		now: () => 1_000,
		createRequestId: () => "request-1",
		setTimeout: clockNoop,
		clearTimeout: () => undefined,
	});
	await assert.rejects(() => throwing.sendMemberRequest({ membership, member: "qa", message: "Review" }));
	assert.equal(throwing.registry.outboundCount(), 0);
	assert.equal(throwing.registry.hasPendingOutcome(), false);
});

function clockNoop(_cb: () => void): number {
	return 0;
}

test("TASK-0080 C2/TASK-0144: hard timer starts at accepted and follows one reminder before timeout", async () => {
	const h = setup({ timeoutSeconds: 120, maxWaitSeconds: 300 });
	await send(h, { timeoutSeconds: 120, maxWaitSeconds: 300 });
	const outcomes: string[] = [];
	h.flow.waitForRequestOutcome((update) =>
		outcomes.push(`${update.kind}:${update.kind === "timeout" ? update.reason : ""}`),
	);
	// Before the hard deadline: nothing terminal.
	h.clock.advance(120_000);
	assert.equal(h.flow.registry.hasPendingOutcome(), true);
	assert.deepEqual(outcomes, []);
	// The requester reminder is nonterminal at +180s.
	h.clock.advance(60_000);
	assert.deepEqual(outcomes, ["still-pending:"]);
	// Re-arm the yielding outcome callback; the hard deadline remains +300s.
	h.flow.waitForRequestOutcome((update) =>
		outcomes.push(`${update.kind}:${update.kind === "timeout" ? update.reason : ""}`),
	);
	// At the hard deadline: timeout(max-wait).
	h.clock.advance(120_000);
	assert.deepEqual(outcomes, ["still-pending:", "timeout:max-wait"]);
	assert.equal(h.flow.registry.outboundCount(), 0);
	assert.equal(h.clock.remaining(), 0);
});

test("TASK-0080 C3: grace starts ONCE at first post-context idle; later settles never extend it", async () => {
	const h = setup({ timeoutSeconds: 120, maxWaitSeconds: 7200 });
	await send(h, { timeoutSeconds: 120, maxWaitSeconds: 7200 });
	const outcomes: string[] = [];
	h.flow.waitForRequestOutcome((update) =>
		outcomes.push(`${update.kind}:${update.kind === "timeout" ? update.reason : ""}`),
	);
	// First idle arms grace at t=+10s -> grace deadline t=+130s.
	h.clock.advance(10_000);
	h.emit({ kind: "idle", requestId: "request-1", member: requester });
	// A later settle does NOT restart the grace.
	h.clock.advance(5_000);
	h.emit({ kind: "idle", requestId: "request-1", member: requester });
	// At t=+130s grace fires.
	h.clock.advance(115_000);
	assert.deepEqual(outcomes, ["timeout:response-after-idle"]);
	assert.equal(h.flow.registry.outboundCount(), 0);
});

test("TASK-0080 C4: hard truncates a LATER grace deadline; exact tie resolves as response-after-idle", async () => {
	// Truncation: idle at t=+10s (grace t=+130s), hard at t=+121s -> max-wait.
	const trunc = setup({ timeoutSeconds: 120, maxWaitSeconds: 121 });
	await send(trunc, { timeoutSeconds: 120, maxWaitSeconds: 121 });
	const truncOutcomes: string[] = [];
	trunc.flow.waitForRequestOutcome((update) =>
		truncOutcomes.push(`${update.kind}:${update.kind === "timeout" ? update.reason : ""}`),
	);
	trunc.clock.advance(10_000);
	trunc.emit({ kind: "idle", requestId: "request-1", member: requester });
	trunc.clock.advance(111_000);
	assert.deepEqual(truncOutcomes, ["timeout:max-wait"]);

	// Exact tie: idle at t=+1s (grace t=+121s), hard at t=+121s -> grace wins.
	const tie = setup({ timeoutSeconds: 120, maxWaitSeconds: 121 });
	await send(tie, { timeoutSeconds: 120, maxWaitSeconds: 121 });
	const tieOutcomes: string[] = [];
	tie.flow.waitForRequestOutcome((update) =>
		tieOutcomes.push(`${update.kind}:${update.kind === "timeout" ? update.reason : ""}`),
	);
	tie.clock.advance(1_000);
	tie.emit({ kind: "idle", requestId: "request-1", member: requester });
	tie.clock.advance(120_000);
	assert.deepEqual(tieOutcomes, ["timeout:response-after-idle"]);
});

test("TASK-0080 C5: response beats socket offline in the same handler; first terminal wins", async () => {
	const h = setup();
	await send(h);
	const outcomes: string[] = [];
	h.flow.waitForRequestOutcome((update) => outcomes.push(update.kind));
	h.emit({
		kind: "response",
		requestId: "request-1",
		member: requester,
		message: "answer",
		instructions: [],
	});
	h.emit({ kind: "offline", requestId: "request-1", member: requester });
	assert.deepEqual(outcomes, ["response"]);
	assert.equal(h.flow.registry.outboundCount(), 0);
});

test("TASK-0080 C6: reminder queued exactly once at the target's first idle; a broken channel never loses it and never alters the request", async () => {
	const h = setup();
	const sent: MemberChannelUpdate[] = [];
	h.flow.registerInboundRequest({
		requestId: "in-1",
		requester,
		message: "Review",
		instructions: [],
		channel: {
			send: async (update) => {
				sent.push(update);
			},
			close: () => undefined,
		},
	});
	h.flow.acceptInboundRequest("in-1");
	await h.flow.settleInboundIdle("in-1");
	assert.deepEqual(h.reminders, ["in-1:qa"]);
	assert.deepEqual(sent, [{ kind: "idle", requestId: "in-1", member: requester }]);
	// Second settle: exactly one reminder, one notification.
	await h.flow.settleInboundIdle("in-1");
	assert.deepEqual(h.reminders, ["in-1:qa"]);
	assert.equal(sent.length, 1);

	// Broken notification channel: the reminder is still queued exactly once and
	// the inbound slot is preserved (the reminder never resolves or fails the
	// request; the source's offline/grace/hard paths remain authoritative).
	const broken = setup();
	broken.flow.registerInboundRequest({
		requestId: "in-2",
		requester,
		message: "Review",
		instructions: [],
		channel: {
			send: async () => {
				throw new Error("socket closed");
			},
			close: () => undefined,
		},
	});
	broken.flow.acceptInboundRequest("in-2");
	await assert.rejects(() => broken.flow.settleInboundIdle("in-2"));
	assert.deepEqual(broken.reminders, ["in-2:qa"]);
	assert.equal(broken.flow.registry.inboundCount(), 1);
});

test("TASK-0080 C7: inbound idle is NONTERMINAL - slot preserved, internal idle notification once, response still possible", async () => {
	const h = setup();
	const sent: MemberChannelUpdate[] = [];
	const channel: MemberRequestResponseChannel = {
		send: async (update) => {
			sent.push(update);
		},
		close: () => undefined,
	};
	h.flow.registerInboundRequest({
		requestId: "in-1",
		requester,
		message: "Review",
		instructions: [],
		channel,
	});
	h.flow.acceptInboundRequest("in-1");
	await h.flow.settleInboundIdle("in-1");
	assert.equal(h.flow.registry.inboundCount(), 1);
	assert.deepEqual(sent, [{ kind: "idle", requestId: "in-1", member: requester }]);
	// Second settle: no duplicate notification.
	await h.flow.settleInboundIdle("in-1");
	assert.equal(sent.length, 1);
	// Response is still possible after idle (idle is not a terminal).
	const selected = h.flow.registry.selectInbound("in-1");
	assert.equal(selected.ok, true);
});

test("TASK-0080 C8: validation errors are stable and deterministic", async () => {
	await assert.rejects(
		() => send(setup(), { timeoutSeconds: 0 }),
		(error: Error) => error.message === "invalid-timeout",
	);
	await assert.rejects(
		() => send(setup(), { maxWaitSeconds: 59 }),
		(error: Error) => error.message === "invalid-max-wait",
	);
	await assert.rejects(
		() => send(setup(), { timeoutSeconds: 200, maxWaitSeconds: 200 }),
		(error: Error) => error.message === "invalid-max-wait",
	);
});
