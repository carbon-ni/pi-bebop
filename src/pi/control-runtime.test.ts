import test from "node:test";
import assert from "node:assert/strict";
import { createPresenceObserver } from "../application/presence-observer.ts";
import { createMemberMessageCoordinator } from "../application/member-message.ts";

import {
	activateMembershipTool,
	createSocketState,
	deactivateMembershipTool,
	deriveIntrayStatus,
	disableControlServer,
	emitIdleSettled,
	formatIntrayFooter,
	handleCommand,
	MEMBERSHIP_TOOLS,
	reconcileMembershipTools,
	refreshIntrayStatus,
} from "./control-runtime.ts";
import { MEMBER_FOCUS_ENTRY_TYPE } from "../domain/index.ts";

function createThrowingContext(message: string): unknown {
	return {
		get hasUI() {
			throw new Error(message);
		},
		get sessionManager() {
			throw new Error(message);
		},
	};
}

test("membership tool activation preserves unrelated tools and is idempotent", () => {
	let active = ["read", "grep"];
	const pi = {
		getActiveTools: () => active,
		setActiveTools: (tools: string[]) => {
			active = tools;
		},
	} as never;
	activateMembershipTool(pi);
	activateMembershipTool(pi);
	// Joined active set is the full post-0045 public surface: all five
	// membership tools, interrupt_member included (shipped, not hidden).
	assert.deepEqual(active, ["read", "grep", ...MEMBERSHIP_TOOLS]);
	deactivateMembershipTool(pi);
	deactivateMembershipTool(pi);
	assert.deepEqual(active, ["read", "grep"]);
});

test("reconcile removes Pi-auto-activated membership tools on fresh load and restores order", () => {
	// Pi auto-activates registered extension tools; reconcile(false) removes them
	// while preserving unrelated tool order and membership.
	let active = [
		"read",
		"bash",
		"send_follow_up",
		"redirect_member",
		"edit",
		"send_to_inbox",
		"broadcast_to_crew",
		"write",
		"interrupt_member",
	];
	const calls: string[][] = [];
	const pi = {
		getActiveTools: () => active,
		setActiveTools: (tools: string[]) => {
			active = tools;
			calls.push(tools);
		},
	} as never;
	reconcileMembershipTools(pi, false);
	assert.deepEqual(active, ["read", "bash", "edit", "write"]);
	assert.equal(calls.length, 1);
	// Idempotent: second reconcile(false) is a no-op.
	reconcileMembershipTools(pi, false);
	assert.equal(calls.length, 1);
	// Re-activate appends the joined active set (all five membership tools).
	reconcileMembershipTools(pi, true);
	assert.deepEqual(active, ["read", "bash", "edit", "write", ...MEMBERSHIP_TOOLS]);
});

test("status derives stopped, online, and joined from server and crew state", () => {
	assert.equal(deriveIntrayStatus(false, false), "stopped");
	assert.equal(deriveIntrayStatus(true, false), "online");
	assert.equal(deriveIntrayStatus(true, true), "joined");
	assert.equal(formatIntrayFooter("session-id", "joined"), "session-id joined");
});

test("membership transitions refresh the footer online to joined to online", () => {
	const state = createSocketState();
	const statuses: string[] = [];
	state.server = {} as never;
	state.context = {
		hasUI: true,
		sessionManager: { getSessionId: () => "session" },
		ui: {
			setStatus: (_key: string, value?: string) => {
				if (value) statuses.push(value);
			},
			theme: { fg: (_color: string, value: string) => value },
		},
	} as never;
	state.membershipRuntime = { getMembership: () => null } as never;
	refreshIntrayStatus(state);
	state.membershipRuntime = { getMembership: () => ({}) } as never;
	refreshIntrayStatus(state);
	state.membershipRuntime = { getMembership: () => null } as never;
	refreshIntrayStatus(state);
	assert.deepEqual(statuses, ["session online", "session joined", "session online"]);
});

test("RPC status reports online and joined without legacy fields", async () => {
	const state = createSocketState();
	state.server = {} as never;
	state.context = { hasUI: false, sessionManager: { getSessionId: () => "session" } } as never;
	const writes: string[] = [];
	const socket = { write: (value: string) => writes.push(value), once: () => socket } as never;
	const pi = { sendMessage: () => undefined } as never;
	await handleCommand(pi, state, { type: "status", id: "status-1" }, socket);
	assert.deepEqual(JSON.parse(writes[0]!), { jsonrpc: "2.0", id: "status-1", result: { status: "online" } });
	state.membershipRuntime = { getMembership: () => ({}) } as never;
	await handleCommand(pi, state, { type: "status", id: "status-2" }, socket);
	assert.deepEqual(JSON.parse(writes[1]!), { jsonrpc: "2.0", id: "status-2", result: { status: "joined" } });
});

