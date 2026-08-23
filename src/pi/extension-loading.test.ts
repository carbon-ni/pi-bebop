import test from "node:test";
import assert from "node:assert/strict";

import extension from "../extension.ts";

test("registers crew delivery surfaces with the structured session tool", () => {
	const flags: string[] = [];
	const tools: string[] = [];
	const commands: string[] = [];
	const renderers: string[] = [];
	const pi = {
		registerFlag(name: string) {
			flags.push(name);
		},
		registerMessageRenderer(name: string) {
			renderers.push(name);
		},
		registerTool(tool: { name: string }) {
			tools.push(tool.name);
		},
		registerCommand(name: string) {
			commands.push(name);
		},
		on() {},
	} as never;

	assert.doesNotThrow(() => extension(pi));
	assert.deepEqual(flags, ["crew", "crew-socket"]);
	assert.deepEqual(tools, ["send_follow_up", "redirect_member", "send_to_inbox"]);
	assert.deepEqual(commands, ["crew"]);
	assert.equal(renderers.includes("crew-presence"), true);
});
