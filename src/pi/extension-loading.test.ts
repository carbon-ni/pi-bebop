import test from "node:test";
import assert from "node:assert/strict";

import extension, { resolveCurrentCrewOrigin } from "../extension.ts";
import { createSocketState } from "./control-runtime.ts";

test("derives joined session origin at execute time across leave and rejoin", () => {
	const state = createSocketState();
	const first = { member: { name: "Bob", role: "dev" } };
	const second = { member: { name: "Kelly", role: "qa" } };
	let current: typeof first | null = first;
	state.membershipRuntime = { getMembership: () => current } as never;
	assert.deepEqual(resolveCurrentCrewOrigin(state), { kind: "crew", name: "Bob", role: "dev" });
	current = null;
	assert.equal(resolveCurrentCrewOrigin(state), undefined);
	current = second;
	assert.deepEqual(resolveCurrentCrewOrigin(state), { kind: "crew", name: "Kelly", role: "qa" });
});

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
	assert.deepEqual(tools, ["send_follow_up", "send_immediate", "send_to_session"]);
	assert.deepEqual(commands, ["crew"]);
	assert.equal(renderers.includes("crew-presence"), true);
});
