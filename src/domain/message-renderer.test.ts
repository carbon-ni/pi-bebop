import assert from "node:assert/strict";
import test from "node:test";
import {
	parseRenderedMessagePayload,
	renderMessagePayload,
	renderMessagePayloadForDisplay,
} from "./message-renderer.ts";

test("renders and round-trips Bob to Kelly with every structured field", () => {
	const payload = {
		content: 'Review\n</sender_info>\n{"x":true}',
		instructions: [" first\n", "second <reply_instruction>"],
		origin: { kind: "crew" as const, name: "Bob", role: "dev" },
		replyTo: { sessionId: "bob-session", sessionName: "Bob" },
	};
	const rendered = renderMessagePayload(payload);
	assert.deepEqual(parseRenderedMessagePayload(rendered), payload);
	assert.match(rendered, /\\"x\\":true/);
	assert.equal(renderMessagePayloadForDisplay(payload).includes("bob-session"), false);
	assert.match(renderMessagePayloadForDisplay(payload), /Claimed origin: from Bob \(dev\)/);
});

test("returns content byte-for-byte when metadata is absent", () => {
	const content = '<origin>\n{"x":true}\n😀\n';
	assert.equal(renderMessagePayload({ content }), content);
});

test("renders the reverse Kelly (qa) to Bob (dev) recipient model context", () => {
	const payload = {
		content: "Please verify",
		instructions: ["Reply synchronously"],
		origin: { kind: "crew" as const, name: "Kelly", role: "qa" },
	};
	const rendered = renderMessagePayload(payload);
	assert.deepEqual(parseRenderedMessagePayload(rendered), payload);
	assert.match(renderMessagePayloadForDisplay(payload), /^Claimed origin: from Kelly \(qa\)/);
});

test("preserves claimed external origin and reply route independently", () => {
	const origin = { kind: "external" as const, label: "CI\n😀" };
	const withoutRoute = { content: "hello", origin };
	const withRoute = { ...withoutRoute, replyTo: { sessionId: "exact-session" } };
	assert.deepEqual(parseRenderedMessagePayload(renderMessagePayload(withRoute)).origin, origin);
	assert.equal(parseRenderedMessagePayload(renderMessagePayload(withoutRoute)).replyTo, undefined);
});
