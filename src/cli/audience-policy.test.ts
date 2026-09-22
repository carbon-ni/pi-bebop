import test from "node:test";
import assert from "node:assert/strict";
import { defaultFormatForCommand } from "./audience-policy.ts";

test("every canonical command defaults to concise text", () => {
	assert.equal(defaultFormatForCommand("crew-init"), "text");
	for (const command of [
		"ask",
		"crew-list",
		"crew-roles",
		"crew-broadcast",
		"session-live",
		"member-status",
		"member-idle-wait",
		"member-follow-up",
		"member-redirect",
		"member-inbox-send",
		"member-interrupt",
		"member-request-send",
		"member-request-list",
		"member-request-wait",
		"member-request-respond",
		"session-resume",
		"guest-join",
		"guest-leave",
		"guest-send",
		"guest-broadcast",
	]) {
		assert.equal(defaultFormatForCommand(command), "text", command);
	}
});

test("unknown commands also default to concise text", () => {
	assert.equal(defaultFormatForCommand("not-a-command"), "text");
});
