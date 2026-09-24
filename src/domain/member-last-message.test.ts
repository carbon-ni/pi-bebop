import assert from "node:assert/strict";
import test from "node:test";
import { isMemberLastMessage, isMemberLastMessageResult } from "./member-last-message.ts";

test("member last-message guard accepts only bounded assistant snapshots", () => {
	assert.equal(isMemberLastMessage({ role: "assistant", content: "latest", timestamp: 10 }), true);
	assert.equal(isMemberLastMessage({ role: "user", content: "private", timestamp: 10 }), false);
	assert.equal(isMemberLastMessage({ role: "assistant", content: "", timestamp: 10 }), false);
	assert.equal(isMemberLastMessage({ role: "assistant", content: "latest", timestamp: -1 }), false);
	assert.equal(
		isMemberLastMessageResult({
			member: { name: "developer", role: "Developer" },
			message: { role: "assistant", content: "latest", timestamp: 10 },
		}),
		true,
	);
	assert.equal(isMemberLastMessageResult({ member: { name: "developer", role: "Developer" }, message: null }), true);
	assert.equal(
		isMemberLastMessageResult({
			member: { name: "developer", role: "Developer" },
			message: { role: "user", content: "private", timestamp: 10 },
		}),
		false,
	);
});
