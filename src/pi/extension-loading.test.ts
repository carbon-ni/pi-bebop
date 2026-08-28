import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const sandboxHome = await mkdtemp(path.join(os.tmpdir(), "bebop-extension-home-"));
const previousHome = process.env.HOME;
process.env.HOME = sandboxHome;
const { default: extension } = await import("../extension.ts");

const MEMBERSHIP_TOOLS = [
	"send_member_request",
	"respond_to_member_request",
	"wait_for_request_outcome",
	"send_follow_up",
	"redirect_member",
	"send_to_inbox",
	"send_to_crew",
	"broadcast_to_crew",
	"interrupt_member",
	"get_member_status",
	"wait_for_member_idle",
	"leave_crew_post",
	"read_crew_board",
];

test.after(async () => {
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	await rm(sandboxHome, { recursive: true, force: true });
});

type LifecycleHarness = {
	readonly root: string;
	readonly sessionId: string;
	readonly socketPath: string;
	readonly context: unknown;
	readonly handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
	readonly notifications: string[];
	readonly entries: string[];
	readonly activeTools: string[];
	readonly activeToolCalls: string[][];
	readonly sentMessages: unknown[];
	readonly clearPresenceFailure: () => void;
};

async function createLifecycleHarness(options: {
	hasUI: boolean;
	failPresence: boolean;
	presenceNotifications?: boolean;
}): Promise<LifecycleHarness> {
	const root = await mkdtemp(path.join(os.tmpdir(), "bebop-lifecycle-"));
	const sessionId = path.basename(root);
	const socketPath = path.join(root, ".pi", "bebop", "sockets", "dev.sock");
	await mkdir(path.dirname(socketPath), { recursive: true });
	await writeFile(
		path.join(root, ".pi", "bebop", "crew.json"),
		JSON.stringify({
			version: 1,
			members: [{ name: "Dev", role: "developer", socket: "sockets/dev.sock" }],
			presence: { notifications: options.presenceNotifications ?? true },
		}),
	);
	let failPresence = false;
	let cleanupSafe = false;
	const notifications: string[] = [];
	const entries: string[] = [];
	const sentMessages: unknown[] = [];
	const registeredTools = [...MEMBERSHIP_TOOLS];
	const activeTools = ["read", ...registeredTools];
	const activeToolCalls: string[][] = [];
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const pi = {
		registerFlag() {},
		registerMessageRenderer() {},
		registerEntryRenderer() {},
		registerTool() {},
		registerCommand() {},
		getAllTools: () => registeredTools.map((name) => ({ name })),
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => {
			activeTools.splice(0, activeTools.length, ...names);
			activeToolCalls.push([...names]);
		},
		getFlag: (name: string) => (name === "crew-socket" ? socketPath : false),
		setSessionName: (name: string) => {
			if (!cleanupSafe && options.failPresence && name) failPresence = true;
		},
		appendEntry: (entryType: string) => {
			entries.push(entryType);
			if (entryType === "intray-session-name" && options.failPresence) failPresence = true;
		},
		sendMessage: (message: unknown) => sentMessages.push(message),
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
	};
	const context = {
		cwd: root,
		hasUI: options.hasUI,
		ui: {
			notify: (message: string, level?: string) => {
				if (level === "error") notifications.push(message);
			},
			setStatus() {},
			theme: { fg: (_color: string, value: string) => value },
		},
		isProjectTrusted: () => true,
		sessionManager: {
			getSessionId: () => {
				if (failPresence && !cleanupSafe) {
					failPresence = false;
					throw new Error("private/tmp/presence-secret");
				}
				return sessionId;
			},
			getSessionName: () => undefined,
			getBranch: () => [],
			getEntries: () => [],
		},
	};
	extension(pi as never);
	return {
		root,
		sessionId,
		socketPath,
		context,
		handlers,
		notifications,
		entries,
		activeTools,
		activeToolCalls,
		sentMessages,
		clearPresenceFailure: () => {
			failPresence = false;
			cleanupSafe = true;
		},
	};
}