test("characterizes idle direct and busy follow-up or immediate delivery dispositions", async () => {
	const writes: string[] = [];
	const socket = { write: (value: string) => writes.push(value), once: () => socket } as never;
	const sent: unknown[] = [];
	const state = createSocketState();
	state.server = {} as never;
	const context = { sessionManager: { getSessionId: () => "session" }, isIdle: () => true, abort: () => undefined };
	state.context = context as never;
	const pi = { sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }) } as never;
	await handleCommand(pi, state, { type: "send", payload: { content: "normal" }, id: "idle" }, socket);
	assert.deepEqual(JSON.parse(writes[0]!), {
		jsonrpc: "2.0",
		id: "idle",
		result: { deliveryId: "delivery-idle", disposition: "direct" },
	});
	assert.deepEqual((sent[0] as { options: unknown }).options, { triggerTurn: true });
	writes.length = 0;
	sent.length = 0;
	context.isIdle = () => false;
	await handleCommand(
		pi,
		state,
		{ type: "send", payload: { content: "later" }, delivery: "follow_up", id: "follow" },
		socket,
	);
	assert.deepEqual(JSON.parse(writes[0]!), {
		jsonrpc: "2.0",
		id: "follow",
		result: { deliveryId: "delivery-follow", disposition: "queued" },
	});
	assert.deepEqual((sent[0] as { options: unknown }).options, { triggerTurn: true, deliverAs: "followUp" });
	writes.length = 0;
	sent.length = 0;
	await handleCommand(
		pi,
		state,
		{ type: "send", payload: { content: "now" }, delivery: "immediate", id: "immediate" },
		socket,
	);
	assert.deepEqual(JSON.parse(writes[0]!), {
		jsonrpc: "2.0",
		id: "immediate",
		result: { deliveryId: "delivery-immediate", disposition: "steered" },
	});
	assert.deepEqual((sent[0] as { options: unknown }).options, { triggerTurn: true, deliverAs: "steer" });
});

test("member.status target handler reports mechanical idle/busy, pending, and focus without a turn", async () => {
	const writes: string[] = [];
	const socket = { write: (value: string) => writes.push(value), once: () => socket } as never;
	const entries: unknown[] = [
		{
			type: "custom",
			customType: MEMBER_FOCUS_ENTRY_TYPE,
			data: {
				version: 1,
				memberIdentity: "/project/.pi/bebop/sockets/Tony.sock",
				action: "set",
				focus: "Implementing status schema",
				updatedAt: "2026-08-23T12:00:00.000Z",
			},
		},
	];
	const state = createSocketState();
	state.server = {} as never;
	state.membershipRuntime = {
		getMembership: () => ({
			manifestPath: "/project/.pi/bebop/crew.json",
			socketPath: "/project/.pi/bebop/sockets/Tony.sock",
			member: { name: "Tony", role: "lead", socketPath: "/project/.pi/bebop/sockets/Tony.sock" },
			manifest: { members: [] },
		}),
	} as never;
	let sent = 0;
	state.context = {
		hasUI: false,
		sessionManager: { getSessionId: () => "session", getEntries: () => entries },
		isIdle: () => false,
		hasPendingMessages: () => true,
	} as never;
	const pi = {
		sendMessage: () => {
			sent += 1;
		},
	} as never;
	await handleCommand(pi, state, { type: "member_status", member: "Bob", id: "ms-1" }, socket);
	const response = JSON.parse(writes[0]!);
	assert.equal(response.id, "ms-1");
	assert.equal(response.result.status.presence, "online");
	assert.equal(response.result.status.activity, "busy");
	assert.equal(response.result.status.hasPendingMessages, true);
	assert.equal(response.result.status.member.name, "Tony");
	assert.deepEqual(response.result.status.focus, {
		state: "reported",
		text: "Implementing status schema",
		updatedAt: "2026-08-23T12:00:00.000Z",
	});
	assert.equal(sent, 0, "member.status must never trigger a turn");
	assert.ok(response.result.status.observedAt, "observedAt must be present");
});

test("member.status target handler reports idle/unspecified and rejects unjoined", async () => {
	const writes: string[] = [];
	const socket = { write: (value: string) => writes.push(value), once: () => socket } as never;
	const state = createSocketState();
	state.server = {} as never;
	state.context = {
		hasUI: false,
		sessionManager: { getSessionId: () => "session", getEntries: () => [] },
		isIdle: () => true,
		hasPendingMessages: () => false,
	} as never;
	await handleCommand({} as never, state, { type: "member_status", member: "Bob", id: "ms-u" }, socket);
	assert.match(JSON.parse(writes[0]!).error?.message, /not-joined/);
	state.membershipRuntime = {
		getMembership: () => ({
			manifestPath: "/project/.pi/bebop/crew.json",
			socketPath: "/project/.pi/bebop/sockets/Tony.sock",
			member: { name: "Tony", role: "lead", socketPath: "/project/.pi/bebop/sockets/Tony.sock" },
			manifest: { members: [] },
		}),
	} as never;
	await handleCommand({} as never, state, { type: "member_status", member: "Bob", id: "ms-2" }, socket);
	const response = JSON.parse(writes[1]!);
	assert.equal(response.result.status.activity, "idle");
	assert.equal(response.result.status.hasPendingMessages, false);
	assert.deepEqual(response.result.status.focus, { state: "unspecified" });
});

