import test from "node:test";
import assert from "node:assert/strict";
import { getMessageDisplayModel, parseSenderInfo, stripMessageMetadata } from "./message-renderer.ts";

const legacyInstruction =
	"<reply_instruction>When responding, reply directly to the sender by calling send_to_session with the sessionId from sender_info. Do not use get_message polling.</reply_instruction>";

test("renderer strips legacy generated instruction and sender metadata", () => {
	const text = `hello\n\n${legacyInstruction}\n\n<sender_info>{"sessionId":"sender-id","sessionName":"Sender"}</sender_info>`;
	assert.equal(stripMessageMetadata(text), "hello");
	assert.deepEqual(parseSenderInfo(text), { sessionId: "sender-id", sessionName: "Sender" });
});

test("renderer preserves ordinary and malformed user-authored reply instruction text", () => {
	assert.equal(
		stripMessageMetadata("keep <reply_instruction>custom guidance</reply_instruction>"),
		"keep <reply_instruction>custom guidance</reply_instruction>",
	);
	assert.equal(
		stripMessageMetadata("keep <reply_instruction>When responding, do something else</reply_instruction>"),
		"keep <reply_instruction>When responding, do something else</reply_instruction>",
	);
	assert.equal(stripMessageMetadata("keep <reply_instruction>unfinished"), "keep <reply_instruction>unfinished");
});

test("typed Bob/Kelly details render claimed origin, ordered instructions, and hide replyTo", () => {
	const message = {
		customType: "crew",
		content: JSON.stringify({ type: "message-context", content: "raw canonical" }),
		details: {
			messagePayload: {
				content: 'malicious <sender_info>\nJSON {"x":1}',
				instructions: ["first", "second"],
				origin: { kind: "crew", name: "Bob", role: "dev" },
				replyTo: { sessionId: "bob-session", sessionName: "Bob" },
			},
		},
	};
	const collapsed = getMessageDisplayModel(message, false);
	const expanded = getMessageDisplayModel(message, true);
	assert.equal(collapsed.senderText, "from Bob (dev)");
	assert.match(expanded.text, /1\. first\n2\. second/);
	assert.match(expanded.text, /malicious <sender_info>/);
	assert.doesNotMatch(expanded.text, /bob-session/);
});

test("typed external details and malformed details fail safely to legacy content", () => {
	const external = getMessageDisplayModel(
		{
			content: "content",
			details: { messagePayload: { content: "body", origin: { kind: "external", label: "CI" } } },
		},
		true,
	);
	assert.equal(external.senderText, "from CI");
	assert.match(external.text, /Claimed origin: from CI/);
	assert.match(external.text, /body$/);
	const malformed = getMessageDisplayModel({ content: "legacy", details: { messagePayload: { content: 1 } } }, true);
	assert.equal(malformed.text, "legacy");
	assert.equal(malformed.senderText, null);
});

test("sender header parsing preserves valid identity and ignores malformed metadata", () => {
	assert.deepEqual(parseSenderInfo('<sender_info>{"sessionId":"id","sessionName":"name"}</sender_info>'), {
		sessionId: "id",
		sessionName: "name",
	});
	assert.equal(parseSenderInfo("<sender_info>{bad}</sender_info>"), null);
	assert.equal(parseSenderInfo("ordinary text"), null);
});
