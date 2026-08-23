import test from "node:test";
import assert from "node:assert/strict";

import extension from "../extension.ts";

const MEMBERSHIP_TOOLS = [
	"send_follow_up",
	"redirect_member",
	"send_to_inbox",
	"broadcast_to_crew",
	"interrupt_member",
];

test("fresh extension load registers membership tools but leaves them inactive and preserves unrelated tools", () => {
	const flags: string[] = [];
	const tools: string[] = [];
	const commands: string[] = [];
	const renderers: string[] = [];
	const entryRenderers: string[] = [];
	let active: string[] = ["read", "bash", "edit", "write"];
	const setActiveCalls: string[][] = [];
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
			// Pi auto-activates newly registered extension tools; the extension must
			// reconcile this away for membership tools (unjoined footprint is zero).
			active.push(tool.name);
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
		on() {},
	} as never;

	assert.doesNotThrow(() => extension(pi));
	assert.deepEqual(flags, ["crew", "crew-socket"]);
	assert.deepEqual(tools, MEMBERSHIP_TOOLS);
	assert.deepEqual(commands, ["crew"]);
	assert.equal(renderers.includes("crew-presence"), true);
	assert.equal(renderers.includes("crew-interrupt"), true);

	// Registered (getAllTools) but NOT active (getActiveTools) on fresh load.
	assert.deepEqual(tools, MEMBERSHIP_TOOLS);
	assert.equal(active.includes("send_follow_up"), false);
	assert.equal(active.includes("redirect_member"), false);
	assert.equal(active.includes("send_to_inbox"), false);
	assert.equal(active.includes("broadcast_to_crew"), false);
	assert.equal(active.includes("interrupt_member"), false);
	// Unrelated built-in tools are preserved in order.
	assert.deepEqual(active, ["read", "bash", "edit", "write"]);
	// A reconcile call removed the membership tools.
	assert.ok(setActiveCalls.some((names) => names.length === 4 && !names.some((n) => MEMBERSHIP_TOOLS.includes(n))));

	// Management output renders via TUI-only entry renderers (not LLM context).
	assert.equal(entryRenderers.includes("crew-roster"), true);
	assert.equal(entryRenderers.includes("crew-status"), true);
	assert.equal(entryRenderers.includes("crew-inbox"), true);
});

test("unjoined session_start keeps provider active set and system prompt byte-identical", async () => {
	const flags: string[] = [];
	const tools: string[] = [];
	const commands: string[] = [];
	const entryRenderers: string[] = [];
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	let active: string[] = ["read", "bash", "edit", "write"];
	let setActiveCalls = 0;
	const pi = {
		registerFlag(name: string) {
			flags.push(name);
		},
		registerMessageRenderer() {},
		registerEntryRenderer(name: string) {
			entryRenderers.push(name);
		},
		registerTool(tool: { name: string }) {
			tools.push(tool.name);
			active.push(tool.name); // Pi auto-activation
		},
		registerCommand(name: string) {
			commands.push(name);
		},
		getActiveTools: () => [...active],
		getAllTools: () => tools.map((name) => ({ name })),
		setActiveTools(names: string[]) {
			active = names;
			setActiveCalls += 1;
		},
		appendEntry() {},
		getFlag: () => false,
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			handlers.set(event, handler);
		},
	} as never;

	extension(pi);
	// Fresh load removed Pi auto-activated membership tools.
	assert.deepEqual(active, ["read", "bash", "edit", "write"]);
	const beforeStartCalls = setActiveCalls;

	// New unjoined session: no persisted membership, no crew flags.
	const ctx = {
		hasUI: true,
		ui: { notify: () => {} },
		isProjectTrusted: () => true,
		cwd: "/project",
		sessionManager: { getSessionId: () => "local", getSessionName: () => "local-name" },
	} as never;
	await handlers.get("session_start")!({}, ctx);
	// Still no membership tools in the provider-active schema.
	assert.deepEqual(active, ["read", "bash", "edit", "write"]);
	assert.equal(setActiveCalls, beforeStartCalls, "unjoined session_start must not change the active set");

	// before_agent_start returns no replacement prompt for an unjoined session.
	const event = { systemPrompt: "Base system" } as never;
	const result = await handlers.get("before_agent_start")!(event, ctx);
	assert.equal(result, undefined, "unjoined before_agent_start must be byte-identical (no replacement)");
});
