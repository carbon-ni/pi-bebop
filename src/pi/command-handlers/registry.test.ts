import test from "node:test";
import assert from "node:assert/strict";
import { commandHandlers } from "./registry.ts";

const commandTypes = [
	"member_request",
	"member_response",
	"presence_hint",
	"member_status",
	"member_status_target",
	"member_follow_up",
	"member_redirect",
	"member_inbox_send",
	"crew_broadcast",
	"member_idle_wait",
	"status",
	"abort",
	"member_interrupt",
	"interrupt",
	"subscribe",
	"get_message",
	"clear",
	"send",
] as const;

test("RPC handler registry is exhaustive and every handler is callable", () => {
	assert.deepEqual(Object.keys(commandHandlers).sort(), [...commandTypes].sort());
	for (const type of commandTypes) assert.equal(typeof commandHandlers[type], "function");
});
