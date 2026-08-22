import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { LiveSessionInfo } from "../infra/control-store.ts";
import { createSocketState } from "./control-runtime.ts";
import { registerSessionControlCommand, type ControlCommandDeps } from "./control-commands.ts";
import type { MembershipRuntime } from "../infra/membership-runtime.ts";

function setup() {
	let command: { handler: (args: string, ctx: ExtensionContext) => Promise<void>; getArgumentCompletions: (prefix: string) => unknown } | undefined;
	const notifications: string[] = [];
	const messages: Array<{ content: string; options?: unknown }> = [];
	const pi = {
		registerCommand: (_name: string, definition: typeof command) => { command = definition; },
		sendMessage: (message: { content: string }, options?: unknown) => messages.push({ content: message.content, options }),
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: true,
		ui: { notify: (message: string) => notifications.push(message) },
		isProjectTrusted: () => true,
		cwd: "/project",
		sessionManager: { getSessionId: () => "local", getSessionName: () => "local-name" },
	} as unknown as ExtensionContext;
	const state = createSocketState();
	return { pi, ctx, state, notifications, messages, getCommand: () => command! };
}

const liveSession = (sessionId: string, name?: string): LiveSessionInfo => ({
	sessionId,
	name,
	aliases: name ? [name] : [],
	socketPath: `/tmp/${sessionId}.sock`,
});

function baseDeps(overrides: Partial<ControlCommandDeps> = {}): ControlCommandDeps {
	return {
		disableControlServer: async (state) => {
			state.server = null;
		},
		...overrides,
	};
}

test("intray command completions expose only the consolidated command surface", () => {
	const setupState = setup();
	registerSessionControlCommand(setupState.pi, setupState.state, baseDeps());
	const values = (setupState.getCommand().getArgumentCompletions("") as Array<{ value: string }>).map(({ value }) => value);
	assert.deepEqual(values, ["join", "leave", "list", "status", "stop"]);
});

test("/intray join and leave use membership runtime without stopping base server", async () => {
	const setupState = setup();
	const calls: Array<{ operation: string; value?: unknown }> = [];
	const persisted: boolean[] = [];
	const announcements: string[] = [];
	const activation: string[] = [];
	let refreshes = 0;
	let currentMembership: MembershipRuntime["getMembership"] extends () => infer T ? T : never = null;
	const runtime = {
		join: async (request: unknown) => {
			calls.push({ operation: "join", value: request });
			currentMembership = { manifestPath: "/project/.pi/intray/crew.json", socketPath: "/project/.pi/intray/sockets/dev.sock", globalSocketPath: "/tmp/global.sock", member: { name: "dev", role: "developer", socket: "sockets/dev.sock", socketPath: "/project/.pi/intray/sockets/dev.sock" } };
			return { ok: true, membership: currentMembership, idempotent: false };
		},
		leave: async () => { calls.push({ operation: "leave" }); currentMembership = null; return { ok: true, left: true }; },
		getMembership: () => currentMembership,
	} as unknown as MembershipRuntime;
	registerSessionControlCommand(setupState.pi, setupState.state, baseDeps({
		membershipRuntime: runtime,
		persistMembership: (active) => persisted.push(active),
		announceMembership: (message) => announcements.push(message),
		activateMembershipTool: () => activation.push("activate"),
		deactivateMembershipTool: () => activation.push("deactivate"),
		refreshStatus: () => { refreshes += 1; },
		ensureControlServer: async (_pi, state, ctx) => { state.server = {} as never; state.socketPath = "/tmp/global.sock"; state.context = ctx; },
	}));

	await setupState.getCommand().handler("join '.pi/intray/sockets/dev.sock'", setupState.ctx);
	assert.equal(calls[0]?.operation, "join");
	assert.deepEqual(calls[0]?.value, { manifestPath: "/project/.pi/intray/crew.json", socketPath: "/project/.pi/intray/sockets/dev.sock", globalSocketPath: "/tmp/global.sock" });
	assert.match(setupState.notifications[0]!, /dev \(developer\)/);
	assert.equal(setupState.ctx.sessionManager.getSessionName(), "local-name");
	await setupState.getCommand().handler("status", setupState.ctx);
	assert.match(setupState.messages[0]!.content, /Crew: .*crew\.json/);
	assert.match(setupState.messages[0]!.content, /Endpoint: .*dev\.sock/);
	await setupState.getCommand().handler("leave", setupState.ctx);
	assert.deepEqual(calls.map(({ operation }) => operation), ["join", "leave"]);
	assert.equal(setupState.state.server !== null, true);
	assert.deepEqual(persisted, [true, false]);
	assert.equal(announcements.length, 2);
	assert.deepEqual(activation, ["activate", "deactivate"]);
	assert.equal(refreshes, 2);
});

