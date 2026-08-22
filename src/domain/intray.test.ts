import test from "node:test";
import assert from "node:assert/strict";

import {
	isSafeAlias,
	isSafeSessionId,
	normalizeMode,
	normalizeWaitUntil,
	isSessionControlRequested,
	parseRequest,
	requestToCommand,
	parseSessionControlAction,
	resolveResponsePolicy,
} from "./index.ts";

test("JSON-RPC parser validates supported requests and maps methods", () => {
	const result = parseRequest(JSON.stringify({ jsonrpc: "2.0", id: "1", method: "message.send", params: { message: "hello", mode: "steer" } }));
	assert.equal(result.error, undefined);
	assert.deepEqual(requestToCommand(result.request!), { type: "send", message: "hello", mode: "steer", id: "1" });
	assert.equal("code" in requestToCommand({ jsonrpc: "2.0", id: "2", method: "unknown" }), true);
});

test("JSON-RPC parser returns standard failures for malformed and legacy envelopes", () => {
	assert.equal(parseRequest("{ nope").error?.code, -32700);
	assert.equal(parseRequest(JSON.stringify({ type: "send", message: "hello" })).error?.code, -32600);
	const extra = parseRequest(JSON.stringify({ jsonrpc: "2.0", id: "1", method: "message.send", params: { message: "x", extra: true } })).request!;
	assert.equal("code" in requestToCommand(extra), true);
});

test("session ids and aliases reject path traversal", () => {
	assert.equal(isSafeSessionId("abc-123"), true);
	assert.equal(isSafeSessionId(""), false);
	assert.equal(isSafeSessionId("../abc"), false);
	assert.equal(isSafeSessionId("a/b"), false);
	assert.equal(isSafeSessionId("a\\b"), false);

	assert.equal(isSafeAlias("main-session"), true);
	assert.equal(isSafeAlias(""), false);
	assert.equal(isSafeAlias("../main"), false);
	assert.equal(isSafeAlias("main/session"), false);
	assert.equal(isSafeAlias("main\\session"), false);
});

test("normalizeMode accepts documented aliases", () => {
	assert.equal(normalizeMode("steer"), "steer");
	assert.equal(normalizeMode(" follow-up "), "follow_up");
	assert.equal(normalizeMode("followup"), "follow_up");
	assert.equal(normalizeMode("follow_up"), "follow_up");
	assert.equal(normalizeMode("later"), null);
});

test("normalizeWaitUntil accepts documented aliases", () => {
	assert.equal(normalizeWaitUntil("turn_end"), "turn_end");
	assert.equal(normalizeWaitUntil("turn-end"), "turn_end");
	assert.equal(normalizeWaitUntil(" message-processed "), "message_processed");
	assert.equal(normalizeWaitUntil("message_processed"), "message_processed");
	assert.equal(normalizeWaitUntil("off"), "off");
	assert.equal(normalizeWaitUntil("none"), "off");
	assert.equal(normalizeWaitUntil("done"), null);
});

test("resolveResponsePolicy infers synchronous defaults without callback metadata", () => {
	assert.deepEqual(resolveResponsePolicy(), {
		waitUntil: "turn_end",
		replyBehavior: "end_conversation",
		allowsReply: false,
	});
	assert.deepEqual(resolveResponsePolicy("turn_end", "end_conversation"), {
		waitUntil: "turn_end",
		replyBehavior: "end_conversation",
		allowsReply: false,
	});
});

test("resolveResponsePolicy rejects synchronous waits with callback replies", () => {
	assert.deepEqual(resolveResponsePolicy("turn_end", "allow_reply"), {
		error: "turn_end cannot be combined with allow_reply; use message_processed or off for callback chat, or end_conversation for a synchronous response.",
	});
});

test("resolveResponsePolicy allows callback replies only for asynchronous waits", () => {
	assert.deepEqual(resolveResponsePolicy("message_processed", "allow_reply"), {
		waitUntil: "message_processed",
		replyBehavior: "allow_reply",
		allowsReply: true,
	});
	assert.deepEqual(resolveResponsePolicy("off", "end_conversation"), {
		waitUntil: "off",
		replyBehavior: "end_conversation",
		allowsReply: false,
	});
});

test("isSessionControlRequested accepts only intray flags", () => {
	const noFlags = () => undefined;
	assert.equal(isSessionControlRequested(noFlags, ["--intray"]), true);
	assert.equal(isSessionControlRequested(noFlags, ["--in"]), true);
	assert.equal(isSessionControlRequested((name) => name === "intray", []), true);
	assert.equal(isSessionControlRequested((name) => name === "in", []), true);
	assert.equal(isSessionControlRequested(noFlags, ["--pi-intray"]), false);
	assert.equal(isSessionControlRequested(noFlags, ["--session-control"]), false);
	assert.equal(isSessionControlRequested(noFlags, ["--sc"]), false);
	assert.equal(isSessionControlRequested(noFlags, []), false);
});

test("parseSessionControlAction accepts the exact crew command surface", () => {
	assert.deepEqual(parseSessionControlAction(""), { action: "status" });
	for (const action of ["leave", "list", "status", "stop"]) {
		assert.deepEqual(parseSessionControlAction(action), { action });
	}
	assert.deepEqual(parseSessionControlAction("join '/tmp/project sockets/dev.sock'"), {
		action: "join",
		target: "/tmp/project sockets/dev.sock",
	});
});

test("parseSessionControlAction rejects removed direct actions and invalid arity", () => {
	for (const action of ["listen", "connect", "disconnect"]) {
		assert.deepEqual(parseSessionControlAction(action), {
			error: `Unknown intray action: ${action}. Use join <socket>|leave|list|status|stop.`,
		});
	}
	assert.deepEqual(parseSessionControlAction("start"), {
		error: "Unknown intray action: start. Use join <socket>|leave|list|status|stop.",
	});
	assert.deepEqual(parseSessionControlAction("join"), {
		error: "Missing target. Use /intray join <socket>.",
	});
	assert.deepEqual(parseSessionControlAction("join /tmp/a.sock /tmp/b.sock"), {
		error: "Join accepts exactly one target.",
	});
	assert.deepEqual(parseSessionControlAction("status now"), {
		error: "Too many arguments. Use /intray join <socket>|leave|list|status|stop.",
	});
});
