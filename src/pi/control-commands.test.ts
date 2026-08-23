import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createSocketState } from "./control-runtime.ts";
import { registerSessionControlCommand, type ControlCommandDeps } from "./control-commands.ts";
import { createMembershipRuntime, type MembershipRuntime } from "../infra/membership-runtime.ts";
import { parseCrewManifest } from "../domain/index.ts";

function setup() {
	let command:
		| {
				handler: (args: string, ctx: ExtensionContext) => Promise<void>;
				getArgumentCompletions: (prefix: string) => unknown;
		  }
		| undefined;
	const notifications: string[] = [];
	const entries: Array<{ customType: string; data?: unknown }> = [];
	const messages: Array<{ content: string; customType?: string; options?: unknown }> = [];
	const pi = {
		registerCommand: (_name: string, definition: typeof command) => {
			command = definition;
		},
		sendMessage: (message: { content: string; customType?: string }, options?: unknown) =>
			messages.push({ content: message.content, customType: message.customType, options }),
		appendEntry: (customType: string, data?: unknown) => entries.push({ customType, data }),
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: true,
		ui: { notify: (message: string) => notifications.push(message) },
		isProjectTrusted: () => true,
		cwd: "/project",
		sessionManager: { getSessionId: () => "local", getSessionName: () => "local-name" },
	} as unknown as ExtensionContext;
	const state = createSocketState();
	return { pi, ctx, state, notifications, entries, messages, getCommand: () => command! };
}

function baseDeps(overrides: Partial<ControlCommandDeps> = {}): ControlCommandDeps {
	return {
		disableControlServer: async (state) => {
			state.server = null;
		},
		...overrides,
	};
}

test("crew command completions expose only the consolidated command surface", async () => {
	const setupState = setup();
	registerSessionControlCommand(setupState.pi, setupState.state, baseDeps());
	const values = (setupState.getCommand().getArgumentCompletions("") as Array<{ value: string }>).map(
		({ value }) => value,
	);
	assert.deepEqual(values, ["join", "leave", "members", "status", "stop", "inbox"]);
	assert.match((setupState.getCommand() as any).description, /crew members/i);
	await setupState.getCommand().handler("list", setupState.ctx);
	assert.deepEqual(setupState.notifications, [
		"Unknown crew action: list. Use /crew join <socket>|leave|members|status|stop|inbox status|cancel <id>|pause|resume.",
	]);
});

test("/crew join and leave use membership runtime without stopping base server", async () => {
	const setupState = setup();
	const calls: Array<{ operation: string; value?: unknown }> = [];
	const persisted: boolean[] = [];
	const announcements: string[] = [];
	const activation: string[] = [];
	let refreshes = 0;
	let presenceRefreshes = 0;
	let currentMembership: MembershipRuntime["getMembership"] extends () => infer T ? T : never = null;
	const runtime = {
		join: async (request: unknown) => {
			calls.push({ operation: "join", value: request });
			currentMembership = {
				manifestPath: "/project/.pi/bebop/crew.json",
				socketPath: "/project/.pi/bebop/sockets/dev.sock",
				globalSocketPath: "/tmp/global.sock",
				member: {
					name: "dev",
					role: "developer",
					socket: "sockets/dev.sock",
					socketPath: "/project/.pi/bebop/sockets/dev.sock",
				},
			};
			return { ok: true, membership: currentMembership, idempotent: false };
		},
		leave: async () => {
			calls.push({ operation: "leave" });
			currentMembership = null;
			return { ok: true, left: true };
		},
		getMembership: () => currentMembership,
	} as unknown as MembershipRuntime;
	registerSessionControlCommand(
		setupState.pi,
		setupState.state,
		baseDeps({
			membershipRuntime: runtime,
			persistMembership: (active) => persisted.push(active),
			announceMembership: (message) => announcements.push(message),
			activateMembershipTool: () => activation.push("activate"),
			deactivateMembershipTool: () => activation.push("deactivate"),
			refreshStatus: () => {
				refreshes += 1;
			},
			refreshPresence: () => {
				presenceRefreshes += 1;
			},
			ensureControlServer: async (_pi, state, ctx) => {
				state.server = {} as never;
				state.socketPath = "/tmp/global.sock";
				state.context = ctx;
			},
		}),
	);

	await setupState.getCommand().handler("join '.pi/bebop/sockets/dev.sock'", setupState.ctx);
	assert.equal(calls[0]?.operation, "join");
	assert.deepEqual(calls[0]?.value, {
		manifestPath: "/project/.pi/bebop/crew.json",
		socketPath: "/project/.pi/bebop/sockets/dev.sock",
		globalSocketPath: "/tmp/global.sock",
	});
	assert.match(setupState.notifications[0]!, /dev \(developer\)/);
	await setupState.getCommand().handler("join '.pi/bebop/sockets/dev.sock'", setupState.ctx);
	assert.equal(presenceRefreshes, 2);
	assert.equal(setupState.ctx.sessionManager.getSessionName(), "local-name");
	await setupState.getCommand().handler("status", setupState.ctx);
	assert.match((setupState.entries.at(-1)!.data as { content: string }).content, /Crew: .*crew\.json/);
	assert.match((setupState.entries.at(-1)!.data as { content: string }).content, /Endpoint: .*dev\.sock/);
	await setupState.getCommand().handler("leave", setupState.ctx);
	assert.deepEqual(
		calls.map(({ operation }) => operation),
		["join", "join", "leave"],
	);
	assert.equal(setupState.state.server !== null, true);
	assert.deepEqual(persisted, [true, true, false]);
	assert.equal(announcements.length, 3);
	assert.deepEqual(activation, ["activate", "activate", "deactivate"]);
	assert.equal(refreshes, 3);
});

