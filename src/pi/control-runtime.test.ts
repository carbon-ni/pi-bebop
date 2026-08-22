import test from "node:test";
import assert from "node:assert/strict";

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
	assert.deepEqual(active, ["read", "send_to_session", "send_to_member"]);
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