test("presence handler returns accepted true and false without exposing observer state", async () => {
	const writes: string[] = [];
	const socket = { write: (value: string) => writes.push(value), once: () => socket } as never;
	const state = createSocketState();
	state.context = { hasUI: false, sessionManager: { getSessionId: () => "session" } } as never;
	const member = { identity: "/crew/dev.sock", name: "dev", role: "developer" } as const;
	const makeObserver = (accepted: boolean) => ({ acceptHint: () => accepted }) as never;
	for (const accepted of [true, false]) {
		state.presenceObserver = makeObserver(accepted);
		await handleCommand(
			{} as never,
			state,
			{ type: "presence_hint", member, state: "online", instanceId: "peer", id: String(accepted) },
			socket,
		);
		assert.deepEqual(JSON.parse(writes.at(-1)!), { jsonrpc: "2.0", id: String(accepted), result: { accepted } });
	}
	state.presenceObserver = undefined;
	await handleCommand(
		{} as never,
		state,
		{ type: "presence_hint", member, state: "online", instanceId: "peer", id: "none" },
		socket,
	);
	assert.deepEqual(JSON.parse(writes.at(-1)!), { jsonrpc: "2.0", id: "none", result: { accepted: false } });
});

test("real presence handler rejects self, unknown, and mismatched claims without probing", async () => {
	const writes: string[] = [];
	const socket = { write: (value: string) => writes.push(value), once: () => socket } as never;
	const lead = { identity: "/lead", name: "lead", role: "lead" } as const;
	const dev = { identity: "/dev", name: "dev", role: "developer" } as const;
	let probes = 0;
	const observer = createPresenceObserver(
		[lead, dev],
		lead.identity,
		"self",
		{ notifications: true },
		{
			scheduler: { schedule: (_d, cb) => cb, cancel: () => undefined },
			probe: async () => {
				probes++;
				return true;
			},
			sendHint: async () => undefined,
			onEffects: () => undefined,
		},
	);
	await observer.start();
	const state = createSocketState();
	state.context = { hasUI: false, sessionManager: { getSessionId: () => "session" } } as never;
	state.presenceObserver = observer;
	for (const [id, member] of [
		["self", lead],
		["unknown", { identity: "/unknown", name: "unknown", role: "qa" }],
		["mismatch", { ...dev, role: "qa" }],
	] as const) {
		await handleCommand(
			{} as never,
			state,
			{ type: "presence_hint", member, state: "online", instanceId: "peer", id },
			socket,
		);
		assert.deepEqual(JSON.parse(writes.at(-1)!), { jsonrpc: "2.0", id, result: { accepted: false } });
	}
	assert.equal(probes, 1);
});

test("disableControlServer clears the base server status", async () => {
	const state = createSocketState();
	const staleContext = createThrowingContext("This extension ctx is stale after session replacement or reload");
	await assert.doesNotReject(disableControlServer(state, staleContext as never));
});

test("disableControlServer still reports unexpected context errors", async () => {
	const state = createSocketState();
	const brokenContext = createThrowingContext("unexpected failure");
	await assert.rejects(disableControlServer(state, brokenContext as never), /unexpected failure/);
});

test("message.interrupt busy flow persists pending before abort, steers recovery, and hands off", async () => {
	const writes: string[] = [];
	const socket = { write: (value: string) => writes.push(value), once: () => socket } as never;
	const sent: unknown[] = [];
	const appended: unknown[] = [];
	const order: string[] = [];
	let idle = false;
	const state = createSocketState();
	state.server = {} as never;
	const context = {
		sessionManager: { getSessionId: () => "session", getEntries: () => appended },
		isIdle: () => idle,
		abort: () => {
			order.push("abort");
		},
	};
	state.context = context as never;
	const pi = {
		sendMessage: (message: unknown, options: unknown) => {
			order.push(`send:${(options as { deliverAs?: string }).deliverAs ?? "turn"}`);
			sent.push({ message, options });
		},
		appendEntry: (customType: string, data: unknown) => {
			order.push("append");
			appended.push({ type: "custom", customType, data });
		},
	} as never;

	const payload = { content: "stop now", origin: { kind: "crew" as const, name: "Tony", role: "lead" } };
	await handleCommand(pi, state, { type: "interrupt", payload, id: "int-1" }, socket);
	assert.deepEqual(order, ["append", "abort", "send:steer", "append"]);
	const response = JSON.parse(writes[0]!) as {
		result: { interruptId: string; disposition: string };
	};
	assert.equal(response.result.disposition, "interrupt-requested");
	assert.match(response.result.interruptId, /^interrupt-/);
});