test("/crew join accepts both layouts and rejects arbitrary siblings before runtime join", async () => {
	for (const layout of ["bebop", "crew"]) {
		const state = setup();
		let joins = 0;
		const runtime = {
			join: async () => {
				joins += 1;
				return {
					ok: true,
					membership: {
						member: { name: "dev", role: "developer" },
						socketPath: `/project/.pi/${layout}/sockets/dev.sock`,
					},
					idempotent: false,
				};
			},
			leave: async () => ({ ok: true, left: false }),
			getMembership: () => null,
		} as unknown as MembershipRuntime;
		registerSessionControlCommand(
			state.pi,
			state.state,
			baseDeps({
				membershipRuntime: runtime,
				ensureControlServer: async (_pi, current, ctx) => {
					current.server = {} as never;
					current.socketPath = "/tmp/global.sock";
					current.context = ctx;
				},
			}),
		);
		await state.getCommand().handler(`join .pi/${layout}/sockets/dev.sock`, state.ctx);
		assert.equal(joins, 1);
	}
	const rejected = setup();
	let joins = 0;
	const runtime = {
		join: async () => {
			joins += 1;
			return { ok: false, error: new Error("must not join") };
		},
		leave: async () => ({ ok: true, left: false }),
		getMembership: () => null,
	} as unknown as MembershipRuntime;
	registerSessionControlCommand(
		rejected.pi,
		rejected.state,
		baseDeps({
			membershipRuntime: runtime,
			ensureControlServer: async (_pi, current, ctx) => {
				current.server = {} as never;
				current.socketPath = "/tmp/global.sock";
				current.context = ctx;
			},
		}),
	);
	await rejected.getCommand().handler("join .pi/other/sockets/dev.sock", rejected.ctx);
	assert.equal(joins, 0);
	assert.match(rejected.notifications[0]!, /untrusted crew manifest path/);
});

test("/crew join selects the external-root manifest for both layouts", async () => {
	for (const layout of ["bebop", "crew"]) {
		const state = setup();
		let request: unknown;
		const runtime = {
			join: async (value: unknown) => {
				request = value;
				return {
					ok: true,
					membership: {
						member: { name: "dev1", role: "developer" },
						socketPath: `/root-B/.pi/${layout}/sockets/dev1.sock`,
					},
					idempotent: false,
				};
			},
			leave: async () => ({ ok: true, left: false }),
			getMembership: () => null,
		} as unknown as MembershipRuntime;
		registerSessionControlCommand(
			state.pi,
			state.state,
			baseDeps({
				membershipRuntime: runtime,
				ensureControlServer: async (_pi, current, ctx) => {
					current.server = {} as never;
					current.socketPath = "/root-B/.pi/bebop/sockets/global.sock";
					current.context = ctx;
				},
			}),
		);
		await state.getCommand().handler(`join /root-B/.pi/${layout}/sockets/dev1.sock`, state.ctx);
		assert.deepEqual(request, {
			manifestPath: `/root-B/.pi/${layout}/crew.json`,
			socketPath: `/root-B/.pi/${layout}/sockets/dev1.sock`,
			globalSocketPath: "/root-B/.pi/bebop/sockets/global.sock",
		});
	}
});

