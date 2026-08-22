import test from "node:test";
import assert from "node:assert/strict";
import { Value } from "@sinclair/typebox/value";

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
	MessageSendParamsSchema, SubscribeParamsSchema, EmptyParamsSchema,
	MessageSendCommandSchema, SubscribeCommandSchema, StatusCommandSchema, GetMessageCommandSchema, ClearCommandSchema, AbortCommandSchema,
	commandToRequest,
	MessageSendRequestSchema, SubscribeRequestSchema, StatusRequestSchema, GetMessageRequestSchema, ClearRequestSchema, AbortRequestSchema,
	StatusResultSchema, SendResultSchema, GetMessageResultSchema, ClearResultSchema, SubscribeResultSchema, EmptyResultSchema,
	RpcErrorSchema, TurnEndNotificationSchema, ExtractedMessageSchema,
} from "./index.ts";

test("JSON-RPC parser validates supported requests and maps methods", () => {
	const result = parseRequest(JSON.stringify({ jsonrpc: "2.0", id: "1", method: "message.send", params: { message: "hello", mode: "steer" } }));
	assert.equal(result.error, undefined);
	assert.deepEqual(requestToCommand(result.request!), { type: "send", message: "hello", mode: "steer", id: "1" });
	assert.equal("code" in requestToCommand({ jsonrpc: "2.0", id: "2", method: "unknown" }), true);
});

test("JSON-RPC parser returns standard failures for malformed and non-RPC envelopes", () => {
	assert.equal(parseRequest("{ nope").error?.code, -32700);
	assert.equal(parseRequest(JSON.stringify({ type: "send", message: "hello" })).error?.code, -32600);
	const extra = parseRequest(JSON.stringify({ jsonrpc: "2.0", id: "1", method: "message.send", params: { message: "x", extra: true } })).request!;
	assert.equal("code" in requestToCommand(extra), true);
});

test("method parameter schemas accept only their exact valid shapes", () => {
	const cases: Array<[string, Parameters<typeof Value.Check>[0], unknown]> = [
		["message.send", MessageSendParamsSchema, { message: "hello", mode: "steer" }],
		["event.subscribe", SubscribeParamsSchema, { event: "turn_end" }],
		["session.status", EmptyParamsSchema, {}],
		["session.get_message", EmptyParamsSchema, {}],
		["session.clear", EmptyParamsSchema, {}],
		["session.abort", EmptyParamsSchema, {}],
	];
	for (const [method, schema, value] of cases) assert.equal(Value.Check(schema, value), true, method);
	assert.equal(Value.Check(MessageSendParamsSchema, { message: "" }), false);
	assert.equal(Value.Check(MessageSendParamsSchema, { message: "x", mode: "later" }), false);
	assert.equal(Value.Check(MessageSendParamsSchema, { message: "x", extra: true }), false);
	assert.equal(Value.Check(MessageSendParamsSchema, { message: "x".repeat(1_000_001) }), false);
	assert.equal(Value.Check(SubscribeParamsSchema, { event: null }), false);
	assert.equal(Value.Check(EmptyParamsSchema, { extra: true }), false);
});

test("command schemas accept valid optional fields and reject invalid or extra fields", () => {
	const valid: Array<[string, Parameters<typeof Value.Check>[0], unknown]> = [
		["send with mode and id", MessageSendCommandSchema, { type: "send", message: "x", mode: "follow_up", id: "send-1" }],
		["send without optional fields", MessageSendCommandSchema, { type: "send", message: "x" }],
		["subscribe with id", SubscribeCommandSchema, { type: "subscribe", event: "turn_end", id: 1 }],
		["subscribe without id", SubscribeCommandSchema, { type: "subscribe", event: "turn_end" }],
		["status", StatusCommandSchema, { type: "status" }],
		["get_message", GetMessageCommandSchema, { type: "get_message" }],
		["clear", ClearCommandSchema, { type: "clear" }],
		["abort", AbortCommandSchema, { type: "abort" }],
	];
	for (const [name, schema, value] of valid) assert.equal(Value.Check(schema, value), true, name);
	assert.equal(Value.Check(MessageSendCommandSchema, { type: "send" }), false);
	assert.equal(Value.Check(MessageSendCommandSchema, { type: "send", message: "x", mode: "later" }), false);
	assert.equal(Value.Check(MessageSendCommandSchema, { type: "send", message: 1 }), false);
	assert.equal(Value.Check(MessageSendCommandSchema, { type: "send", message: "x", extra: true }), false);
	assert.equal(Value.Check(SubscribeCommandSchema, { type: "subscribe", event: "other" }), false);
	assert.equal(Value.Check(SubscribeCommandSchema, { type: "subscribe", event: "turn_end", extra: true }), false);
	assert.equal(Value.Check(StatusCommandSchema, { type: "status", id: null }), false);
});

