import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createSocketState, type SocketState } from "./control-runtime.ts";
import { registerGuestControlCommand, formatGuestCrews } from "./guest-control.ts";
import { createGuestMembershipRuntime, type GuestMembershipRuntime } from "../infra/guest-membership-runtime.ts";
import type { RpcCommandResult } from "../infra/rpc-client.ts";

const CREW = { id: "alpha", displayName: "Alpha" } as const;

function setup() {
	let command:
		| {
				handler: (args: string, ctx: ExtensionContext) => Promise<void>;
				getArgumentCompletions: (prefix: string) => unknown;
		  }
		| undefined;
	const notifications: Array<{ message: string; level: string }> = [];
	const entries: Array<{ customType: string; data?: unknown }> = [];
	const pi = {
		registerCommand: (_name: string, definition: typeof command) => {
			command = definition;
		},
		appendEntry: (customType: string, data?: unknown) => entries.push({ customType, data }),
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: true,
		ui: { notify: (message: string, level?: string) => notifications.push({ message, level: level ?? "info" }) },
		isProjectTrusted: () => true,
		cwd: "/project",
		sessionManager: { getSessionId: () => "guest-session-1" },
	} as unknown as ExtensionContext;
	const state = createSocketState();
	return { pi, ctx, state, notifications, entries, getCommand: () => command! };
}

function runtime(overrides: Partial<Parameters<typeof createGuestMembershipRuntime>[0]> = {}) {
	let requestIndex = 0;
	return createGuestMembershipRuntime({
		guestIdentity: "guest-session-1",
		callbackEndpoint: "/tmp/guest-callback.sock",
		createRequestId: () => `guest-request-${++requestIndex}`,
		submitJoinRequest: async () => undefined,
		...overrides,
	});
}

function wireResponse(data: unknown): RpcCommandResult {
	return {
		response: { success: true, data },
	} as RpcCommandResult;
}

interface GuestHarness {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	state: SocketState;
	notifications: Array<{ message: string; level: string }>;
	entries: Array<{ customType: string; data?: unknown }>;
	getCommand: () => {
		handler: (args: string, ctx: ExtensionContext) => Promise<void>;
		getArgumentCompletions: (prefix: string) => unknown;
	};
	guestRuntime: GuestMembershipRuntime;
	joinCalls: Array<{ target: string; command: unknown }>;
	leaveCalls: Array<{ target: string; command: unknown }>;
}

function guestSetup(guestRuntime: GuestMembershipRuntime = runtime()): GuestHarness {
	const base = setup();
	const joinCalls: Array<{ target: string; command: unknown }> = [];
	const leaveCalls: Array<{ target: string; command: unknown }> = [];
	registerGuestControlCommand(base.pi, base.state, {
		ensureControlServer: async (_pi, state, ctx) => {
			state.server = {} as never;
			state.socketPath = "/tmp/guest-callback.sock";
			state.context = ctx;
		},
		guestMembershipRuntime: guestRuntime,
		guestIdentity: (context) => context.sessionManager.getSessionId(),
		sendJoin: async (target, command) => {
			joinCalls.push({ target, command });
			return wireResponse({
				status: "pending",
				requestId: "remote-request-1",
				crew: CREW,
			});
		},
		sendLeave: async (target, command) => {
			leaveCalls.push({ target, command });
			return wireResponse({});
		},
	});
	return { ...base, guestRuntime, joinCalls, leaveCalls };
}

test("/guest completions expose exactly join, crews, and leave", () => {
	const harness = guestSetup();
	const values = (harness.getCommand().getArgumentCompletions("") as Array<{ value: string }>).map(
		({ value }) => value,
	);
	assert.deepEqual(values, ["join", "crews", "leave"]);
});

test("/guest crews lists pending and approved crews in order without endpoints", async () => {
	const guestRuntime = runtime();
	const harness = guestSetup(guestRuntime);
	await harness.getCommand().handler("crews", harness.ctx);
	assert.deepEqual((harness.entries.at(-1)?.data as { content: string }).content, "Guest is not joined to any crew.");

	guestRuntime.track(
		{ crew: CREW, guestName: "Alex", memberSocket: "/tmp/member.sock", submittedByMember: "member" },
		"remote-request-1",
	);
	guestRuntime.track(
		{
			crew: { id: "beta", displayName: "Beta" },
			guestName: "Alex",
			memberSocket: "/tmp/member2.sock",
			submittedByMember: "member",
		},
		"remote-request-2",
		"approved",
	);
	await harness.getCommand().handler("crews", harness.ctx);
	const content = (harness.entries.at(-1)?.data as { content: string }).content;
	assert.deepEqual(content.split("\n"), [
		"Guest crews:",
		"- alpha — Alpha — Alex — pending (remote-request-1)",
		"- beta — Beta — Alex — approved (remote-member)",
	]);
	assert.ok(!content.includes("/tmp/member"), "member sockets must never render");
	assert.ok(!content.includes("/tmp/guest-callback.sock"), "callback endpoints must never render");
});