test("message.interrupt idle flow returns direct without abort", async () => {
	const writes: string[] = [];
	const socket = { write: (value: string) => writes.push(value), once: () => socket } as never;
	const sent: unknown[] = [];
	const appended: unknown[] = [];
	const order: string[] = [];
	const state = createSocketState();
	state.server = {} as never;
	const context = {
		sessionManager: { getSessionId: () => "session", getEntries: () => appended },
		isIdle: () => true,
		abort: () => {
			order.push("abort");
		},
	};
	state.context = context as never;
	const pi = {
		sendMessage: (message: unknown, options: unknown) => {
			order.push(`send:${(options as { deliverAs?: string }).deliverAs ?? "turn"}`);
			sent.push({ message, options });
		},
		appendEntry: (customType: string, data: unknown) => {
			order.push("append");
			appended.push({ type: "custom", customType, data });
		},
	} as never;
	const payload = { content: "recover", origin: { kind: "crew" as const, name: "Mary", role: "po" } };
	await handleCommand(pi, state, { type: "interrupt", payload, id: "int-2" }, socket);
	assert.deepEqual(order, ["append", "send:turn", "append"]);
	const response = JSON.parse(writes[0]!) as { result: { disposition: string } };
	assert.equal(response.result.disposition, "direct");
});

test("message.interrupt rejects a concurrent pending request for the same target", async () => {
	const writes: string[] = [];
	const socket = { write: (value: string) => writes.push(value), once: () => socket } as never;
	const appended: unknown[] = [];
	let idle = false;
	const state = createSocketState();
	state.server = {} as never;
	const context = {
		sessionManager: { getSessionId: () => "session", getEntries: () => appended },
		isIdle: () => idle,
		abort: () => {
			throw new Error("abort failed");
		},
	};
	state.context = context as never;
	const pi = {
		sendMessage: () => {},
		appendEntry: (customType: string, data: unknown) => {
			appended.push({ type: "custom", customType, data });
		},
	} as never;
	const payload = { content: "stop", origin: { kind: "crew" as const, name: "Tony", role: "lead" } };
	await handleCommand(pi, state, { type: "interrupt", payload, id: "int-1" }, socket);
	assert.equal(JSON.parse(writes[0]!).error?.code, -32603); // abort failed → error response
	// Pending evidence remains; a second request for the same target is rejected.
	writes.length = 0;
	await handleCommand(pi, state, { type: "interrupt", payload, id: "int-2" }, socket);
	assert.equal(JSON.parse(writes[0]!).error?.message, "already-pending");
});

test("member_idle_wait requires joined membership and rejects unjoined", async () => {
	const writes: string[] = [];
	const socket = { write: (value: string) => writes.push(value), once: () => socket } as never;
	const state = createSocketState();
	state.server = {} as never;
	state.context = {
		sessionManager: { getSessionId: () => "session", getEntries: () => [] },
		isIdle: () => true,
	} as never;
	await handleCommand({} as never, state, { type: "member_idle_wait", member: "Bob", id: "iw-u" }, socket);
	assert.match(JSON.parse(writes[0]!).error?.message, /not-joined/);
});

test("member_idle_wait on an already-idle target completes directly without a lingering subscription", async () => {
	const writes: string[] = [];
	const socket = { write: (value: string) => writes.push(value), once: () => socket } as never;
	const state = createSocketState();
	state.server = {} as never;
	state.membershipRuntime = {
		getMembership: () => ({
			manifestPath: "/project/.pi/bebop/crew.json",
			socketPath: "/project/.pi/bebop/sockets/Tony.sock",
			member: { name: "Tony", role: "lead", socketPath: "/project/.pi/bebop/sockets/Tony.sock" },
			manifest: { members: [] },
		}),
	} as never;
	state.context = {
		hasUI: false,
		sessionManager: { getSessionId: () => "session", getEntries: () => [] },
		isIdle: () => true,
	} as never;
	await handleCommand({} as never, state, { type: "member_idle_wait", member: "Bob", id: "iw-1" }, socket);
	const response = JSON.parse(writes[0]!);
	assert.equal(response.id, "iw-1");
	assert.equal(response.result.subscriptionId, "iw-1");
	assert.equal(response.result.event, "member_idle");
	// Already idle: the one-shot terminal event arrives immediately with already-idle.
	const event = JSON.parse(writes[1]!);
	assert.equal(event.method, "member.idle_wait");
	assert.equal(event.params.subscriptionId, "iw-1");
	assert.equal(event.params.result.outcome, "idle");
	assert.equal(event.params.result.disposition, "already-idle");
	// No lingering subscription: settled emission writes nothing more.
	await emitIdleSettled(state);
	assert.equal(writes.length, 2);
});