test("command and request mappings round-trip through their strict schemas", () => {
	const commands = [
		{ type: "send", message: "x" }, { type: "send", message: "x", mode: "follow_up", id: "send-1" },
		{ type: "subscribe", event: "turn_end", id: 2 }, { type: "status" }, { type: "get_message" }, { type: "clear" }, { type: "abort" },
	] as const;
	const schemas = [MessageSendCommandSchema, MessageSendCommandSchema, SubscribeCommandSchema, StatusCommandSchema, GetMessageCommandSchema, ClearCommandSchema, AbortCommandSchema];
	for (let i = 0; i < commands.length; i += 1) {
		const command = commands[i];
		assert.equal(Value.Check(schemas[i], command), true, `command ${i}`);
		const request = commandToRequest(command, command.id ?? `roundtrip-${i}`);
		assert.equal(Value.Check((request.method === "message.send" ? MessageSendRequestSchema : request.method === "event.subscribe" ? SubscribeRequestSchema : request.method === "session.status" ? StatusRequestSchema : request.method === "session.get_message" ? GetMessageRequestSchema : request.method === "session.clear" ? ClearRequestSchema : AbortRequestSchema), request), true, `request ${i}`);
		assert.deepEqual(requestToCommand(request), { ...command, id: command.id ?? `roundtrip-${i}` });
	}
});

test("method request schemas reject invalid envelopes and required fields", () => {
	const valid: Array<[string, unknown]> = [
		["message.send", { jsonrpc: "2.0", id: "1", method: "message.send", params: { message: "x" } }],
		["event.subscribe", { jsonrpc: "2.0", id: 1, method: "event.subscribe", params: { event: "turn_end" } }],
		["session.status", { jsonrpc: "2.0", id: "s", method: "session.status" }],
		["session.get_message", { jsonrpc: "2.0", id: "g", method: "session.get_message" }],
		["session.clear", { jsonrpc: "2.0", id: "c", method: "session.clear" }],
		["session.abort", { jsonrpc: "2.0", id: "a", method: "session.abort" }],
	];
	const schemas = [MessageSendRequestSchema, SubscribeRequestSchema, StatusRequestSchema, GetMessageRequestSchema, ClearRequestSchema, AbortRequestSchema];
	for (let i = 0; i < valid.length; i += 1) assert.equal(Value.Check(schemas[i], valid[i][1]), true, valid[i][0]);
	assert.equal(Value.Check(MessageSendRequestSchema, { jsonrpc: "1.0", id: "1", method: "message.send", params: { message: "x" } }), false);
	assert.equal(Value.Check(MessageSendRequestSchema, { jsonrpc: "2.0", method: "message.send", params: { message: "x" } }), false);
	assert.equal(Value.Check(MessageSendRequestSchema, { jsonrpc: "2.0", id: "1", method: "message.send", params: { message: "x", extra: true } }), false);
	assert.equal(Value.Check(StatusRequestSchema, { jsonrpc: "2.0", id: "s", method: "session.status", params: {} }), false);
	assert.equal(Value.Check(MessageSendRequestSchema, { type: "send", message: "x" }), false);
});

test("method result, error, event, and extracted-message schemas accept only contract values", () => {
	const extracted = { role: "assistant", content: "done", timestamp: 1 };
	const cases: Array<[string, Parameters<typeof Value.Check>[0], unknown]> = [
		["status", StatusResultSchema, { status: "online" }], ["send", SendResultSchema, { delivered: true, mode: "steer" }],
		["get_message", GetMessageResultSchema, { message: extracted }], ["clear", ClearResultSchema, { cleared: true }],
		["subscribe", SubscribeResultSchema, { subscriptionId: "sub-1", event: "turn_end" }], ["abort", EmptyResultSchema, {}],
		["error", RpcErrorSchema, { code: -32602, message: "Invalid params" }],
		["event", TurnEndNotificationSchema, { jsonrpc: "2.0", method: "session.turn_end", params: { subscriptionId: "sub-1", message: extracted, turnIndex: 1 } }],
		["message", ExtractedMessageSchema, extracted],
	];
	for (const [name, schema, value] of cases) assert.equal(Value.Check(schema, value), true, name);
	assert.equal(Value.Check(StatusResultSchema, { status: "invalid" }), false);
	assert.equal(Value.Check(GetMessageResultSchema, { message: { content: "done" } }), false);
	assert.equal(Value.Check(RpcErrorSchema, { code: "bad", message: "x" }), false);
	assert.equal(Value.Check(TurnEndNotificationSchema, { jsonrpc: "2.0", method: "session.turn_end", params: { subscriptionId: "" } }), false);
	assert.equal(Value.Check(ExtractedMessageSchema, { role: "assistant", content: "x", timestamp: "now" }), false);
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