test("/guest join sends the wire command and tracks the pending request", async () => {
	const harness = guestSetup();
	await harness.getCommand().handler("join /tmp/member.sock --as Alex", harness.ctx);
	assert.deepEqual(harness.joinCalls, [
		{
			target: "/tmp/member.sock",
			command: {
				type: "guest_join",
				guestIdentity: "guest-session-1",
				guestName: "Alex",
				callbackEndpoint: "/tmp/guest-callback.sock",
			},
		},
	]);
	assert.deepEqual(harness.notifications, [
		{ message: "Guest admission pending remote-request-1 for Alpha", level: "info" },
	]);
	assert.deepEqual(
		harness.guestRuntime.list().map((row) => ({ status: row.status, requestId: row.requestId, crew: row.crew.id })),
		[{ status: "pending", requestId: "remote-request-1", crew: "alpha" }],
	);
});

test("/guest join reports admission instead of membership when already approved", async () => {
	const harness = guestSetup();
	(harness.joinCalls[0] as unknown) = undefined;
	harness.joinCalls.length = 0;
	registerGuestControlCommand(harness.pi, harness.state, {
		ensureControlServer: async (_pi, state, ctx) => {
			state.server = {} as never;
			state.socketPath = "/tmp/guest-callback.sock";
			state.context = ctx;
		},
		guestMembershipRuntime: harness.guestRuntime,
		guestIdentity: () => "guest-session-1",
		sendJoin: async () => wireResponse({ status: "approved", requestId: "remote-request-9", crew: CREW }),
	});
	await harness.getCommand().handler("join /tmp/member.sock --as Alex", harness.ctx);
	assert.deepEqual(harness.notifications, [{ message: "Guest admitted to Alpha", level: "info" }]);
	assert.equal(harness.guestRuntime.list()[0]?.status, "approved");
});

test("/guest join surfaces remote rejections and invalid admission responses", async () => {
	const harness = guestSetup();
	registerGuestControlCommand(harness.pi, harness.state, {
		ensureControlServer: async (_pi, state, ctx) => {
			state.server = {} as never;
			state.socketPath = "/tmp/guest-callback.sock";
			state.context = ctx;
		},
		guestMembershipRuntime: harness.guestRuntime,
		guestIdentity: () => "guest-session-1",
		sendJoin: async () => ({ response: { success: false, error: "name-collision" } }) as RpcCommandResult,
	});
	await harness.getCommand().handler("join /tmp/member.sock --as Alex", harness.ctx);
	assert.deepEqual(harness.notifications, [{ message: "Guest join failed: name-collision", level: "error" }]);
	assert.deepEqual(harness.guestRuntime.list(), []);

	registerGuestControlCommand(harness.pi, harness.state, {
		ensureControlServer: async (_pi, state, ctx) => {
			state.server = {} as never;
			state.socketPath = "/tmp/guest-callback.sock";
			state.context = ctx;
		},
		guestMembershipRuntime: harness.guestRuntime,
		guestIdentity: () => "guest-session-1",
		sendJoin: async () => ({ response: { success: true, data: { bogus: true } } }) as RpcCommandResult,
	});
	await harness.getCommand().handler("join /tmp/member.sock --as Alex", harness.ctx);
	assert.deepEqual(harness.notifications.at(-1), {
		message: "Guest join failed: invalid admission response",
		level: "error",
	});
	assert.deepEqual(harness.guestRuntime.list(), []);
});

test("/guest join fails closed on transport errors and untrusted projects", async () => {
	const harness = guestSetup();
	registerGuestControlCommand(harness.pi, harness.state, {
		ensureControlServer: async () => {
			throw new Error("ECONNREFUSED");
		},
		guestMembershipRuntime: harness.guestRuntime,
		guestIdentity: () => "guest-session-1",
	});
	await harness.getCommand().handler("join /tmp/member.sock --as Alex", harness.ctx);
	assert.deepEqual(harness.notifications, [{ message: "Guest join failed: ECONNREFUSED", level: "error" }]);
	assert.deepEqual(harness.guestRuntime.list(), []);

	const untrusted = guestSetup();
	(untrusted.ctx as { isProjectTrusted: () => boolean }).isProjectTrusted = () => false;
	await untrusted.getCommand().handler("join /tmp/member.sock --as Alex", untrusted.ctx);
	assert.deepEqual(untrusted.notifications, [
		{ message: "Guest join failed: project is not trusted", level: "error" },
	]);
	assert.deepEqual(untrusted.joinCalls, []);
});

