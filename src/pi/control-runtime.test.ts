import test from "node:test";
import assert from "node:assert/strict";
import { createPresenceObserver } from "../application/presence-observer.ts";

import {
	activateMembershipTool,
	createSocketState,
	deactivateMembershipTool,
	deriveIntrayStatus,
	disableControlServer,
	formatIntrayFooter,
	handleCommand,
	refreshIntrayStatus,
} from "./control-runtime.ts";

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
	let active = ["read", "send_to_session"];
	const pi = {
		getActiveTools: () => active,
		setActiveTools: (tools: string[]) => {
			active = tools;
		},
	} as never;
	activateMembershipTool(pi);
	activateMembershipTool(pi);
	assert.deepEqual(active, ["read", "send_to_session", "send_follow_up", "send_immediate"]);
	deactivateMembershipTool(pi);
	deactivateMembershipTool(pi);
	assert.deepEqual(active, ["read", "send_to_session"]);
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
