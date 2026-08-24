import assert from "node:assert/strict";
import test from "node:test";
import {
	parseRenderedMessagePayload,
	renderMessagePayload,
	renderMessagePayloadForDisplay,
	renderMemberRequestModelContent,
	renderFollowUpModelContent,
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

test("TASK-0076: Member request model content carries a bounded marker, Request ID, and respond instruction only", () => {
	const payload = {
		content: "Deliver the report",
		origin: { kind: "crew" as const, name: "Tony", role: "lead" },
	};
	const rendered = renderMemberRequestModelContent(payload, "request-abc-123");
	assert.match(rendered, /^\[member request\]/);
	assert.match(rendered, /request-abc-123/);
	assert.match(rendered, /respond_to_member_request/);
	assert.match(rendered, /wait_for_request_outcome/);
	assert.match(rendered, /Deliver the report/);
	// Never requester socket/session/manifest path or authentication claim.
	for (const forbidden of ["sockets", ".sock", "/manifest", "sessionId", "crew.json"]) {
		assert.ok(!rendered.includes(forbidden), `forbidden marker payload: ${forbidden}`);
	}
	// The underlying canonical payload remains parseable after the bounded marker.
	assert.deepEqual(parseRenderedMessagePayload(rendered.split("\n").slice(1).join("\n")), payload);
});

test("TASK-0076: ordinary Follow-up model content is structurally no-correlated-Response", () => {
	const payload = {
		content: "Heads up about the deploy",
		origin: { kind: "crew" as const, name: "Tony", role: "lead" },
	};
	const rendered = renderFollowUpModelContent(payload);
	assert.match(rendered, /^\[follow-up\]/);
	assert.match(rendered, /no correlated Response expected/i);
	assert.match(rendered, /Heads up about the deploy/);
	assert.doesNotMatch(rendered, /respond_to_member_request|wait_for_request_outcome/);
	// No heuristic upgrade: the message body is never parsed for request intent.
	assert.equal(rendered.includes("report"), false);
	assert.deepEqual(parseRenderedMessagePayload(rendered.split("\n").slice(1).join("\n")), payload);
});
