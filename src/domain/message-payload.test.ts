import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "@sinclair/typebox/value";
import {
	MAX_CREW_RETURN_ADDRESS_PATH_BYTES,
	MAX_MESSAGE_CONTENT_BYTES,
	MAX_MESSAGE_INSTRUCTIONS,
	MAX_MESSAGE_INSTRUCTION_BYTES,
	MAX_MESSAGE_PAYLOAD_BYTES,
	MAX_MESSAGE_ORIGIN_FIELD_BYTES,
	MessagePayloadSchema,
	messagePayloadUtf8Bytes,
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
		{ content: "   " },
		{ content: "x", instructions: ["   "] },
		{ content: "x", instructions: [1] },
		{ content: "x", origin: { kind: "crew", name: 1, role: "dev" } },
		{ content: "x", origin: { kind: "external", label: 1 } },
		{ content: "x", origin: { kind: "crew", name: " Bob ", role: "dev" } },
		{ content: "x", instructions: [] },
		{ content: "x", instructions: ["\0"] },
		{ content: "x", origin: { kind: "crew", name: "Bob", role: "dev", trusted: true } },
		{ content: "x", origin: { kind: "crew", name: "", role: "dev" } },
		{ content: "x", origin: { kind: "external", label: "" } },
		{ content: "x", origin: { kind: "unknown", label: "x" } },
		{ content: "x", origin: { kind: "crew", name: "Bob", role: "\0" } },
		{ content: "x", replyTo: { sessionId: "   " } },
		{ content: "x", replyTo: { sessionId: "s", sessionName: 2 } },
		{ content: "x", extra: true },
	];
	for (const value of invalid) assert.equal(isMessagePayload(value), false, JSON.stringify(value));
});

test("accepts an optional bounded crew return address", () => {
	const withAddress: MessagePayload = {
		content: "Question for your crew",
		origin: { kind: "crew", name: "Dave", role: "developer" },
		crewReturnAddress: { manifestPath: "/projects/alpha/.pi/bebop/crew.json" },
	};
	assert.equal(Value.Check(MessagePayloadSchema, withAddress), true);
	assert.equal(isMessagePayload(withAddress), true);
	assert.equal(
		isMessagePayload({
			...withAddress,
			crewReturnAddress: { manifestPath: "/projects/alpha/.pi/crew/crew.json", crewName: "Alpha Crew" },
		}),
		true,
	);
});

test("rejects malformed crew return addresses", () => {
	const invalid: unknown[] = [
		{ content: "x", crewReturnAddress: {} },
		{ content: "x", crewReturnAddress: { manifestPath: "" } },
		{ content: "x", crewReturnAddress: { manifestPath: "relative/.pi/bebop/crew.json" } },
		{ content: "x", crewReturnAddress: { manifestPath: "/proj/crew.json\u0000" } },
		{
			content: "x",
			crewReturnAddress: { manifestPath: "/".concat("a".repeat(MAX_CREW_RETURN_ADDRESS_PATH_BYTES + 1)) },
		},
		{ content: "x", crewReturnAddress: { manifestPath: 1 } },
		{ content: "x", crewReturnAddress: { manifestPath: "/p/crew.json", socketPath: "/p/sock" } },
		{ content: "x", crewReturnAddress: { manifestPath: "/p/crew.json", crewName: " padded " } },
		{ content: "x", crewReturnAddress: { manifestPath: "/p/crew.json", crewName: "" } },
	];
	for (const value of invalid) assert.equal(isMessagePayload(value), false, JSON.stringify(value));
});

test("enforces deterministic byte and aggregate limits", () => {
	assert.equal(Value.Check(MessagePayloadSchema, { content: "x".repeat(MAX_MESSAGE_CONTENT_BYTES) }), true);
	assert.equal(isMessagePayload({ content: "x".repeat(MAX_MESSAGE_CONTENT_BYTES - 100) }), true);
	assert.equal(isMessagePayload({ content: "😀".repeat(Math.ceil(MAX_MESSAGE_CONTENT_BYTES / 4) + 1) }), false);
	assert.equal(isMessagePayload({ content: "x", instructions: Array(MAX_MESSAGE_INSTRUCTIONS).fill("i") }), true);
	assert.equal(
		isMessagePayload({ content: "x", instructions: Array(MAX_MESSAGE_INSTRUCTIONS + 1).fill("i") }),
		false,
	);
	assert.equal(isMessagePayload({ content: "x", instructions: ["i".repeat(MAX_MESSAGE_INSTRUCTION_BYTES)] }), true);
	assert.equal(isMessagePayload({ content: "x", instructions: [" first\n"] }), true);
	assert.equal(isMessagePayload({ content: "x", replyTo: { sessionId: "s", sessionName: "name" } }), true);
	assert.equal(
		isMessagePayload({
			content: "x",
			origin: { kind: "crew", name: "😀".repeat(MAX_MESSAGE_ORIGIN_FIELD_BYTES / 4), role: "dev" },
		}),
		true,
	);
	assert.equal(
		isMessagePayload({
			content: "x",
			origin: { kind: "crew", name: "😀".repeat(MAX_MESSAGE_ORIGIN_FIELD_BYTES / 4 + 1), role: "dev" },
		}),
		false,
	);
	assert.equal(
		isMessagePayload({
			content: "x",
			origin: { kind: "external", label: "😀".repeat(MAX_MESSAGE_ORIGIN_FIELD_BYTES / 4) },
		}),
		true,
	);
	const originPayload = {
		content: "x",
		instructions: ["i"],
		origin: { kind: "crew" as const, name: "Bob", role: "dev" },
	};
	assert.equal(messagePayloadUtf8Bytes(originPayload) < MAX_MESSAGE_PAYLOAD_BYTES, true);
	assert.equal(
		isMessagePayload({ content: "x", instructions: ["i".repeat(MAX_MESSAGE_INSTRUCTION_BYTES + 1)] }),
		false,
	);
	assert.equal(isMessagePayload({ content: "x".repeat(MAX_MESSAGE_PAYLOAD_BYTES), instructions: ["i"] }), false);
	let low = 1;
	let high = MAX_MESSAGE_CONTENT_BYTES;
	while (low < high) {
		const candidate = Math.ceil((low + high) / 2);
		const probe = { ...originPayload, content: "x".repeat(candidate) };
		if (messagePayloadUtf8Bytes(probe) <= MAX_MESSAGE_PAYLOAD_BYTES) low = candidate;
		else high = candidate - 1;
	}
	const nearLimit = { ...originPayload, content: "x".repeat(low) };
	assert.equal(isMessagePayload(nearLimit), true);
	assert.equal(isMessagePayload({ ...nearLimit, content: `${nearLimit.content}${"x".repeat(100)}` }), false);
});

test("crew return address manifest path must be canonical in the payload schema", () => {
	const base = { content: "x" };
	for (const nonCanonical of [
		"//alpha/.pi/bebop/crew.json",
		"/alpha/../.pi/bebop/crew.json",
		"/alpha/.pi/bebop/./crew.json",
		"/alpha/.pi/bebop/crew.json/",
		"/alpha/.pi/bebop/crew.json\n",
		"alpha/.pi/bebop/crew.json",
	]) {
		const payload = { ...base, crewReturnAddress: { manifestPath: nonCanonical } };
		assert.equal(isMessagePayload(payload), false, nonCanonical);
	}
	assert.equal(
		isMessagePayload({ ...base, crewReturnAddress: { manifestPath: "/alpha/.pi/bebop/crew.json" } }),
		true,
	);
});