test("/crew join rejects unsupported and unconfigured endpoints without joining", async () => {
	for (const target of [
		"/root-B/.pi/other/sockets/dev.sock",
		"/root-B/.pi/bebop/member.sock",
		"/root-B/.pi/bebop/sockets/../dev.sock",
	]) {
		const state = setup();
		let joins = 0;
		const runtime = {
			join: async () => {
				joins += 1;
				return { ok: false, error: new Error("must not claim") };
			},
			leave: async () => ({ ok: true, left: false }),
			getMembership: () => null,
		} as unknown as MembershipRuntime;
		registerSessionControlCommand(
			state.pi,
			state.state,
			baseDeps({
				membershipRuntime: runtime,
				ensureControlServer: async (_pi, current, ctx) => {
					current.server = {} as never;
					current.socketPath = "/tmp/global.sock";
					current.context = ctx;
				},
			}),
		);
		await state.getCommand().handler(`join ${target}`, state.ctx);
		assert.equal(joins, 0, target);
	}
	const state = setup();
	let claims = 0;
	const runtime = createMembershipRuntime({
		loadManifest: async () =>
			parseCrewManifest(
				{ version: 1, members: [{ name: "dev", role: "developer", socket: "sockets/dev.sock" }] },
				"/root-B/.pi/bebop/crew.json",
			),
		claimEndpoint: (async () => {
			claims += 1;
			return { idempotent: false };
		}) as never,
	});
	registerSessionControlCommand(
		state.pi,
		state.state,
		baseDeps({
			membershipRuntime: runtime,
			ensureControlServer: async (_pi, current, ctx) => {
				current.server = {} as never;
				current.socketPath = "/tmp/global.sock";
				current.context = ctx;
			},
		}),
	);
	await state.getCommand().handler("join /root-B/.pi/bebop/sockets/unknown.sock", state.ctx);
	assert.equal(claims, 0);
});

test("/crew join reports trust and runtime failures without claiming", async () => {
	const untrusted = setup();
	let joins = 0;
	const runtime = {
		join: async () => {
			joins += 1;
			return { ok: true, membership: undefined, idempotent: false };
		},
		leave: async () => ({ ok: true, left: false }),
		getMembership: () => null,
	} as unknown as MembershipRuntime;
	(untrusted.ctx as unknown as { isProjectTrusted: () => boolean }).isProjectTrusted = () => false;
	registerSessionControlCommand(
		untrusted.pi,
		untrusted.state,
		baseDeps({
			membershipRuntime: runtime,
			ensureControlServer: async (_pi, state, ctx) => {
				state.server = {} as never;
				state.socketPath = "/tmp/global.sock";
				state.context = ctx;
			},
		}),
	);
	await untrusted.getCommand().handler("join /tmp/project/.pi/bebop/sockets/dev.sock", untrusted.ctx);
	assert.equal(joins, 0);
	assert.deepEqual(untrusted.notifications, ["Crew join failed: project is not trusted"]);

	const failed = setup();
	const failingRuntime = {
		join: async () => ({ ok: false, error: new Error("claim failed") }),
		leave: async () => ({ ok: true, left: false }),
		getMembership: () => null,
	} as unknown as MembershipRuntime;
	registerSessionControlCommand(
		failed.pi,
		failed.state,
		baseDeps({
			membershipRuntime: failingRuntime,
			ensureControlServer: async (_pi, state, ctx) => {
				state.server = {} as never;
				state.socketPath = "/tmp/global.sock";
				state.context = ctx;
			},
		}),
	);
	await failed.getCommand().handler("join .pi/bebop/sockets/dev.sock", failed.ctx);
	assert.deepEqual(failed.notifications, ["Crew join failed: claim failed"]);
});

