import test from "node:test";
import assert from "node:assert/strict";

import extension from "../extension.ts";

const MEMBERSHIP_TOOLS = [
	"send_member_request",
	"respond_to_member_request",
	"wait_for_request_outcome",
	"send_follow_up",
	"redirect_member",
	"send_to_inbox",
	"broadcast_to_crew",
	"interrupt_member",
	"get_member_status",
	"update_member_focus",
	"wait_for_member_idle",
];

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