test("/guest leave revokes remotely before leaving locally and keeps membership on failure", async () => {
	const guestRuntime = runtime();
	guestRuntime.track(
		{ crew: CREW, guestName: "Alex", memberSocket: "/tmp/member.sock", submittedByMember: "member" },
		"remote-request-1",
	);
	const harness = guestSetup(guestRuntime);

	await harness.getCommand().handler("leave alpha", harness.ctx);
	assert.deepEqual(harness.leaveCalls, [
		{
			target: "/tmp/member.sock",
			command: {
				type: "guest_leave",
				guestIdentity: "guest-session-1",
				crewId: "alpha",
				callbackEndpoint: "/tmp/guest-callback.sock",
			},
		},
	]);
	assert.deepEqual(harness.notifications, [{ message: "Guest left crew alpha", level: "info" }]);
	assert.deepEqual(guestRuntime.list(), []);

	const keptRuntime = runtime();
	keptRuntime.track(
		{ crew: CREW, guestName: "Alex", memberSocket: "/tmp/member.sock", submittedByMember: "member" },
		"remote-request-1",
	);
	const kept = guestSetup(keptRuntime);
	registerGuestControlCommand(kept.pi, kept.state, {
		ensureControlServer: async (_pi, state, ctx) => {
			state.server = {} as never;
			state.socketPath = "/tmp/guest-callback.sock";
			state.context = ctx;
		},
		guestMembershipRuntime: keptRuntime,
		guestIdentity: () => "guest-session-1",
		sendLeave: async () => ({ response: { success: false, error: "not-found" } }) as RpcCommandResult,
	});
	await kept.getCommand().handler("leave alpha", kept.ctx);
	assert.deepEqual(kept.notifications, [{ message: "Guest leave failed: not-found", level: "error" }]);
	assert.equal(keptRuntime.list().length, 1, "local membership must survive a remote rejection");

	const offline = guestSetup(keptRuntime);
	registerGuestControlCommand(offline.pi, offline.state, {
		ensureControlServer: async (_pi, state, ctx) => {
			state.server = {} as never;
			state.socketPath = "/tmp/guest-callback.sock";
			state.context = ctx;
		},
		guestMembershipRuntime: keptRuntime,
		guestIdentity: () => "guest-session-1",
		sendLeave: async () => {
			throw new Error("ECONNREFUSED");
		},
	});
	await offline.getCommand().handler("leave alpha", offline.ctx);
	assert.deepEqual(offline.notifications, [{ message: "Guest leave failed: ECONNREFUSED", level: "error" }]);
	assert.equal(keptRuntime.list().length, 1);
});

test("/guest leave fails closed when no callback endpoint is available", async () => {
	const guestRuntime = runtime();
	guestRuntime.track(
		{ crew: CREW, guestName: "Alex", memberSocket: "/tmp/member.sock", submittedByMember: "member" },
		"remote-request-1",
	);
	const harness = guestSetup(guestRuntime);
	registerGuestControlCommand(harness.pi, harness.state, {
		ensureControlServer: async (_pi, state) => {
			state.server = {} as never;
			state.socketPath = null;
		},
		guestMembershipRuntime: guestRuntime,
		guestIdentity: () => "guest-session-1",
	});
	await harness.getCommand().handler("leave alpha", harness.ctx);
	assert.deepEqual(harness.leaveCalls, []);
	assert.deepEqual(harness.notifications, [
		{ message: "Guest leave failed: callback endpoint is unavailable", level: "error" },
	]);
	assert.equal(guestRuntime.list().length, 1, "membership must survive when revocation is impossible");
});

test("/guest leave for an unknown crew stays local and reports the miss", async () => {
	const harness = guestSetup();
	await harness.getCommand().handler("leave beta", harness.ctx);
	assert.deepEqual(harness.leaveCalls, []);
	assert.deepEqual(harness.notifications, [{ message: "Guest is not joined to crew beta", level: "info" }]);
});

test("formatGuestCrews keeps pending request ids visible for idempotent retries", () => {
	const guestRuntime = runtime();
	assert.equal(formatGuestCrews(guestRuntime), "Guest is not joined to any crew.");
	guestRuntime.track(
		{ crew: CREW, guestName: "Alex", memberSocket: "/tmp/member.sock", submittedByMember: "member" },
		"remote-request-1",
	);
	assert.match(formatGuestCrews(guestRuntime), /alpha — Alpha — Alex — pending \(remote-request-1\)/);
});