test("/crew members renders the manifest roster in order and never probes current", async () => {
	const setupState = setup();
	const members = [
		{ name: "lead", role: "lead", socket: "sockets/lead.sock", socketPath: "/project/.pi/bebop/sockets/lead.sock" },
		{ name: "Bob", role: "dev", socket: "sockets/Bob.sock", socketPath: "/project/.pi/bebop/sockets/Bob.sock" },
		{
			name: "Kelly",
			role: "qa",
			socket: "sockets/Kelly.sock",
			socketPath: "/project/.pi/bebop/sockets/Kelly.sock",
		},
	];
	setupState.state.membershipRuntime = {
		getMembership: () => ({
			manifestPath: "/project/.pi/bebop/crew.json",
			socketPath: members[1]!.socketPath,
			globalSocketPath: "/global/uuid.sock",
			member: members[1],
			manifest: { version: 1, members },
		}),
	} as never;
	const probes: string[] = [];
	const pending = new Map<string, (value: boolean) => void>();
	registerSessionControlCommand(
		setupState.pi,
		setupState.state,
		baseDeps({
			probeMemberEndpoint: async (path) => {
				probes.push(path);
				return await new Promise<boolean>((resolve) => pending.set(path, resolve));
			},
		}),
	);
	const listing = setupState.getCommand().handler("members", setupState.ctx);
	await Promise.resolve();
	assert.deepEqual(probes, [members[0]!.socketPath, members[2]!.socketPath]);
	pending.get(members[2]!.socketPath)!(false);
	pending.get(members[0]!.socketPath)!(true);
	await listing;
	assert.equal(setupState.entries[0]!.customType, "crew-roster");
	assert.equal(
		(setupState.entries[0]!.data as { content: string }).content,
		"Crew: /project/.pi/bebop/crew.json\nMembers (3):\n- lead (lead) — online — /project/.pi/bebop/sockets/lead.sock\n- Bob (dev) — current — /project/.pi/bebop/sockets/Bob.sock\n- Kelly (qa) — offline — /project/.pi/bebop/sockets/Kelly.sock",
	);
	assert.equal((setupState.entries[0]!.data as { content: string }).content.includes("global/uuid"), false);
	assert.equal(setupState.messages.length, 0, "roster must not participate in LLM context");
});

test("/crew members while unjoined gives exact guidance without probing", async () => {
	const setupState = setup();
	let probes = 0;
	registerSessionControlCommand(
		setupState.pi,
		setupState.state,
		baseDeps({
			probeMemberEndpoint: async () => {
				probes += 1;
				return true;
			},
		}),
	);
	await setupState.getCommand().handler("members", setupState.ctx);
	assert.equal(
		(setupState.entries[0]!.data as { content: string }).content,
		"Crew not joined. Use /crew join <socket>.",
	);
	assert.equal(probes, 0);
	assert.equal(setupState.messages.length, 0, "unjoined roster must not reach LLM context");
});

test("/crew members shows optional description on the same deterministic row", async () => {
	const setupState = setup();
	const members = [
		{ name: "Bob", role: "dev", socket: "sockets/Bob.sock", socketPath: "/project/.pi/bebop/sockets/Bob.sock" },
		{
			name: "Dave",
			role: "dev",
			socket: "sockets/Dave.sock",
			socketPath: "/project/.pi/bebop/sockets/Dave.sock",
			description: "Focuses on infrastructure",
		},
	];
	setupState.state.membershipRuntime = {
		getMembership: () => ({
			manifestPath: "/project/.pi/bebop/crew.json",
			socketPath: members[0]!.socketPath,
			globalSocketPath: "/global/uuid.sock",
			member: members[0],
			manifest: { version: 1, members },
		}),
	} as never;
	registerSessionControlCommand(
		setupState.pi,
		setupState.state,
		baseDeps({ probeMemberEndpoint: async () => false }),
	);
	await setupState.getCommand().handler("members", setupState.ctx);
	const content = (setupState.entries[0]!.data as { content: string }).content;
	assert.match(content, /- Bob \(dev\) — current — \/project\/\.pi\/bebop\/sockets\/Bob\.sock/);
	assert.match(
		content,
		/- Dave \(dev\) — offline — Focuses on infrastructure — \/project\/\.pi\/bebop\/sockets\/Dave\.sock/,
	);
	assert.equal(setupState.messages.length, 0, "roster must stay out of LLM context");
});

