import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "@sinclair/typebox/value";
import {
	MAX_MESSAGE_CONTENT_BYTES,
	MAX_MESSAGE_INSTRUCTIONS,
	MAX_MESSAGE_INSTRUCTION_BYTES,
	MAX_MESSAGE_PAYLOAD_BYTES,
	MessagePayloadSchema,
	isMessagePayload,
	type MessagePayload,
} from "./message-payload.ts";

test("accepts an ordered payload with discriminated claimed origin", () => {
	const payload: MessagePayload = {
		content: "Review\nthis",
		instructions: ["Focus on correctness", "Reply with evidence"],
		origin: { kind: "crew", name: "Bob", role: "dev" },
	};
	assert.equal(Value.Check(MessagePayloadSchema, payload), true);
	assert.equal(isMessagePayload(payload), true);
});

test("accepts content-only and claimed external payloads", () => {
	assert.equal(isMessagePayload({ content: "hello" }), true);
	assert.equal(isMessagePayload({ content: "hello", origin: { kind: "external", label: "CI" } }), true);
});

test("rejects ambiguous, malformed, empty, NUL, and extra payload fields", () => {
	const invalid: unknown[] = [
		{},
		{ content: "" },
		{ content: "\0" },
		{ content: "x", instructions: [] },
		{ content: "x", instructions: ["\0"] },
		{ content: "x", origin: { kind: "crew", name: "Bob", role: "dev", trusted: true } },
		{ content: "x", origin: { kind: "crew", name: "", role: "dev" } },
		{ content: "x", origin: { kind: "external", label: "" } },
		{ content: "x", origin: { kind: "unknown", label: "x" } },
		{ content: "x", extra: true },
	];
	for (const value of invalid) assert.equal(isMessagePayload(value), false, JSON.stringify(value));
});

test("enforces deterministic byte and aggregate limits", () => {
	assert.equal(isMessagePayload({ content: "x".repeat(MAX_MESSAGE_CONTENT_BYTES) }), true);
	assert.equal(isMessagePayload({ content: "😀".repeat(Math.ceil(MAX_MESSAGE_CONTENT_BYTES / 4) + 1) }), false);
	assert.equal(isMessagePayload({ content: "x", instructions: Array(MAX_MESSAGE_INSTRUCTIONS).fill("i") }), true);
	assert.equal(
		isMessagePayload({ content: "x", instructions: Array(MAX_MESSAGE_INSTRUCTIONS + 1).fill("i") }),
		false,
	);
	assert.equal(isMessagePayload({ content: "x", instructions: ["i".repeat(MAX_MESSAGE_INSTRUCTION_BYTES)] }), true);
	assert.equal(
		isMessagePayload({ content: "x", instructions: ["i".repeat(MAX_MESSAGE_INSTRUCTION_BYTES + 1)] }),
		false,
	);
	assert.equal(isMessagePayload({ content: "x".repeat(MAX_MESSAGE_PAYLOAD_BYTES), instructions: ["i"] }), false);
});