test("member_idle_wait on a busy target registers a one-shot subscription and settles to became-idle", async () => {
	const writes: string[] = [];
	const socket = { write: (value: string) => writes.push(value), once: () => socket } as never;
	const state = createSocketState();
	state.server = {} as never;
	state.membershipRuntime = {
		getMembership: () => ({
			manifestPath: "/project/.pi/bebop/crew.json",
			socketPath: "/project/.pi/bebop/sockets/Tony.sock",
			member: { name: "Tony", role: "lead", socketPath: "/project/.pi/bebop/sockets/Tony.sock" },
			manifest: { members: [] },
		}),
	} as never;
	state.context = {
		hasUI: false,
		sessionManager: { getSessionId: () => "session", getEntries: () => [] },
		isIdle: () => false,
	} as never;
	await handleCommand({} as never, state, { type: "member_idle_wait", member: "Bob", id: "iw-2" }, socket);
	const ack = JSON.parse(writes[0]!);
	assert.equal(ack.result.subscriptionId, "iw-2");
	assert.equal(ack.result.event, "member_idle");
	// Agent settles: one-shot terminal event is emitted exactly once.
	await emitIdleSettled(state);
	assert.equal(writes.length, 2);
	const event = JSON.parse(writes[1]!);
	assert.equal(event.method, "member.idle_wait");
	assert.equal(event.params.subscriptionId, "iw-2");
	assert.equal(event.params.result.outcome, "idle");
	assert.equal(event.params.result.disposition, "became-idle");
	assert.equal(event.params.result.member.name, "Tony");
	// One-shot: a second settle emits nothing.
	await emitIdleSettled(state);
	assert.equal(writes.length, 2);
});

test("member_idle_wait enforces capacity and rejects a duplicate wait for the same target", async () => {
	const writes: string[] = [];
	const socket = { write: (value: string) => writes.push(value), once: () => socket } as never;
	const state = createSocketState();
	state.server = {} as never;
	state.membershipRuntime = {
		getMembership: () => ({
			manifestPath: "/project/.pi/bebop/crew.json",
			socketPath: "/project/.pi/bebop/sockets/Tony.sock",
			member: { name: "Tony", role: "lead", socketPath: "/project/.pi/bebop/sockets/Tony.sock" },
			manifest: { members: [] },
		}),
	} as never;
	state.context = {
		hasUI: false,
		sessionManager: { getSessionId: () => "session", getEntries: () => [] },
		isIdle: () => false,
	} as never;
	await handleCommand({} as never, state, { type: "member_idle_wait", member: "Bob", id: "iw-3" }, socket);
	assert.equal(JSON.parse(writes[0]!).result.event, "member_idle");
	// Second wait for the same target is rejected (one wait per target).
	await handleCommand({} as never, state, { type: "member_idle_wait", member: "Bob", id: "iw-4" }, socket);
	assert.match(JSON.parse(writes[1]!).error?.message, /already-waiting/);
});

test("member_idle_wait never triggers a turn and releases subscriptions on server stop", async () => {
	let sent = 0;
	const writes: string[] = [];
	const socket = { write: (value: string) => writes.push(value), once: () => socket } as never;
	const state = createSocketState();
	state.server = { close: async () => {} } as never;
	state.membershipRuntime = {
		getMembership: () => ({
			manifestPath: "/project/.pi/bebop/crew.json",
			socketPath: "/project/.pi/bebop/sockets/Tony.sock",
			member: { name: "Tony", role: "lead", socketPath: "/project/.pi/bebop/sockets/Tony.sock" },
			manifest: { members: [] },
		}),
	} as never;
	state.context = {
		hasUI: false,
		sessionManager: { getSessionId: () => "session", getSessionName: () => null, getEntries: () => [] },
		isIdle: () => false,
	} as never;
	const pi = {
		sendMessage: () => {
			sent += 1;
		},
	} as never;
	await handleCommand(pi, state, { type: "member_idle_wait", member: "Bob", id: "iw-5" }, socket);
	assert.equal(JSON.parse(writes[0]!).result.event, "member_idle");
	assert.equal(sent, 0, "idle wait must never trigger a turn");
	// Stopping the server releases subscriptions: no idle event after stop.
	state.server = null;
	state.turnEndSubscriptions = [];
	state.idleWaitSubscriptions = [];
	await emitIdleSettled(state);
	assert.equal(writes.length, 1, "released subscriptions must not emit idle events");
});

// ============================================================================
// TASK-0061: delegated member status (member_status_target)
// ============================================================================