async function runPresenceFailure(
	hasUI: boolean,
): Promise<{ message: string; harness: LifecycleHarness; reportCount: number }> {
	const harness = await createLifecycleHarness({ hasUI, failPresence: true });
	const errors: string[] = [];
	const originalError = console.error;
	console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
	try {
		await harness.handlers.get("session_start")?.({}, harness.context);
		const result = {
			message: hasUI ? (harness.notifications.at(-1) ?? "") : (errors.at(-1) ?? ""),
			harness,
			reportCount: hasUI ? harness.notifications.length : errors.length,
		};
		harness.clearPresenceFailure();
		return result;
	} finally {
		console.error = originalError;
		harness.clearPresenceFailure();
		await harness.handlers.get("session_shutdown")?.({}, harness.context);
		await rm(harness.root, { recursive: true, force: true });
	}
}

async function runReleaseFailure(hasUI: boolean): Promise<{
	message: string;
	harness: LifecycleHarness;
	socketExists: boolean;
	reportCount: number;
	shutdownToolCalls: number;
}> {
	const harness = await createLifecycleHarness({ hasUI, failPresence: false });
	await harness.handlers.get("session_start")?.({}, harness.context);
	const startupToolCalls = harness.activeToolCalls.length;
	// Ignore the normal startup presence announcement; the failure path itself
	// must not send a model message or trigger a custom turn.
	harness.sentMessages.splice(0);
	await writeFile(`${harness.socketPath}.claim`, "held");
	const errors: string[] = [];
	const originalError = console.error;
	console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
	try {
		await harness.handlers.get("session_shutdown")?.({}, harness.context);
		const socket = path.join(sandboxHome, ".pi", "intray", `${harness.sessionId}.sock`);
		const socketExists = await access(socket).then(
			() => true,
			() => false,
		);
		return {
			message: hasUI ? (harness.notifications.at(-1) ?? "") : (errors.at(-1) ?? ""),
			harness,
			socketExists,
			reportCount: hasUI ? harness.notifications.length : errors.length,
			shutdownToolCalls: harness.activeToolCalls.length - startupToolCalls,
		};
	} finally {
		console.error = originalError;
		await rm(harness.root, { recursive: true, force: true });
	}
}

test("public lifecycle failures have one byte-identical UI/headless report and no model turn", async () => {
	const ui = await runPresenceFailure(true);
	const headless = await runPresenceFailure(false);
	assert.equal(ui.message, headless.message);
	assert.equal(ui.reportCount, 1);
	assert.equal(headless.reportCount, 1);
	assert.match(ui.message, /^Crew extension lifecycle failed:/);
	assert.match(ui.message, /Next:/);
	assert.match(ui.message, /\(code: unexpected-failure\)$/);
	assert.equal(ui.harness.notifications.length, 1);
	assert.equal(headless.harness.notifications.length, 0);
	for (const result of [ui, headless]) {
		assert.equal(result.harness.sentMessages.length, 0);
		assert.equal(result.harness.entries.includes("bebop-session-message"), false);
		assert.equal(result.harness.activeTools.includes("send_follow_up"), false);
	}
});

test("session_shutdown reports release failure once and still cleans server and tools", async () => {
	const ui = await runReleaseFailure(true);
	const headless = await runReleaseFailure(false);
	assert.equal(ui.message, headless.message);
	assert.equal(ui.reportCount, 1);
	assert.equal(headless.reportCount, 1);
	assert.match(ui.message, /^Crew extension lifecycle failed:/);
	assert.match(ui.message, /\(code: unexpected-failure\)$/);
	assert.equal(ui.harness.notifications.length, 1);
	assert.equal(headless.harness.notifications.length, 0);
	for (const result of [ui, headless]) {
		assert.equal(result.socketExists, false);
		assert.equal(result.harness.activeTools.includes("send_follow_up"), false);
		assert.equal(result.shutdownToolCalls, 1);
		assert.equal(result.harness.activeToolCalls.filter((names) => !names.includes("send_follow_up")).length, 1);
		assert.equal(result.harness.sentMessages.length, 0);
		assert.equal(result.harness.entries.includes("bebop-session-message"), false);
	}
});

