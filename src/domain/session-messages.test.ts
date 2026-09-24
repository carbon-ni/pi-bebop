import test from "node:test";
import assert from "node:assert/strict";

import { MAX_MESSAGE_CONTENT_BYTES } from "./message-payload.ts";
import {
	getFirstEntryId,
	getLastAssistantMessage,
	getMessagesSinceLastPrompt,
	inspectLastAssistantMessage,
} from "./session-messages.ts";

const text = (value: string) => ({ type: "text", text: value });

test("getLastAssistantMessage returns newest assistant text", () => {
	const branch = [
		{ type: "message", message: { role: "assistant", content: [text("old")], timestamp: 1 } },
		{ type: "message", message: { role: "user", content: [text("prompt")], timestamp: 2 } },
		{ type: "message", message: { role: "assistant", content: [text("new"), text("answer")], timestamp: 3 } },
	];

	assert.deepEqual(getLastAssistantMessage(branch), {
		role: "assistant",
		content: "new\nanswer",
		timestamp: 3,
	});
});

test("getLastAssistantMessage ignores non-string text and invalid timestamps", () => {
	const branch = [
		{
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: { unsafe: true } }], timestamp: 4 },
		},
		{ type: "message", message: { role: "assistant", content: [text("missing timestamp")] } },
		{ type: "message", message: { role: "assistant", content: [text("invalid timestamp")], timestamp: -1 } },
		{ type: "message", message: { role: "assistant", content: [text("valid")], timestamp: 3 } },
	];

	assert.deepEqual(getLastAssistantMessage(branch), {
		role: "assistant",
		content: "valid",
		timestamp: 3,
	});
	assert.equal(
		getLastAssistantMessage([
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: 7 }], timestamp: 1 } },
		]),
		undefined,
	);
});

test("inspectLastAssistantMessage rejects malformed newest text instead of revealing older text", () => {
	assert.deepEqual(
		inspectLastAssistantMessage([
			{ type: "message", message: { role: "assistant", content: [text("older")], timestamp: 1 } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: 7 }], timestamp: 2 } },
		]),
		{ kind: "malformed", code: "malformed-response" },
	);
	assert.deepEqual(
		inspectLastAssistantMessage([
			{ type: "message", message: { role: "assistant", content: [text("older")], timestamp: 1 } },
			{ type: "message", message: { role: "assistant", content: [text("missing timestamp")] } },
		]),
		{ kind: "malformed", code: "malformed-response" },
	);
	assert.deepEqual(
		inspectLastAssistantMessage([
			{ type: "message", message: { role: "assistant", content: [text("older")], timestamp: 1 } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [text("x".repeat(MAX_MESSAGE_CONTENT_BYTES + 1))],
					timestamp: 2,
				},
			},
		]),
		{ kind: "malformed", code: "message-too-large" },
	);
});

test("inspectLastAssistantMessage preserves exact newlines between text parts", () => {
	assert.deepEqual(
		inspectLastAssistantMessage([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [text("first part"), text("second part")],
					timestamp: 7,
				},
			},
		]),
		{ kind: "message", message: { role: "assistant", content: "first part\nsecond part", timestamp: 7 } },
	);
});

test("inspectLastAssistantMessage skips a newest tool-only entry", () => {
	assert.deepEqual(
		inspectLastAssistantMessage([
			{ type: "message", message: { role: "assistant", content: [text("older")], timestamp: 1 } },
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "toolCall", id: "call-1" }], timestamp: 2 },
			},
		]),
		{ kind: "message", message: { role: "assistant", content: "older", timestamp: 1 } },
	);
});

test("getMessagesSinceLastPrompt returns user prompt and following assistant messages", () => {
	const branch = [
		{ type: "message", message: { role: "user", content: [text("older")], timestamp: 1 } },
		{ type: "message", message: { role: "assistant", content: [text("old answer")], timestamp: 2 } },
		{ type: "message", message: { role: "user", content: [text("latest")], timestamp: 3 } },
		{ type: "message", message: { role: "assistant", content: [text("current")], timestamp: 4 } },
	];

	assert.deepEqual(getMessagesSinceLastPrompt(branch), [
		{ role: "user", content: "latest", timestamp: 3 },
		{ role: "assistant", content: "current", timestamp: 4 },
	]);
});

test("getMessagesSinceLastPrompt returns empty when no user prompt exists", () => {
	assert.deepEqual(
		getMessagesSinceLastPrompt([
			{ type: "message", message: { role: "assistant", content: [text("answer")], timestamp: 1 } },
		]),
		[],
	);
});

test("getFirstEntryId prefers root entry", () => {
	assert.equal(
		getFirstEntryId([
			{ id: "child", parentId: "root" },
			{ id: "root", parentId: null },
		]),
		"root",
	);
});