function delegationState(manifestMembers: Array<{ name: string; role: string; socket: string }>): {
	state: ReturnType<typeof createSocketState>;
	socket: { write: (value: string) => boolean; once: () => never };
	writes: string[];
} {
	const writes: string[] = [];
	const socket = {
		write: (value: string) => {
			writes.push(value);
			return true;
		},
		once: () => socket,
	} as never;
	const state = createSocketState();
	state.server = {} as never;
	const sockets = manifestMembers.map((member) => ({
		name: member.name,
		role: member.role,
		socket: member.socket,
		socketPath: member.socket,
	}));
	state.membershipRuntime = {
		getMembership: () => ({
			manifestPath: "/project/.pi/bebop/crew.json",
			socketPath: "/project/.pi/bebop/sockets/lead.sock",
			member: { name: "Tony", role: "lead", socketPath: "/project/.pi/bebop/sockets/lead.sock" },
			manifest: { members: sockets },
		}),
	} as never;
	state.context = {
		hasUI: false,
		sessionManager: { getSessionId: () => "session", getSessionName: () => null, getEntries: () => [] },
		isIdle: () => false,
		hasPendingMessages: () => false,
		isProjectTrusted: () => true,
	} as never;
	return { state, socket, writes };
}

const ONLINE_STATUS = {
	member: { name: "Mary", role: "po" },
	presence: "online",
	activity: "busy",
	hasPendingMessages: true,
	focus: { state: "reported", text: "Reviewing", updatedAt: "2026-08-23T12:00:00.000Z" },
	observedAt: "2026-08-23T12:03:00.000Z",
};

test("member_status_target delegates to the shared flow: online target status returned untouched", async () => {
	const { state, socket, writes } = delegationState([
		{ name: "Mary", role: "po", socket: "/project/.pi/bebop/sockets/po.sock" },
		{ name: "Bob", role: "dev", socket: "/project/.pi/bebop/sockets/dev.sock" },
	]);
	const probed: string[] = [];
	const requested: Array<{ endpoint: string; label: string }> = [];
	state.memberStatusTransport = {
		probeEndpoint: async (socketPath) => {
			probed.push(socketPath);
			return true;
		},
		requestStatus: async (endpoint, label) => {
			requested.push({ endpoint, label });
			return { ok: true, status: ONLINE_STATUS as never };
		},
	};
	await handleCommand({} as never, state, { type: "member_status_target", target: "Mary", id: "dst-1" }, socket);
	const response = JSON.parse(writes[0]!);
	assert.equal(response.id, "dst-1");
	assert.equal(response.result.status.presence, "online");
	assert.equal(response.result.status.observedAt, "2026-08-23T12:03:00.000Z");
	assert.deepEqual(probed, ["/project/.pi/bebop/sockets/po.sock"]);
	assert.deepEqual(requested, [{ endpoint: "/project/.pi/bebop/sockets/po.sock", label: "Mary" }]);
});

test("member_status_target offline target is a successful presence=offline result", async () => {
	const { state, socket, writes } = delegationState([
		{ name: "Mary", role: "po", socket: "/project/.pi/bebop/sockets/po.sock" },
	]);
	state.memberStatusTransport = {
		probeEndpoint: async () => false,
		requestStatus: async () => {
			throw new Error("must not be called when probe fails");
		},
	};
	await handleCommand({} as never, state, { type: "member_status_target", target: "Mary", id: "dst-off" }, socket);
	const response = JSON.parse(writes[0]!);
	assert.equal(response.result.status.presence, "offline");
	assert.equal(response.result.status.activity, "unavailable");
	assert.deepEqual(response.result.status.focus, { state: "unavailable" });
	assert.ok(response.result.status.observedAt, "offline result records source observation time");
});

test("member_status_target resolves unique role and rejects unknown/ambiguous/self with stable codes", async () => {
	const { state, socket, writes } = delegationState([
		{ name: "Tony", role: "lead", socket: "/project/.pi/bebop/sockets/lead.sock" },
		{ name: "Mary", role: "po", socket: "/project/.pi/bebop/sockets/po.sock" },
		{ name: "Kelly", role: "qa", socket: "/project/.pi/bebop/sockets/qa.sock" },
		{ name: "Dimmy", role: "qa", socket: "/project/.pi/bebop/sockets/qa2.sock" },
	]);
	state.memberStatusTransport = {
		probeEndpoint: async () => true,
		requestStatus: async () => ({ ok: true, status: ONLINE_STATUS as never }),
	};
	const cases: Array<{ target: string; code: string }> = [
		{ target: "qa", code: "ambiguous-member" },
		{ target: "nobody", code: "unknown-member" },
		{ target: "Tony", code: "self-query" },
	];
	for (const [index, item] of cases.entries()) {
		await handleCommand(
			{} as never,
			state,
			{ type: "member_status_target", target: item.target, id: `dst-${index}` },
			socket,
		);
		const response = JSON.parse(writes[index]!);
		assert.equal(response.error?.message, item.code, item.target);
	}
	// Unique role resolves to the sole member with that role.
	await handleCommand({} as never, state, { type: "member_status_target", target: "po", id: "dst-role" }, socket);
	const response = JSON.parse(writes[cases.length]!);
	assert.equal(response.error, undefined);
	assert.equal(response.result.status.member.name, "Mary");
});

