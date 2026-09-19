import test from "node:test";
import assert from "node:assert/strict";
import { defaultFormatForCommand } from "./audience-policy.ts";

test("declared default format: human-first commands default to text, the rest to TOON", () => {
	assert.equal(defaultFormatForCommand("crew-init"), "text");
	for (const command of [
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
		assert.equal(defaultFormatForCommand(command), "toon", command);
	}
});

test("unknown commands default to TOON", () => {
	assert.equal(defaultFormatForCommand("not-a-command"), "toon");
});
