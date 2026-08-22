import test from "node:test";
import assert from "node:assert/strict";
import { sendMessageToSocket } from "./send-message.ts";

test("preserves non-error adapter output when turn ends without assistant content", async () => {
	const result = await sendMessageToSocket({
		socketPath: "/tmp/member.sock",
		message: "hello",
		mode: "steer",
		policy: { waitUntil: "turn_end", allowsReply: false },
		displayTarget: "member",
	}, async () => ({ response: { type: "response", command: "send", success: true }, event: { turnIndex: 9 } }));
	assert.equal(result.isError, undefined);
	assert.equal(result.content[0]?.text, "Turn completed but no assistant message found");
});