test("role rejection preflight leaves control server untouched for invalid, empty, missing, ambiguous, and resolver failure", async () => {
	const cases: Array<{ name: string; role: string; setup?: (root: string) => Promise<void> }> = [
		{ name: "invalid", role: "\0" },
		{ name: "empty", role: "   " },
		{ name: "missing", role: "developer" },
		{
			name: "ambiguous",
			role: "developer",
			setup: async (root) => {
				const manifest = JSON.stringify({
					version: 1,
					members: [{ name: "dev", role: "developer", socket: "sockets/dev.sock" }],
				});
				await mkdir(path.join(root, ".pi", "bebop"), { recursive: true });
				await mkdir(path.join(root, ".pi", "crew"), { recursive: true });
				await writeFile(path.join(root, ".pi", "bebop", "crew.json"), manifest);
				await writeFile(path.join(root, ".pi", "crew", "crew.json"), manifest);
			},
		},
		{
			name: "resolver failure",
			role: "developer",
			setup: async (root) => {
				await mkdir(path.join(root, ".pi", "bebop"), { recursive: true });
				await writeFile(path.join(root, ".pi", "bebop", "crew.json"), "{ invalid");
			},
		},
	];
	for (const item of cases) {
		const root = await mkdtemp(path.join(os.tmpdir(), "bebop-role-preflight-"));
		try {
			await item.setup?.(root);
			let sessionManagerAccesses = 0;
			const notifications: string[] = [];
			let sessionStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
			const pi = {
				registerFlag() {},
				registerMessageRenderer() {},
				registerEntryRenderer() {},
				registerTool() {},
				registerCommand() {},
				getAllTools: () => MEMBERSHIP_TOOLS.map((name) => ({ name })),
				getActiveTools: () => [...MEMBERSHIP_TOOLS],
				setActiveTools() {},
				getFlag: (name: string) => (name === "crew-role" ? item.role : false),
				on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
					if (event === "session_start") sessionStart = handler;
				},
			} as never;
			extension(pi);
			const ctx = {
				cwd: root,
				hasUI: true,
				ui: { notify: (message: string) => notifications.push(message) },
				isProjectTrusted: () => true,
				sessionManager: new Proxy(
					{},
					{
						get() {
							sessionManagerAccesses += 1;
							throw new Error("control server started");
						},
					},
				),
			} as never;
			await sessionStart?.({}, ctx);
			assert.equal(sessionManagerAccesses, 0, item.name);
			const failure = notifications.at(-1) ?? "";
			assert.match(failure, /^Crew startup/, item.name);
			assert.match(failure, /Next:/, item.name);
			assert.match(failure, /\(code: [a-z-]+\)$/, item.name);
			assert.doesNotMatch(failure, /private\/tmp|token=|invalid JSON/i, item.name);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}
});

test("TASK-0076: packaged tool descriptions present one non-contradictory requester/responder affordance set", () => {
	const descriptions = new Map<string, string>();
	const pi = {
		registerFlag() {},
		registerMessageRenderer() {},
		registerEntryRenderer() {},
		registerTool(tool: { name: string; description?: string }) {
			descriptions.set(tool.name, tool.description ?? "");
		},
		registerCommand() {},
		getAllTools: () => [],
		setActiveTools() {},
		on() {},
	} as never;

	assert.doesNotThrow(() => extension(pi));
	const followUp = descriptions.get("send_follow_up") ?? "";
	const send = descriptions.get("send_member_request") ?? "";
	const respond = descriptions.get("respond_to_member_request") ?? "";
	const wait = descriptions.get("wait_for_request_outcome") ?? "";
	// No contradictory "default" guidance ahead of the request-specific rule.
	assert.doesNotMatch(followUp, /by default|default coordination/i);
	assert.match(followUp, /no correlated Response is expected/i);
	assert.match(followUp, /send_member_request/i);
	// Requester side: send then wait.
	assert.match(send, /requester-side/i);
	assert.match(send, /wait_for_request_outcome/i);
	assert.match(wait, /requester-side/i);
	assert.match(wait, /only after you sent a Member request/i);
	assert.match(wait, /never handles inbound/i);
	// Responder side: only inbound.
	assert.match(respond, /responder-side/i);
	assert.match(respond, /inbound Member request/i);
});