test("/intray join reports trust and runtime failures without claiming", async () => {
	const untrusted = setup();
	let joins = 0;
	const runtime = {
		join: async () => { joins += 1; return { ok: true, membership: undefined, idempotent: false }; },
		leave: async () => ({ ok: true, left: false }),
		getMembership: () => null,
	} as unknown as MembershipRuntime;
	(untrusted.ctx as unknown as { isProjectTrusted: () => boolean }).isProjectTrusted = () => false;
	registerSessionControlCommand(untrusted.pi, untrusted.state, baseDeps({
		membershipRuntime: runtime,
		ensureControlServer: async (_pi, state, ctx) => { state.server = {} as never; state.socketPath = "/tmp/global.sock"; state.context = ctx; },
	}));
	await untrusted.getCommand().handler("join /tmp/project/.pi/intray/sockets/dev.sock", untrusted.ctx);
	assert.equal(joins, 0);
	assert.deepEqual(untrusted.notifications, ["Intray join failed: project is not trusted"]);

	const failed = setup();
	const failingRuntime = {
		join: async () => ({ ok: false, error: new Error("claim failed") }),
		leave: async () => ({ ok: true, left: false }),
		getMembership: () => null,
	} as unknown as MembershipRuntime;
	registerSessionControlCommand(failed.pi, failed.state, baseDeps({
		membershipRuntime: failingRuntime,
		ensureControlServer: async (_pi, state, ctx) => { state.server = {} as never; state.socketPath = "/tmp/global.sock"; state.context = ctx; },
	}));
	await failed.getCommand().handler("join /tmp/project/.pi/intray/sockets/dev.sock", failed.ctx);
	assert.deepEqual(failed.notifications, ["Intray join failed: claim failed"]);
});

test("/intray list works while stopped and probes live sessions in parallel", async () => {
	const setupState = setup();
	let activeProbes = 0;
	let maxProbes = 0;
	registerSessionControlCommand(setupState.pi, setupState.state, baseDeps({
		getLiveSessions: async () => [liveSession("one", "one"), liveSession("two", "two")],
		sendRpcCommand: async (path) => {
			activeProbes += 1;
			maxProbes = Math.max(maxProbes, activeProbes);
			await new Promise((resolve) => setTimeout(resolve, 5));
			activeProbes -= 1;
			return { response: { type: "response", command: "status", success: true, data: { status: path.includes("one") ? "online" : "joined" } } };
		},
	}));

	await setupState.getCommand().handler("list", setupState.ctx);
	assert.equal(maxProbes, 2);
	assert.equal(setupState.messages.length, 1);
	assert.match(setupState.messages[0]!.content, /one.*online/s);
	assert.match(setupState.messages[0]!.content, /two.*joined/s);
	assert.deepEqual(setupState.messages[0]!.options, { triggerTurn: false });
});

test("/intray status and stop observe state and stop base resources", async () => {
	const setupState = setup();
	const calls: string[] = [];
	const runtime = {
		getMembership: () => null,
		leave: async () => { calls.push("leave"); return { ok: true, left: false }; },
	} as unknown as MembershipRuntime;
	registerSessionControlCommand(setupState.pi, setupState.state, baseDeps({
		membershipRuntime: runtime,
		disableControlServer: async () => { calls.push("stop"); },
	}));

	await setupState.getCommand().handler("status", setupState.ctx);
	assert.equal(setupState.messages[0]?.content, "Intray stopped");
	assert.deepEqual(setupState.messages[0]?.options, { triggerTurn: false });

	await setupState.getCommand().handler("stop", setupState.ctx);
	assert.deepEqual(calls, ["stop"]);
	assert.deepEqual(setupState.notifications, ["Intray stopped"]);
});

test("/intray stop releases and persists active crew membership before cleanup", async () => {
	const setupState = setup();
	const calls: string[] = [];
	const persisted: boolean[] = [];
	const activation: string[] = [];
	let currentMembership: unknown = { member: { name: "dev", role: "developer" } };
	const runtime = {
		getMembership: () => currentMembership,
		leave: async () => { calls.push("leave"); currentMembership = null; return { ok: true, left: true }; },
	} as unknown as MembershipRuntime;
	registerSessionControlCommand(setupState.pi, setupState.state, baseDeps({
		membershipRuntime: runtime,
		persistMembership: (active) => persisted.push(active),
		deactivateMembershipTool: () => activation.push("deactivate"),
		disableControlServer: async () => { calls.push("stop"); },
	}));

	await setupState.getCommand().handler("stop", setupState.ctx);
	assert.deepEqual(calls, ["leave", "stop"]);
	assert.deepEqual(persisted, [false]);
	assert.deepEqual(activation, ["deactivate"]);
});