test("/crew leave releases before broadcasting offline and stopping presence", async () => {
	const setupState = setup();
	const events: string[] = [];
	const current = {
		manifestPath: "/project/.pi/bebop/crew.json",
		socketPath: "/project/.pi/bebop/sockets/dev.sock",
		globalSocketPath: "/global.sock",
		member: {
			name: "dev",
			role: "developer",
			socket: "sockets/dev.sock",
			socketPath: "/project/.pi/bebop/sockets/dev.sock",
		},
		manifest: { version: 1, presence: { notifications: true }, members: [] },
	} as never;
	const runtime = {
		getMembership: () => current,
		leave: async () => {
			events.push("release");
			return { ok: true, left: true };
		},
	} as never;
	registerSessionControlCommand(
		setupState.pi,
		setupState.state,
		baseDeps({
			membershipRuntime: runtime,
			stopPresence: () => {
				events.push("stop");
			},
		}),
	);
	await setupState.getCommand().handler("leave", setupState.ctx);
	assert.deepEqual(events, ["release", "stop"]);
});

test("/crew status and stop observe state and stop base resources", async () => {
	const setupState = setup();
	const calls: string[] = [];
	const runtime = {
		getMembership: () => null,
		leave: async () => {
			calls.push("leave");
			return { ok: true, left: false };
		},
	} as unknown as MembershipRuntime;
	registerSessionControlCommand(
		setupState.pi,
		setupState.state,
		baseDeps({
			membershipRuntime: runtime,
			disableControlServer: async () => {
				calls.push("stop");
			},
		}),
	);

	await setupState.getCommand().handler("status", setupState.ctx);
	assert.equal((setupState.entries[0]!.data as { content: string }).content, "Crew stopped");
	assert.equal(setupState.messages.length, 0, "status must not participate in LLM context");

	await setupState.getCommand().handler("stop", setupState.ctx);
	assert.deepEqual(calls, ["stop"]);
	assert.deepEqual(setupState.notifications, ["Bebop stopped"]);
});

test("/crew stop releases and persists active crew membership before cleanup", async () => {
	const setupState = setup();
	const calls: string[] = [];
	const persisted: boolean[] = [];
	const activation: string[] = [];
	let currentMembership: unknown = { member: { name: "dev", role: "developer" } };
	const runtime = {
		getMembership: () => currentMembership,
		leave: async () => {
			calls.push("leave");
			currentMembership = null;
			return { ok: true, left: true };
		},
	} as unknown as MembershipRuntime;
	registerSessionControlCommand(
		setupState.pi,
		setupState.state,
		baseDeps({
			membershipRuntime: runtime,
			persistMembership: (active) => persisted.push(active),
			deactivateMembershipTool: () => activation.push("deactivate"),
			disableControlServer: async () => {
				calls.push("stop");
			},
		}),
	);

	await setupState.getCommand().handler("stop", setupState.ctx);
	assert.deepEqual(calls, ["leave", "stop"]);
	assert.deepEqual(persisted, [false]);
	assert.deepEqual(activation, ["deactivate"]);
});

function fakeBridge(overrides: Record<string, unknown> = {}) {
	const calls: string[] = [];
	const bridge = {
		establish: () => calls.push("establish"),
		invalidate: () => calls.push("invalidate"),
		attemptOffer: async () => ({ offered: false as const, reason: "no-items" as const }),
		status: async () => ({
			offering: "active" as const,
			count: 2,
			outstanding: null,
			items: [
				{ id: "inbox-0-abc", sequence: 0, enqueuedAt: 1000, bytes: 24 },
				{ id: "inbox-1-def", sequence: 1, enqueuedAt: 1001, bytes: 24 },
			],
		}),
		cancel: async (id: string) => ({ removed: true, itemId: id }),
		setPaused: (paused: boolean) => calls.push(`setPaused:${paused}`),
		...overrides,
	} as never;
	return { bridge, calls };
}

test("/crew inbox status renders bounded pending metadata without content", async () => {
	const setupState = setup();
	const { bridge } = fakeBridge();
	registerSessionControlCommand(setupState.pi, setupState.state, baseDeps({ inboxBridge: bridge }));
	await setupState.getCommand().handler("inbox status", setupState.ctx);
	assert.equal(setupState.notifications.length, 0);
	assert.equal(setupState.messages.length, 0, "inbox status must not participate in LLM context");
	assert.equal(setupState.entries[0]!.customType, "crew-inbox");
	assert.match((setupState.entries[0]!.data as { content: string }).content, /Inbox active/);
	assert.match((setupState.entries[0]!.data as { content: string }).content, /2 pending/);
	assert.ok((setupState.entries[0]!.data as { content: string }).content.includes("inbox-0-abc"));
});

