import test from "node:test";
import assert from "node:assert/strict";

import extension from "../extension.ts";

test("registers only crew-specific surfaces and leaves the shared intray tools untouched", () => {
	const flags: string[] = [];
	const tools: string[] = [];
	const commands: string[] = [];
	const pi = {
		registerFlag(name: string) { flags.push(name); },
		registerMessageRenderer() {},
		registerTool(tool: { name: string }) { tools.push(tool.name); },
		registerCommand(name: string) { commands.push(name); },
		on() {},
	} as never;

	assert.doesNotThrow(() => extension(pi));
	assert.deepEqual(flags, ["crew-socket"]);
	assert.deepEqual(tools, ["send_to_member"]);
	assert.deepEqual(commands, ["crew"]);
});