test("member_status_target rejects unjoined source and untrusted source before target IO", async () => {
	const { state, socket, writes } = delegationState([{ name: "Mary", role: "po", socket: "/x" }]);
	state.membershipRuntime = { getMembership: () => null } as never;
	await handleCommand({} as never, state, { type: "member_status_target", target: "Mary", id: "dst-nj" }, socket);
	assert.equal(JSON.parse(writes[0]!).error?.message, "not-joined");

	const untrusted = delegationState([{ name: "Mary", role: "po", socket: "/x" }]);
	untrusted.state.context = {
		hasUI: false,
		sessionManager: { getSessionId: () => "session", getSessionName: () => null, getEntries: () => [] },
		isIdle: () => false,
		hasPendingMessages: () => false,
		isProjectTrusted: () => false,
	} as never;
	untrusted.state.memberStatusTransport = {
		probeEndpoint: async () => {
			throw new Error("must not probe when untrusted");
		},
		requestStatus: async () => {
			throw new Error("must not query when untrusted");
		},
	};
	await handleCommand(
		{} as never,
		untrusted.state,
		{ type: "member_status_target", target: "Mary", id: "dst-ut" },
		untrusted.socket,
	);
	assert.equal(JSON.parse(untrusted.writes[0]!).error?.message, "untrusted");
});

test("member_status_target aborts in-flight target IO when the CLI disconnects", async () => {
	const { state } = delegationState([
		{ name: "Tony", role: "lead", socket: "/project/.pi/bebop/sockets/lead.sock" },
		{ name: "Mary", role: "po", socket: "/project/.pi/bebop/sockets/po.sock" },
	]);
	const writes: string[] = [];
	let closeHandler: (() => void) | undefined;
	const socket = {
		write: (value: string) => {
			writes.push(value);
			return true;
		},
		once: (event: string, handler: () => void) => {
			if (event === "close") closeHandler = handler;
			return socket;
		},
	} as never;
	let requestStatusCalls = 0;
	state.memberStatusTransport = {
		probeEndpoint: async (_socketPath, signal) => {
			await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
			return false;
		},
		requestStatus: async () => {
			requestStatusCalls += 1;
			return { ok: true, status: ONLINE_STATUS as never };
		},
	};
	const pending = handleCommand({} as never, state, { type: "member_status_target", target: "po", id: "c1" }, socket);
	await new Promise((resolve) => setTimeout(resolve, 10));
	closeHandler?.();
	await pending;
	// The aborted probe stops before any target RPC; the wire reports the stable
	// aborted code (never a successful offline observation).
	assert.equal(requestStatusCalls, 0);
	const response = JSON.parse(writes[0]!);
	assert.equal(response.error?.message, "aborted");
});

// ============================================================================
// TASK-0062: delegated message delivery (member_follow_up / member_redirect)
// ============================================================================

interface MessageAck {
	readonly deliveryId: string;
	readonly disposition: "direct" | "queued" | "steered";
}

function messageState(
	ack: MessageAck | Error,
	manifestMembers: Array<{ name: string; role: string; socket: string }> = [
		{ name: "Tony", role: "lead", socket: "/project/.pi/bebop/sockets/lead.sock" },
		{ name: "Mary", role: "po", socket: "/project/.pi/bebop/sockets/po.sock" },
		{ name: "Kelly", role: "qa", socket: "/project/.pi/bebop/sockets/qa.sock" },
		{ name: "Dimmy", role: "qa", socket: "/project/.pi/bebop/sockets/qa2.sock" },
	],
): {
	state: ReturnType<typeof createSocketState>;
	socket: { write: (value: string) => boolean; once: () => never };
	writes: string[];
	sent: string[];
} {
	const writes: string[] = [];
	const socket = {
		write: (value: string) => {
			writes.push(value);
			return true;
		},
		once: () => socket,
	} as never;
	const state = createSocketState();
	state.server = {} as never;
	const sockets = manifestMembers.map((member) => ({
		name: member.name,
		role: member.role,
		socket: member.socket,
		socketPath: member.socket,
	}));
	state.membershipRuntime = {
		getMembership: () => ({
			manifestPath: "/project/.pi/bebop/crew.json",
			socketPath: "/project/.pi/bebop/sockets/lead.sock",
			member: { name: "Tony", role: "lead", socketPath: "/project/.pi/bebop/sockets/lead.sock" },
			manifest: { members: sockets },
		}),
	} as never;
	state.context = {
		hasUI: false,
		sessionManager: { getSessionId: () => "session", getSessionName: () => null, getEntries: () => [] },
		isIdle: () => false,
		hasPendingMessages: () => false,
		isProjectTrusted: () => true,
	} as never;
	const sent: string[] = [];
	state.memberMessageDependencies = {
		transport: {
			send: async (endpoint, command) => {
				sent.push(`${endpoint}:${command.type}`);
				if (ack instanceof Error) throw ack;
				return { response: { type: "response", command: "send", success: true, data: ack, id: command.id } };
			},
		},
		resolveEndpoint: async (socketPath) => socketPath,
		coordinator: createMemberMessageCoordinator(),
	} as never;
	return { state, socket, writes, sent };
}