test("/crew inbox pause and resume control automatic offering", async () => {
	const setupState = setup();
	const { bridge, calls } = fakeBridge();
	registerSessionControlCommand(setupState.pi, setupState.state, baseDeps({ inboxBridge: bridge }));
	await setupState.getCommand().handler("inbox pause", setupState.ctx);
	await setupState.getCommand().handler("inbox resume", setupState.ctx);
	assert.deepEqual(calls, ["setPaused:true", "setPaused:false"]);
	assert.match(setupState.notifications[0]!, /paused/i);
	assert.match(setupState.notifications[1]!, /resumed/i);
});

test("/crew inbox cancel removes a pending item and reports not-found idempotently", async () => {
	const setupState = setup();
	const cancelCalls: string[] = [];
	const { bridge } = fakeBridge({
		cancel: async (id: string) => {
			cancelCalls.push(id);
			return cancelCalls.length === 1 ? { removed: true, itemId: id } : { removed: false, reason: "not-found" };
		},
	});
	registerSessionControlCommand(setupState.pi, setupState.state, baseDeps({ inboxBridge: bridge }));
	await setupState.getCommand().handler("inbox cancel inbox-0-abc", setupState.ctx);
	await setupState.getCommand().handler("inbox cancel inbox-0-abc", setupState.ctx);
	assert.deepEqual(cancelCalls, ["inbox-0-abc", "inbox-0-abc"]);
	assert.match(setupState.notifications[0]!, /cancelled: inbox-0-abc/);
	assert.match(setupState.notifications[1]!, /not found: inbox-0-abc/);
});

test("/crew inbox reports missing bridge and malformed subcommands", async () => {
	const setupState = setup();
	registerSessionControlCommand(setupState.pi, setupState.state, baseDeps());
	await setupState.getCommand().handler("inbox status", setupState.ctx);
	assert.deepEqual(setupState.notifications, ["Inbox bridge unavailable"]);
	assert.equal(setupState.messages.length, 0);

	await setupState.getCommand().handler("inbox bogus", setupState.ctx);
	assert.match(setupState.notifications[1]!, /Unknown inbox action: bogus/);
	await setupState.getCommand().handler("inbox cancel", setupState.ctx);
	assert.match(setupState.notifications[2]!, /Missing target. Use \/crew inbox cancel <id>\./);
});

test("/crew join establishes the inbox bridge and leave invalidates it", async () => {
	const setupState = setup();
	const { bridge, calls } = fakeBridge();
	const currentMembership = {
		manifestPath: "/project/.pi/bebop/crew.json",
		socketPath: "/project/.pi/bebop/sockets/dev.sock",
		globalSocketPath: "/tmp/global.sock",
		member: {
			name: "dev",
			role: "developer",
			socket: "sockets/dev.sock",
			socketPath: "/project/.pi/bebop/sockets/dev.sock",
		},
		manifest: { version: 1, members: [], presence: { notifications: true } },
	};
	let membership: unknown = null;
	const runtime = {
		join: async () => {
			membership = currentMembership;
			return { ok: true, membership: currentMembership, idempotent: false };
		},
		leave: async () => {
			membership = null;
			return { ok: true, left: true };
		},
		getMembership: () => membership,
	} as unknown as MembershipRuntime;
	registerSessionControlCommand(
		setupState.pi,
		setupState.state,
		baseDeps({
			membershipRuntime: runtime,
			inboxBridge: bridge,
			ensureControlServer: async (_pi, current, ctx) => {
				current.server = {} as never;
				current.socketPath = "/tmp/global.sock";
				current.context = ctx;
			},
		}),
	);
	await setupState.getCommand().handler("join '.pi/bebop/sockets/dev.sock'", setupState.ctx);
	assert.ok(calls.includes("establish"));
	await setupState.getCommand().handler("leave", setupState.ctx);
	assert.ok(calls.includes("invalidate"));
});