test("fresh extension load registers membership tools and renderers without calling action methods", () => {
	const flags: string[] = [];
	const tools: string[] = [];
	const commands: string[] = [];
	const renderers: string[] = [];
	const entryRenderers: string[] = [];
	let setActiveCalls = 0;
	const pi = {
		registerFlag(name: string) {
			flags.push(name);
		},
		registerMessageRenderer(name: string) {
			renderers.push(name);
		},
		registerEntryRenderer(name: string) {
			entryRenderers.push(name);
		},
		registerTool(tool: { name: string }) {
			tools.push(tool.name);
		},
		registerCommand(name: string) {
			commands.push(name);
		},
		getAllTools: () => tools.map((name) => ({ name })),
		setActiveTools() {
			setActiveCalls += 1;
		},
		on() {},
	} as never;

	assert.doesNotThrow(() => extension(pi));
	assert.deepEqual(flags, ["crew", "crew-socket", "crew-role"]);
	// Registered (getAllTools) on fresh load.
	assert.deepEqual(tools, MEMBERSHIP_TOOLS);
	assert.deepEqual(commands, ["crew"]);
	assert.equal(renderers.includes("crew-presence"), true);
	assert.equal(renderers.includes("crew-interrupt"), true);

	// Pi's extension runtime forbids action methods (getActiveTools/setActiveTools)
	// during extension loading; the factory must not call them.
	assert.equal(setActiveCalls, 0, "extension load must not call setActiveTools");

	// Management output renders via TUI-only entry renderers (not LLM context).
	assert.equal(entryRenderers.includes("crew-roster"), true);
	assert.equal(entryRenderers.includes("crew-status"), true);
	assert.equal(entryRenderers.includes("crew-inbox"), true);
});

test("unjoined session_start deactivates auto-activated membership tools and keeps system prompt byte-identical", async () => {
	const flags: string[] = [];
	const tools: string[] = [];
	const commands: string[] = [];
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	// Pi auto-activates registered extension tools at construction.
	let active: string[] = ["read", "bash", "edit", "write", ...MEMBERSHIP_TOOLS];
	const setActiveCalls: string[][] = [];
	const pi = {
		registerFlag(name: string) {
			flags.push(name);
		},
		registerMessageRenderer() {},
		registerEntryRenderer() {},
		registerTool(tool: { name: string }) {
			tools.push(tool.name);
		},
		registerCommand(name: string) {
			commands.push(name);
		},
		getActiveTools: () => [...active],
		getAllTools: () => tools.map((name) => ({ name })),
		setActiveTools(names: string[]) {
			active = names;
			setActiveCalls.push(names);
		},
		appendEntry() {},
		getFlag: () => false,
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			handlers.set(event, handler);
		},
	} as never;

	extension(pi);
	assert.deepEqual(tools, MEMBERSHIP_TOOLS);

	// New unjoined session: no persisted membership, no crew flags.
	const ctx = {
		hasUI: true,
		ui: { notify: () => {} },
		isProjectTrusted: () => true,
		cwd: "/project",
		sessionManager: { getSessionId: () => "local", getSessionName: () => "local-name" },
	} as never;
	await handlers.get("session_start")!({}, ctx);
	// Unjoined reconcile removes every membership tool from the provider-active
	// schema before the first possible agent request; unrelated tools preserved.
	assert.deepEqual(active, ["read", "bash", "edit", "write"]);
	assert.ok(
		setActiveCalls.some((names) => names.length === 4 && !names.some((n) => MEMBERSHIP_TOOLS.includes(n))),
		"session_start must deactivate membership tools exactly once",
	);

	// before_agent_start returns no replacement prompt for an unjoined session.
	const event = { systemPrompt: "Base system" } as never;
	const result = await handlers.get("before_agent_start")!(event, ctx);
	assert.equal(result, undefined, "unjoined before_agent_start must be byte-identical (no replacement)");
});