test("member_follow_up delegates to the shared member-message op: queued and direct acknowledgements", async () => {
	for (const disposition of ["queued", "direct"] as const) {
		const { state, socket, writes, sent } = messageState({ deliveryId: `d-${disposition}`, disposition });
		await handleCommand(
			{} as never,
			state,
			{ type: "member_follow_up", target: "Kelly", message: "wrap up", id: "fu-1" },
			socket,
		);
		const response = JSON.parse(writes[0]!);
		assert.equal(response.result.member.name, "Kelly");
		assert.equal(response.result.member.role, "qa");
		assert.equal(response.result.deliveryId, `d-${disposition}`);
		assert.equal(response.result.disposition, disposition);
		assert.equal(sent[0], "/project/.pi/bebop/sockets/qa.sock:send");
	}
});

test("member_redirect delegates with immediate intent: steered and direct acknowledgements", async () => {
	for (const disposition of ["steered", "direct"] as const) {
		const { state, socket, writes, sent } = messageState({ deliveryId: `d-${disposition}`, disposition });
		await handleCommand(
			{} as never,
			state,
			{ type: "member_redirect", target: "po", message: "change course", id: "rd-1" },
			socket,
		);
		const response = JSON.parse(writes[0]!);
		assert.equal(response.result.member.name, "Mary");
		assert.equal(response.result.disposition, disposition);
		assert.equal(sent[0], "/project/.pi/bebop/sockets/po.sock:send");
	}
});

test("member message delivery rejects unknown/ambiguous/self targets with stable codes", async () => {
	const cases: Array<{ target: string; code: string }> = [
		{ target: "qa", code: "ambiguous-member" },
		{ target: "nobody", code: "unknown-member" },
		{ target: "Tony", code: "self-send" },
	];
	const { state, socket, writes } = messageState({ deliveryId: "d-1", disposition: "direct" });
	for (const [index, item] of cases.entries()) {
		await handleCommand(
			{} as never,
			state,
			{ type: "member_follow_up", target: item.target, message: "hi", id: `fu-${index}` },
			socket,
		);
		const response = JSON.parse(writes[index]!);
		assert.equal(response.error?.message, item.code, item.target);
	}
});

test("member message delivery requires joined and trusted membership before any transport", async () => {
	const unjoined = messageState({ deliveryId: "d-1", disposition: "direct" });
	unjoined.state.membershipRuntime = null;
	await handleCommand(
		{} as never,
		unjoined.state,
		{ type: "member_follow_up", target: "Kelly", message: "hi", id: "fu-u" },
		unjoined.socket,
	);
	assert.equal(JSON.parse(unjoined.writes[0]!).error?.message, "not-joined");

	const untrusted = messageState({ deliveryId: "d-1", disposition: "direct" });
	untrusted.state.context = {
		...untrusted.state.context,
		isProjectTrusted: () => false,
	} as never;
	await handleCommand(
		{} as never,
		untrusted.state,
		{ type: "member_follow_up", target: "Kelly", message: "hi", id: "fu-t" },
		untrusted.socket,
	);
	assert.equal(JSON.parse(untrusted.writes[0]!).error?.message, "untrusted");
	assert.equal(untrusted.sent.length, 0);
});

test("member message delivery maps offline, timeout, abort, and invalid ack distinctly", async () => {
	const offlineError = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
	const offline = messageState(offlineError);
	await handleCommand(
		{} as never,
		offline.state,
		{ type: "member_redirect", target: "Mary", message: "x", id: "rd-o" },
		offline.socket,
	);
	assert.equal(JSON.parse(offline.writes[0]!).error?.message, "offline");

	const timeout = messageState(new Error("RPC request timeout"));
	await handleCommand(
		{} as never,
		timeout.state,
		{ type: "member_follow_up", target: "Mary", message: "x", id: "fu-t" },
		timeout.socket,
	);
	assert.equal(JSON.parse(timeout.writes[0]!).error?.message, "timeout");

	const aborted = messageState(Object.assign(new Error("Operation aborted"), { name: "AbortError" }));
	await handleCommand(
		{} as never,
		aborted.state,
		{ type: "member_follow_up", target: "Mary", message: "x", id: "fu-a" },
		aborted.socket,
	);
	assert.equal(JSON.parse(aborted.writes[0]!).error?.message, "aborted");

	const invalidAck = messageState(new Error("nope"));
	await handleCommand(
		{} as never,
		invalidAck.state,
		{ type: "member_follow_up", target: "Mary", message: "x", id: "fu-i" },
		invalidAck.socket,
	);
	assert.equal(JSON.parse(invalidAck.writes[0]!).error?.message, "transport-error");
});
