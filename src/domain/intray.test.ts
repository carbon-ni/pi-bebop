import test from "node:test";
import assert from "node:assert/strict";
import { Value } from "@sinclair/typebox/value";

import type { RpcCommand } from "./index.ts";

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
	MessageSendParamsSchema,
	SubscribeParamsSchema,
	EmptyParamsSchema,
	MessageSendCommandSchema,
	SubscribeCommandSchema,
	StatusCommandSchema,
	GetMessageCommandSchema,
	ClearCommandSchema,
	AbortCommandSchema,
	commandToRequest,
	MessageSendRequestSchema,
	SubscribeRequestSchema,
	StatusRequestSchema,
	GetMessageRequestSchema,
	ClearRequestSchema,
	AbortRequestSchema,
	StatusResultSchema,
	SendResultSchema,
	GetMessageResultSchema,
	ClearResultSchema,
	SubscribeResultSchema,
	EmptyResultSchema,
	RpcErrorSchema,
	RpcResponseSchema,
	RpcTurnEndNotificationSchema,
	TurnEndNotificationSchema,
	ExtractedMessageSchema,
	PresenceHintParamsSchema,
	PresenceHintRequestSchema,
	PresenceHintCommandSchema,
	PresenceHintResultSchema,
	isPresenceHintParams,
	InterruptParamsSchema,
	InterruptRequestSchema,
	InterruptCommandSchema,
	InterruptResultSchema,
	isInterruptResult,
	MemberStatusParamsSchema,
	MemberStatusRequestSchema,
	MemberStatusCommandSchema,
	MemberStatusResultSchema,
	isMemberStatusResult,
	MemberStatusTargetParamsSchema,
	MemberStatusTargetCommandSchema,
	MemberMessageParamsSchema,
	MemberFollowUpParamsSchema,
	MemberRedirectParamsSchema,
	MemberFollowUpRequestSchema,
	MemberRedirectRequestSchema,
	MemberFollowUpCommandSchema,
	MemberRedirectCommandSchema,
	MemberInterruptResultSchema,
	MemberInterruptRequestSchema,
	MemberInterruptCommandSchema,
	isMemberInterruptResult,
	MemberRequestRequestSchema,
	MemberResponseRequestSchema,
	MemberUpdateNotificationSchema,
	MemberInboxSendRequestSchema,
	CrewBroadcastRequestSchema,
	MemberInboxSendCommandSchema,
	CrewBroadcastCommandSchema,
	MemberInboxSendResultSchema,
	CrewBroadcastResultSchema,
	isMemberInboxSendResult,
	isCrewBroadcastResult,
	MemberMessageResultSchema,
	isMemberMessageResult,
	isSendResult,
	methodResultSchema,
	MemberIdleWaitParamsSchema,
	MemberIdleWaitRequestSchema,
	MemberIdleWaitCommandSchema,
	MemberIdleWaitSubscribeResultSchema,
	MemberIdleWaitNotificationSchema,
	isMemberIdleWaitResult,
	isMemberIdleWaitNotification,
	MAX_MEMBER_IDLE_WAIT_TIMEOUT,
	RPC_ERROR,
} from "./index.ts";

test("member.idle_wait params are strict: one bounded member label plus optional bounded timeout", () => {
	assert.equal(Value.Check(MemberIdleWaitParamsSchema, { member: "Bob" }), true);
	assert.equal(Value.Check(MemberIdleWaitParamsSchema, { member: "Bob", timeoutSeconds: 300 }), true);
	assert.equal(Value.Check(MemberIdleWaitParamsSchema, { member: "Bob", timeoutSeconds: 60 }), true);
	assert.equal(Value.Check(MemberIdleWaitParamsSchema, { member: "Bob", timeoutSeconds: 7200 }), true);
	assert.equal(Value.Check(MemberIdleWaitParamsSchema, {}), false);
	assert.equal(Value.Check(MemberIdleWaitParamsSchema, { member: "" }), false);
	assert.equal(Value.Check(MemberIdleWaitParamsSchema, { member: "Bob", timeoutSeconds: 0 }), false);
	assert.equal(Value.Check(MemberIdleWaitParamsSchema, { member: "Bob", timeoutSeconds: 1 }), false);
	assert.equal(Value.Check(MemberIdleWaitParamsSchema, { member: "Bob", timeoutSeconds: 7201 }), false);
	assert.equal(Value.Check(MemberIdleWaitParamsSchema, { member: "Bob", timeoutSeconds: 1.5 }), false);
	assert.equal(Value.Check(MemberIdleWaitParamsSchema, { member: "Bob", extra: true }), false);
	assert.equal(Value.Check(MemberIdleWaitParamsSchema, { member: "x".repeat(1000) }), false);
});

test("member.idle_wait command schema accepts only the strict shape", () => {
	assert.equal(Value.Check(MemberIdleWaitCommandSchema, { type: "member_idle_wait", member: "Bob" }), true);
	assert.equal(
		Value.Check(MemberIdleWaitCommandSchema, {
			type: "member_idle_wait",
			member: "Bob",
			timeoutSeconds: 300,
			id: "q1",
		}),
		true,
	);
	assert.equal(Value.Check(MemberIdleWaitCommandSchema, { type: "member_idle_wait" }), false);
	assert.equal(Value.Check(MemberIdleWaitCommandSchema, { type: "member_idle_wait", member: "", id: "q1" }), false);
	assert.equal(
		Value.Check(MemberIdleWaitCommandSchema, { type: "member_idle_wait", member: "Bob", extra: true }),
		false,
	);
});

test("member.idle_wait round-trips through requestToCommand and commandToRequest", () => {
	const request = {
		jsonrpc: "2.0" as const,
		id: "q-1",
		method: "member.idle_wait" as const,
		params: { member: "Bob" },
	};
	assert.deepEqual(requestToCommand(request), { type: "member_idle_wait", member: "Bob", id: "q-1" });
	const withTimeout = {
		jsonrpc: "2.0" as const,
		id: "q-2",
		method: "member.idle_wait" as const,
		params: { member: "Bob", timeoutSeconds: 300 },
	};
	assert.deepEqual(requestToCommand(withTimeout), {
		type: "member_idle_wait",
		member: "Bob",
		timeoutSeconds: 300,
		id: "q-2",
	});
	const command = { type: "member_idle_wait" as const, member: "Bob", id: "q-3" };
	assert.deepEqual(commandToRequest(command, "q-3"), {
		jsonrpc: "2.0",
		id: "q-3",
		method: "member.idle_wait",
		params: { member: "Bob" },
	});
	assert.equal(
		"code" in requestToCommand({ jsonrpc: "2.0", id: "q-4", method: "member.idle_wait", params: {} }),
		true,
	);
	assert.equal(
		"code" in
			requestToCommand({
				jsonrpc: "2.0",
				id: "q-5",
				method: "member.idle_wait",
				params: { member: "Bob", timeoutSeconds: 7201 },
			}),
		true,
	);
});

test("member.idle_wait subscribe ack and terminal result schemas are strict and closed", () => {
	assert.equal(
		Value.Check(MemberIdleWaitSubscribeResultSchema, { subscriptionId: "s-1", event: "member_idle" }),
		true,
	);
	assert.equal(Value.Check(MemberIdleWaitSubscribeResultSchema, { subscriptionId: "s-1", event: "turn_end" }), false);
	assert.equal(Value.Check(MemberIdleWaitSubscribeResultSchema, { subscriptionId: "s-1" }), false);
	assert.equal(
		Value.Check(MemberIdleWaitSubscribeResultSchema, { subscriptionId: "s-1", event: "member_idle", extra: 1 }),
		false,
	);
	const terminal = {
		member: { name: "Bob", role: "developer" },
		outcome: "idle",
		disposition: "already-idle",
		observedAt: "2026-08-23T12:03:00.000Z",
	};
	assert.equal(isMemberIdleWaitResult(terminal), true);
});

test("member.idle_wait notification schema is strict and validated", () => {
	const notification = {
		jsonrpc: "2.0" as const,
		method: "member.idle_wait" as const,
		params: {
			subscriptionId: "s-1",
			result: {
				member: { name: "Bob", role: "developer" },
				outcome: "idle",
				disposition: "became-idle",
				observedAt: "2026-08-23T12:03:00.000Z",
			},
		},
	};
	assert.equal(isMemberIdleWaitNotification(notification), true);
	assert.equal(
		isMemberIdleWaitNotification({
			jsonrpc: "2.0",
			method: "session.turn_end",
			params: { subscriptionId: "s-1", message: null },
		}),
		false,
	);
	assert.equal(
		isMemberIdleWaitNotification({
			jsonrpc: "2.0",
			method: "member.idle_wait",
			params: {
				subscriptionId: "s-1",
				result: {
					member: { name: "Bob", role: "developer" },
					outcome: "offline",
					observedAt: "2026-08-23T12:03:00.000Z",
				},
			},
		}),
		true,
	);
});

test("member.idle_wait method resolves the strict subscription ack schema and timeout bound", () => {
	assert.equal(methodResultSchema("member.idle_wait"), MemberIdleWaitSubscribeResultSchema);
	assert.equal(methodResultSchema("member.idle_wait") === undefined, false);
	assert.equal(MAX_MEMBER_IDLE_WAIT_TIMEOUT, 7200);
});

test("member.status params are strict: exactly one bounded member label, no caller-selected fields", () => {
	assert.equal(Value.Check(MemberStatusParamsSchema, { member: "Bob" }), true);
	assert.equal(Value.Check(MemberStatusParamsSchema, { member: "qa" }), true);
	assert.equal(Value.Check(MemberStatusParamsSchema, {}), false);
	assert.equal(Value.Check(MemberStatusParamsSchema, { member: "" }), false);
	assert.equal(Value.Check(MemberStatusParamsSchema, { member: "x", extra: true }), false);
	assert.equal(Value.Check(MemberStatusParamsSchema, { member: "x", limit: 5 }), false);
	assert.equal(Value.Check(MemberStatusParamsSchema, { member: "x".repeat(1000) }), false);
	assert.equal(Value.Check(MemberStatusParamsSchema, { member: 42 }), false);
});

test("member.status command schema accepts only the strict shape", () => {
	assert.equal(Value.Check(MemberStatusCommandSchema, { type: "member_status", member: "Bob" }), true);
	assert.equal(Value.Check(MemberStatusCommandSchema, { type: "member_status", member: "Bob", id: "q1" }), true);
	assert.equal(Value.Check(MemberStatusCommandSchema, { type: "member_status" }), false);
	assert.equal(Value.Check(MemberStatusCommandSchema, { type: "member_status", member: "", id: "q1" }), false);
	assert.equal(Value.Check(MemberStatusCommandSchema, { type: "member_status", member: "Bob", extra: true }), false);
	assert.equal(
		Value.Check(MemberStatusCommandSchema, { type: "member_status", member: "Bob", fields: ["unsupported"] }),
		false,
	);
});

test("member.status round-trips through requestToCommand and commandToRequest", () => {
	const request = { jsonrpc: "2.0" as const, id: "q-1", method: "member.status" as const, params: { member: "Bob" } };
	assert.deepEqual(requestToCommand(request), { type: "member_status", member: "Bob", id: "q-1" });
	const command = { type: "member_status" as const, member: "Bob", id: "q-2" };
	assert.deepEqual(commandToRequest(command, "q-2"), {
		jsonrpc: "2.0",
		id: "q-2",
		method: "member.status",
		params: { member: "Bob" },
	});
	// Extra or missing params are rejected deterministically.
	assert.equal(
		"code" in
			requestToCommand({ jsonrpc: "2.0", id: "q-3", method: "member.status", params: { member: "Bob", x: 1 } }),
		true,
	);
	assert.equal("code" in requestToCommand({ jsonrpc: "2.0", id: "q-4", method: "member.status", params: {} }), true);
});

test("member.status_target is a strict delegated action with one bounded target label", () => {
	assert.equal(Value.Check(MemberStatusTargetParamsSchema, { target: "Bob" }), true);
	assert.equal(Value.Check(MemberStatusTargetParamsSchema, {}), false);
	assert.equal(Value.Check(MemberStatusTargetParamsSchema, { target: "" }), false);
	assert.equal(Value.Check(MemberStatusTargetParamsSchema, { target: "x", extra: true }), false);
	assert.equal(Value.Check(MemberStatusTargetParamsSchema, { target: "x".repeat(1000) }), false);
	assert.equal(Value.Check(MemberStatusTargetParamsSchema, { target: 42 }), false);

	assert.equal(Value.Check(MemberStatusTargetCommandSchema, { type: "member_status_target", target: "Bob" }), true);
	assert.equal(
		Value.Check(MemberStatusTargetCommandSchema, { type: "member_status_target", target: "Bob", id: "q1" }),
		true,
	);
	assert.equal(Value.Check(MemberStatusTargetCommandSchema, { type: "member_status_target" }), false);
	assert.equal(
		Value.Check(MemberStatusTargetCommandSchema, { type: "member_status_target", target: "", id: "q1" }),
		false,
	);
	assert.equal(
		Value.Check(MemberStatusTargetCommandSchema, { type: "member_status_target", target: "Bob", extra: true }),
		false,
	);
});

test("member.status_target round-trips through requestToCommand and commandToRequest with the closed result", () => {
	const request = {
		jsonrpc: "2.0" as const,
		id: "q-1",
		method: "member.status_target" as const,
		params: { target: "Mary" },
	};
	assert.deepEqual(requestToCommand(request), { type: "member_status_target", target: "Mary", id: "q-1" });
	const command = { type: "member_status_target" as const, target: "Mary", id: "q-2" };
	assert.deepEqual(commandToRequest(command, "q-2"), {
		jsonrpc: "2.0",
		id: "q-2",
		method: "member.status_target",
		params: { target: "Mary" },
	});
	assert.equal(
		"code" in
			requestToCommand({
				jsonrpc: "2.0",
				id: "q-3",
				method: "member.status_target",
				params: { target: "Bob", x: 1 },
			}),
		true,
	);
	assert.equal(
		"code" in requestToCommand({ jsonrpc: "2.0", id: "q-4", method: "member.status_target", params: {} }),
		true,
	);
	assert.equal(methodResultSchema("member.status_target"), MemberStatusResultSchema);
});

test("member.status result schema and guard accept closed online/offline statuses only", () => {
	const online = {
		member: { name: "Bob", role: "developer" },
		presence: "online",
		activity: "busy",
		hasPendingMessages: true,
		observedAt: "2026-08-23T12:03:00.000Z",
	};
	assert.equal(Value.Check(MemberStatusResultSchema, { status: online }), true);
	assert.equal(isMemberStatusResult({ status: online }), true);
	assert.equal(isMemberStatusResult({ status: { ...online, activity: "unavailable" } }), false);
	assert.equal(isMemberStatusResult({ status: { ...online, extra: true } }), false);
	assert.equal(
		isMemberStatusResult({ status: { ...online, member: { name: "Bob", role: "developer", socket: "x" } } }),
		false,
	);
	assert.equal(isMemberStatusResult({ status: "nope" }), false);
	assert.equal(isMemberStatusResult({ status: online, extra: true }), false);
	assert.equal(methodResultSchema("member.status"), MemberStatusResultSchema);
	assert.equal(methodResultSchema("member.status") === undefined, false);
});

test("presence hint uses a strict claimed identity schema and round-trips through JSON-RPC", () => {
	const params = {
		member: { identity: "/crew/dev.sock", name: "dev", role: "developer" },
		state: "online",
		instanceId: "session-1",
	} as const;
	assert.equal(Value.Check(PresenceHintParamsSchema, params), true);
	assert.equal(
		Value.Check(PresenceHintParamsSchema, { ...params, member: { ...params.member, extra: true } }),
		false,
	);
	assert.equal(isPresenceHintParams({ ...params, instanceId: " bad" }), false);
	assert.equal(isPresenceHintParams({ ...params, instanceId: "bad\0" }), false);
	assert.equal(isPresenceHintParams({ ...params, instanceId: "😀".repeat(300) }), false);
	assert.equal(
		Value.Check(PresenceHintRequestSchema, { jsonrpc: "2.0", id: "1", method: "presence.hint", params }),
		true,
	);
	assert.equal(Value.Check(PresenceHintCommandSchema, { type: "presence_hint", ...params }), true);
	assert.equal(Value.Check(PresenceHintResultSchema, { accepted: true }), true);
	assert.equal(Value.Check(PresenceHintResultSchema, {}), false);
	assert.deepEqual(requestToCommand({ jsonrpc: "2.0", id: "1", method: "presence.hint", params }), {
		type: "presence_hint",
		...params,
		id: "1",
	});
	assert.deepEqual(commandToRequest({ type: "presence_hint", ...params }, "1"), {
		jsonrpc: "2.0",
		id: "1",
		method: "presence.hint",
		params,
	});
});

test("JSON-RPC parser validates supported requests and maps methods", () => {
	const result = parseRequest(
		JSON.stringify({
			jsonrpc: "2.0",
			id: "1",
			method: "message.send",
			params: { content: "hello", delivery: "immediate" },
		}),
	);
	assert.equal(result.error, undefined);
	assert.deepEqual(requestToCommand(result.request!), {
		type: "send",
		payload: { content: "hello" },
		delivery: "immediate",
		id: "1",
	});
	assert.equal("code" in requestToCommand({ jsonrpc: "2.0", id: "2", method: "unknown" }), true);
});

test("JSON-RPC parser returns standard failures for malformed and non-RPC envelopes", () => {
	assert.equal(parseRequest("{ nope").error?.code, -32700);
	assert.equal(parseRequest(JSON.stringify({ type: "send", message: "hello" })).error?.code, -32600);
	const extra = parseRequest(
		JSON.stringify({ jsonrpc: "2.0", id: "1", method: "message.send", params: { content: "x", extra: true } }),
	).request!;
	assert.equal("code" in requestToCommand(extra), true);
});

test("method parameter schemas accept only their exact valid shapes", () => {
	const cases: Array<[string, Parameters<typeof Value.Check>[0], unknown]> = [
		["message.send explicit", MessageSendParamsSchema, { content: "hello", delivery: "immediate" }],
		["message.send default", MessageSendParamsSchema, { content: "hello" }],
		["event.subscribe", SubscribeParamsSchema, { event: "turn_end" }],
		["session.status", EmptyParamsSchema, {}],
		["session.get_message", EmptyParamsSchema, {}],
		["session.clear", EmptyParamsSchema, {}],
		["session.abort", EmptyParamsSchema, {}],
		["message.interrupt", InterruptParamsSchema, { payload: { content: "stop" } }],
	];
	for (const [method, schema, value] of cases) assert.equal(Value.Check(schema, value), true, method);
	assert.equal(Value.Check(MessageSendParamsSchema, { content: "" }), false);
	assert.equal(Value.Check(MessageSendParamsSchema, { content: "x", delivery: "later" }), false);
	assert.equal(Value.Check(MessageSendParamsSchema, { content: "x", extra: true }), false);
	assert.equal(Value.Check(MessageSendParamsSchema, { content: "x".repeat(1_000_001) }), false);
	assert.equal(Value.Check(SubscribeParamsSchema, { event: null }), false);
	assert.equal(Value.Check(EmptyParamsSchema, { extra: true }), false);
	assert.equal(Value.Check(InterruptParamsSchema, { payload: { content: "" } }), false);
	assert.equal(Value.Check(InterruptParamsSchema, { payload: { content: "x" }, extra: true }), false);
	assert.equal(Value.Check(InterruptParamsSchema, { payload: { content: "x", replyTo: { sessionId: "s" } } }), false);
});

test("command schemas accept valid optional fields and reject invalid or extra fields", () => {
	const valid: Array<[string, Parameters<typeof Value.Check>[0], unknown]> = [
		[
			"send with mode and id",
			MessageSendCommandSchema,
			{ type: "send", payload: { content: "x" }, delivery: "follow_up", id: "send-1" },
		],
		["send without optional fields", MessageSendCommandSchema, { type: "send", payload: { content: "x" } }],
		["subscribe with id", SubscribeCommandSchema, { type: "subscribe", event: "turn_end", id: 1 }],
		["subscribe without id", SubscribeCommandSchema, { type: "subscribe", event: "turn_end" }],
		["status", StatusCommandSchema, { type: "status" }],
		["get_message", GetMessageCommandSchema, { type: "get_message" }],
		["clear", ClearCommandSchema, { type: "clear" }],
		["abort", AbortCommandSchema, { type: "abort" }],
		["interrupt", InterruptCommandSchema, { type: "interrupt", payload: { content: "stop" } }],
	];
	for (const [name, schema, value] of valid) assert.equal(Value.Check(schema, value), true, name);
	assert.equal(Value.Check(MessageSendCommandSchema, { type: "send" }), false);
	assert.equal(Value.Check(InterruptCommandSchema, { type: "interrupt" }), false);
	assert.equal(Value.Check(InterruptCommandSchema, { type: "interrupt", payload: { content: 1 } }), false);
	assert.equal(
		Value.Check(MessageSendCommandSchema, { type: "send", payload: { content: "x" }, delivery: "later" }),
		false,
	);
	assert.equal(Value.Check(MessageSendCommandSchema, { type: "send", payload: { content: 1 } }), false);
	assert.equal(
		Value.Check(MessageSendCommandSchema, { type: "send", payload: { content: "x" }, extra: true }),
		false,
	);
	assert.equal(Value.Check(SubscribeCommandSchema, { type: "subscribe", event: "other" }), false);
	assert.equal(Value.Check(SubscribeCommandSchema, { type: "subscribe", event: "turn_end", extra: true }), false);
	assert.equal(Value.Check(StatusCommandSchema, { type: "status", id: null }), false);
});

test("command and request mappings round-trip through their strict schemas", () => {
	const commands = [
		{ type: "send", payload: { content: "x" } },
		{ type: "send", payload: { content: "x" }, delivery: "follow_up", id: "send-1" },
		{ type: "interrupt", payload: { content: "stop" } },
		{ type: "subscribe", event: "turn_end", id: 2 },
		{ type: "status" },
		{ type: "get_message" },
		{ type: "clear" },
		{ type: "abort" },
	] as const;
	const schemas = [
		MessageSendCommandSchema,
		MessageSendCommandSchema,
		InterruptCommandSchema,
		SubscribeCommandSchema,
		StatusCommandSchema,
		GetMessageCommandSchema,
		ClearCommandSchema,
		AbortCommandSchema,
	];
	for (let i = 0; i < commands.length; i += 1) {
		const command = commands[i];
		assert.equal(Value.Check(schemas[i], command), true, `command ${i}`);
		const request = commandToRequest(command, command.id ?? `roundtrip-${i}`);
		assert.equal(
			Value.Check(
				request.method === "message.send"
					? MessageSendRequestSchema
					: request.method === "message.interrupt"
						? InterruptRequestSchema
						: request.method === "event.subscribe"
							? SubscribeRequestSchema
							: request.method === "session.status"
								? StatusRequestSchema
								: request.method === "session.get_message"
									? GetMessageRequestSchema
									: request.method === "session.clear"
										? ClearRequestSchema
										: AbortRequestSchema,
				request,
			),
			true,
			`request ${i}`,
		);
		assert.deepEqual(requestToCommand(request), {
			...command,
			...(command.type === "send" ? { delivery: command.delivery ?? "follow_up" } : {}),
			id: command.id ?? `roundtrip-${i}`,
		});
	}
});

test("the command codec round-trips every registered discriminator with exact request shapes", () => {
	const payload = {
		content: 'hello "crew"\\n世界',
		instructions: ["follow \\\\path", "preserve \\nline"],
		origin: { kind: "crew" as const, name: "Bob", role: "developer" },
		replyTo: { sessionId: "session-1", sessionName: 'name "quoted"' },
	};
	const fixtures: Array<{ command: RpcCommand; method: string; params?: object }> = [
		{
			command: { type: "send", payload, delivery: "immediate" },
			method: "message.send",
			params: { ...payload, delivery: "immediate" },
		},
		{
			command: { type: "send", payload: { content: "minimal" } },
			method: "message.send",
			params: { content: "minimal", delivery: "follow_up" },
		},
		{
			command: { type: "interrupt", payload: { content: 'stop \\"now\\"' } },
			method: "message.interrupt",
			params: { payload: { content: 'stop \\"now\\"' } },
		},
		{ command: { type: "subscribe", event: "turn_end" }, method: "event.subscribe", params: { event: "turn_end" } },
		{ command: { type: "status" }, method: "session.status" },
		{ command: { type: "get_message" }, method: "session.get_message" },
		{ command: { type: "clear" }, method: "session.clear" },
		{ command: { type: "abort" }, method: "session.abort" },
		{
			command: {
				type: "presence_hint",
				member: { identity: "id", name: "Bob", role: "developer" },
				state: "online",
				instanceId: "instance-1",
			},
			method: "presence.hint",
			params: {
				member: { identity: "id", name: "Bob", role: "developer" },
				state: "online",
				instanceId: "instance-1",
			},
		},
		{ command: { type: "member_status", member: "Bob" }, method: "member.status", params: { member: "Bob" } },
		{
			command: { type: "member_status_target", target: "Mary" },
			method: "member.status_target",
			params: { target: "Mary" },
		},
		{
			command: { type: "member_request", requestId: "request-1", payload, timeoutSeconds: 60 },
			method: "member.request",
			params: { requestId: "request-1", payload, timeoutSeconds: 60 },
		},
		{
			command: { type: "member_response", requestId: "request-1", message: 'done \\"now\\"' },
			method: "member.respond",
			params: { requestId: "request-1", message: 'done \\"now\\"' },
		},
		{
			command: { type: "member_response", requestId: "request-2", message: "done", instructions: ["verify"] },
			method: "member.respond",
			params: { requestId: "request-2", message: "done", instructions: ["verify"] },
		},
		{
			command: { type: "member_interrupt", target: "Bob", message: "stop" },
			method: "member.interrupt",
			params: { target: "Bob", message: "stop" },
		},
		{
			command: { type: "member_follow_up", target: "Bob", message: "follow", instructions: ["one"] },
			method: "member.follow_up",
			params: { target: "Bob", message: "follow", instructions: ["one"] },
		},
		{
			command: { type: "member_redirect", target: "Bob", message: "redirect" },
			method: "member.redirect",
			params: { target: "Bob", message: "redirect" },
		},
		{
			command: { type: "member_inbox_send", target: "Bob", message: "persist", instructions: ["later"] },
			method: "member.inbox_send",
			params: { target: "Bob", message: "persist", instructions: ["later"] },
		},
		{
			command: { type: "crew_broadcast", message: 'broadcast \\"all\\"' },
			method: "crew.broadcast",
			params: { message: 'broadcast \\"all\\"' },
		},
		{
			command: { type: "member_idle_wait", member: "Bob", timeoutSeconds: 300 },
			method: "member.idle_wait",
			params: { member: "Bob", timeoutSeconds: 300 },
		},
	];
	assert.equal(new Set(fixtures.map(({ command }) => command.type)).size, 18);
	for (const [index, fixture] of fixtures.entries()) {
		const id = `codec-${index}`;
		const request = commandToRequest(fixture.command, id);
		assert.deepEqual(request, {
			jsonrpc: "2.0",
			id,
			method: fixture.method,
			...(fixture.params === undefined ? {} : { params: fixture.params }),
		});
		assert.deepEqual(requestToCommand(request), {
			...fixture.command,
			...(fixture.command.type === "send" ? { delivery: fixture.command.delivery ?? "follow_up" } : {}),
			id,
		});
		assert.deepEqual(commandToRequest(requestToCommand(request) as RpcCommand, id), request);
	}
});

test("method request schemas reject invalid envelopes and required fields", () => {
	const valid: Array<[string, unknown]> = [
		["message.send", { jsonrpc: "2.0", id: "1", method: "message.send", params: { content: "x" } }],
		[
			"message.interrupt",
			{ jsonrpc: "2.0", id: "i", method: "message.interrupt", params: { payload: { content: "stop" } } },
		],
		["event.subscribe", { jsonrpc: "2.0", id: 1, method: "event.subscribe", params: { event: "turn_end" } }],
		["session.status", { jsonrpc: "2.0", id: "s", method: "session.status" }],
		["session.get_message", { jsonrpc: "2.0", id: "g", method: "session.get_message" }],
		["session.clear", { jsonrpc: "2.0", id: "c", method: "session.clear" }],
		["session.abort", { jsonrpc: "2.0", id: "a", method: "session.abort" }],
	];
	const schemas = [
		MessageSendRequestSchema,
		InterruptRequestSchema,
		SubscribeRequestSchema,
		StatusRequestSchema,
		GetMessageRequestSchema,
		ClearRequestSchema,
		AbortRequestSchema,
	];
	for (let i = 0; i < valid.length; i += 1) assert.equal(Value.Check(schemas[i], valid[i][1]), true, valid[i][0]);
	assert.equal(
		Value.Check(MessageSendRequestSchema, {
			jsonrpc: "1.0",
			id: "1",
			method: "message.send",
			params: { content: "x" },
		}),
		false,
	);
	assert.equal(
		Value.Check(MessageSendRequestSchema, { jsonrpc: "2.0", method: "message.send", params: { content: "x" } }),
		false,
	);
	assert.equal(
		Value.Check(MessageSendRequestSchema, {
			jsonrpc: "2.0",
			id: "1",
			method: "message.send",
			params: { content: "x", extra: true },
		}),
		false,
	);
	assert.equal(
		Value.Check(StatusRequestSchema, { jsonrpc: "2.0", id: "s", method: "session.status", params: {} }),
		false,
	);
	assert.equal(Value.Check(MessageSendRequestSchema, { type: "send", message: "x" }), false);
});

test("method result, error, event, and extracted-message schemas accept only contract values", () => {
	const extracted = { role: "assistant", content: "done", timestamp: 1 };
	const cases: Array<[string, Parameters<typeof Value.Check>[0], unknown]> = [
		["status", StatusResultSchema, { status: "online" }],
		["send direct", SendResultSchema, { deliveryId: "delivery-1", disposition: "direct" }],
		["send queued", SendResultSchema, { deliveryId: "delivery-2", disposition: "queued" }],
		["send steered", SendResultSchema, { deliveryId: "delivery-3", disposition: "steered" }],
		["get_message", GetMessageResultSchema, { message: extracted }],
		["clear", ClearResultSchema, { cleared: true }],
		["subscribe", SubscribeResultSchema, { subscriptionId: "sub-1", event: "turn_end" }],
		["abort", EmptyResultSchema, {}],
		["error", RpcErrorSchema, { code: -32602, message: "Invalid params" }],
		[
			"event",
			TurnEndNotificationSchema,
			{
				jsonrpc: "2.0",
				method: "session.turn_end",
				params: { subscriptionId: "sub-1", message: extracted, turnIndex: 1 },
			},
		],
		["message", ExtractedMessageSchema, extracted],
	];
	for (const [name, schema, value] of cases) assert.equal(Value.Check(schema, value), true, name);
	assert.equal(Value.Check(StatusResultSchema, { status: "invalid" }), false);
	const invalidSendResults = [
		{ deliveryId: "", disposition: "direct" },
		{ deliveryId: 1, disposition: "direct" },
		{ disposition: "direct" },
		{ deliveryId: "delivery-1", disposition: "invalid" },
		{ deliveryId: "delivery-1", disposition: 1 },
		{ deliveryId: "delivery-1" },
		{ deliveryId: "delivery-1", disposition: "direct", extra: true },
		null,
		"delivery-1",
	];
	for (const value of invalidSendResults)
		assert.equal(Value.Check(SendResultSchema, value), false, "invalid send result");
	assert.equal(Value.Check(GetMessageResultSchema, { message: { content: "done" } }), false);
	assert.equal(Value.Check(RpcErrorSchema, { code: "bad", message: "x" }), false);
	assert.equal(
		Value.Check(TurnEndNotificationSchema, {
			jsonrpc: "2.0",
			method: "session.turn_end",
			params: { subscriptionId: "" },
		}),
		false,
	);
	assert.equal(Value.Check(ExtractedMessageSchema, { role: "assistant", content: "x", timestamp: "now" }), false);
});

test("raw socket origin remains a claimed shape and responses never echo context", () => {
	const request = parseRequest(
		JSON.stringify({
			jsonrpc: "2.0",
			id: "spoof",
			method: "message.send",
			params: { content: "claimed", origin: { kind: "crew", name: "Bob", role: "dev" } },
		}),
	);
	assert.equal(request.error, undefined);
	const command = requestToCommand(request.request!);
	assert.equal("code" in command, false);
	if (!("code" in command)) assert.deepEqual(command.payload.origin, { kind: "crew", name: "Bob", role: "dev" });
	assert.equal(
		Value.Check(RpcResponseSchema, {
			jsonrpc: "2.0",
			id: "send",
			result: { deliveryId: "d", disposition: "direct", origin: { kind: "crew", name: "Bob", role: "dev" } },
		}),
		false,
	);
	assert.equal(
		Value.Check(RpcTurnEndNotificationSchema, {
			type: "event",
			event: "turn_end",
			subscriptionId: "s",
			data: { origin: "leak" },
		}),
		false,
	);
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
	assert.equal(
		isSessionControlRequested((name) => name === "intray", []),
		true,
	);
	assert.equal(
		isSessionControlRequested((name) => name === "in", []),
		true,
	);
	assert.equal(isSessionControlRequested(noFlags, ["--pi-intray"]), false);
	assert.equal(isSessionControlRequested(noFlags, ["--session-control"]), false);
	assert.equal(isSessionControlRequested(noFlags, ["--sc"]), false);
	assert.equal(isSessionControlRequested(noFlags, []), false);
});

test("parseSessionControlAction accepts the exact crew command surface", () => {
	assert.deepEqual(parseSessionControlAction(""), { action: "status" });
	for (const action of ["leave", "members", "status", "stop"]) {
		assert.deepEqual(parseSessionControlAction(action), { action });
	}
	assert.deepEqual(parseSessionControlAction("board"), { action: "board", target: "" });
	assert.deepEqual(parseSessionControlAction("post"), { action: "post", target: "" });
	assert.deepEqual(parseSessionControlAction("agreements activate revision-1"), {
		action: "agreements",
		target: "activate revision-1",
	});
	assert.deepEqual(parseSessionControlAction("join '/tmp/project sockets/dev.sock'"), {
		action: "join",
		target: "/tmp/project sockets/dev.sock",
	});
});

test("parseSessionControlAction parses the inbox subcommand surface", () => {
	assert.deepEqual(parseSessionControlAction("inbox status"), { action: "inbox", target: "status" });
	assert.deepEqual(parseSessionControlAction("inbox pause"), { action: "inbox", target: "pause" });
	assert.deepEqual(parseSessionControlAction("inbox resume"), { action: "inbox", target: "resume" });
	assert.deepEqual(parseSessionControlAction("inbox cancel inbox-0-abc"), {
		action: "inbox",
		target: "cancel inbox-0-abc",
	});
	assert.deepEqual(parseSessionControlAction("inbox cancel 'inbox-0 abc'"), {
		action: "inbox",
		target: "cancel inbox-0 abc",
	});
});

test("parseSessionControlAction rejects malformed Agreement activation subcommands", () => {
	assert.deepEqual(parseSessionControlAction("agreements"), {
		error: "Unknown agreements action. Use /crew agreements activate <revision-id>.",
	});
	assert.deepEqual(parseSessionControlAction("agreements activate"), {
		error: "Missing revision id. Use /crew agreements activate <revision-id>.",
	});
	assert.deepEqual(parseSessionControlAction("agreements activate a b"), {
		error: "Agreement activation accepts exactly one revision id.",
	});
});

test("parseSessionControlAction rejects malformed inbox subcommands", () => {
	assert.deepEqual(parseSessionControlAction("inbox"), {
		error: "Missing inbox action. Use /crew inbox status|cancel <id>|pause|resume.",
	});
	assert.deepEqual(parseSessionControlAction("inbox bogus"), {
		error: "Unknown inbox action: bogus. Use /crew inbox status|cancel <id>|pause|resume.",
	});
	assert.deepEqual(parseSessionControlAction("inbox cancel"), {
		error: "Missing target. Use /crew inbox cancel <id>.",
	});
	assert.deepEqual(parseSessionControlAction("inbox status extra"), {
		error: "Too many arguments. Use /crew inbox status.",
	});
	assert.deepEqual(parseSessionControlAction("inbox cancel a b"), {
		error: "Too many arguments. Use /crew inbox cancel <id>.",
	});
});

test("parseSessionControlAction reports crew-specific quote errors", () => {
	assert.deepEqual(parseSessionControlAction("join 'unterminated"), {
		error: "Unclosed quote in crew command.",
	});
});

test("parseSessionControlAction rejects removed direct actions and invalid arity", () => {
	for (const action of ["listen", "connect", "disconnect"]) {
		assert.deepEqual(parseSessionControlAction(action), {
			error: `Unknown crew action: ${action}. Use /crew join <socket>|leave|members|status|stop|board [options]|post [options] <message>|agreements activate <revision-id>|inbox status|cancel <id>|pause|resume.`,
		});
	}
	assert.deepEqual(parseSessionControlAction("start"), {
		error: "Unknown crew action: start. Use /crew join <socket>|leave|members|status|stop|board [options]|post [options] <message>|agreements activate <revision-id>|inbox status|cancel <id>|pause|resume.",
	});
	assert.deepEqual(parseSessionControlAction("join"), {
		error: "Missing target. Use /crew join <socket>.",
	});
	assert.deepEqual(parseSessionControlAction("join /tmp/a.sock /tmp/b.sock"), {
		error: "Join accepts exactly one target.",
	});
	assert.deepEqual(parseSessionControlAction("status now"), {
		error: "Too many arguments. Use /crew join <socket>|leave|members|status|stop|board [options]|post [options] <message>|agreements activate <revision-id>|inbox status|cancel <id>|pause|resume.",
	});
});

test("member.request/respond round-trip strict coordination contracts", () => {
	const request = {
		jsonrpc: "2.0" as const,
		id: "coord-1",
		method: "member.request" as const,
		params: {
			requestId: "req-1",
			payload: { content: "Please review", origin: { kind: "crew" as const, name: "dev", role: "developer" } },
			timeoutSeconds: 300,
		},
	};
	assert.equal(Value.Check(MemberRequestRequestSchema, request), true);
	assert.deepEqual(requestToCommand(request), {
		type: "member_request",
		requestId: "req-1",
		payload: request.params.payload,
		timeoutSeconds: 300,
		id: "coord-1",
	});
	const response = {
		jsonrpc: "2.0" as const,
		id: "coord-2",
		method: "member.respond" as const,
		params: { requestId: "req-1", message: "Response", instructions: ["next"] },
	};
	assert.equal(Value.Check(MemberResponseRequestSchema, response), true);
	assert.deepEqual(requestToCommand(response), { type: "member_response", ...response.params, id: "coord-2" });
	assert.equal(
		Value.Check(MemberUpdateNotificationSchema, {
			jsonrpc: "2.0",
			method: "member.update",
			params: { kind: "idle", requestId: "req-1", member: { name: "qa", role: "reviewer" } },
		}),
		true,
	);
	// TASK-0080: idle-without-response is removed from the wire union.
	assert.equal(
		Value.Check(MemberUpdateNotificationSchema, {
			jsonrpc: "2.0",
			method: "member.update",
			params: { kind: "idle-without-response", requestId: "req-1", member: { name: "qa", role: "reviewer" } },
		}),
		false,
	);
});

test("removed member.focus method follows the standard unknown-method response", () => {
	const request = {
		jsonrpc: "2.0" as const,
		id: "focus-1",
		method: "member.focus" as const,
		params: { action: "set" as const, focus: "--blocked" },
	};
	assert.deepEqual(requestToCommand(request), {
		code: RPC_ERROR.methodNotFound,
		message: "Method not found: member.focus",
		data: { code: "method-not-found" },
	});
	assert.deepEqual(
		requestToCommand({ ...request, method: "member.focus" as const, params: { action: "clear" as const } }),
		{
			code: RPC_ERROR.methodNotFound,
			message: "Method not found: member.focus",
			data: { code: "method-not-found" },
		},
	);
	assert.equal(methodResultSchema("member.focus"), undefined);
});

test("member.interrupt round-trips through the delegated source command contract", () => {
	const request = {
		jsonrpc: "2.0" as const,
		id: "member-int-1",
		method: "member.interrupt" as const,
		params: { target: "qa", message: "stop", instructions: ["recover"] },
	};
	assert.deepEqual(requestToCommand(request), {
		type: "member_interrupt",
		target: "qa",
		message: "stop",
		instructions: ["recover"],
		id: "member-int-1",
	});
	assert.deepEqual(
		commandToRequest(
			{ type: "member_interrupt", target: "qa", message: "stop", instructions: ["recover"] },
			"member-int-1",
		),
		request,
	);
	assert.deepEqual(methodResultSchema("member.interrupt"), MemberInterruptResultSchema);
	assert.equal(
		isMemberInterruptResult({
			member: { name: "Kelly", role: "qa" },
			interruptId: "interrupt-1",
			disposition: "direct",
		}),
		true,
	);
	assert.equal(
		isMemberInterruptResult({
			member: { name: "Kelly", role: "qa" },
			interruptId: "interrupt-1",
			disposition: "done",
		}),
		false,
	);
});

test("message.interrupt round-trips through requestToCommand with a structured payload", () => {
	const payload = { content: "stop now", origin: { kind: "crew", name: "Tony", role: "lead" } };
	const request = { jsonrpc: "2.0" as const, id: "int-1", method: "message.interrupt" as const, params: { payload } };
	assert.deepEqual(requestToCommand(request), { type: "interrupt", payload, id: "int-1" });
	const command = { type: "interrupt" as const, payload, id: "int-2" };
	assert.deepEqual(commandToRequest(command, "int-2"), {
		jsonrpc: "2.0",
		id: "int-2",
		method: "message.interrupt",
		params: { payload },
	});
});

test("interrupt result schema and guard accept only the two dispositions", () => {
	assert.equal(
		Value.Check(InterruptResultSchema, { interruptId: "int-1", disposition: "interrupt-requested" }),
		true,
	);
	assert.equal(Value.Check(InterruptResultSchema, { interruptId: "int-1", disposition: "direct" }), true);
	assert.equal(isInterruptResult({ interruptId: "int-1", disposition: "interrupt-requested" }), true);
	assert.equal(isInterruptResult({ interruptId: "int-1", disposition: "queued" }), false);
	assert.equal(isInterruptResult({ interruptId: "", disposition: "direct" }), false);
	assert.equal(isInterruptResult({ interruptId: "int-1", disposition: "direct", extra: true }), false);
});

test("member.follow_up / member.redirect params are strict: bounded target, verbatim message, bounded instructions", () => {
	const params = { target: "Kelly", message: "wrap up", instructions: ["one", "two"] };
	assert.equal(Value.Check(MemberFollowUpParamsSchema, params), true);
	assert.equal(Value.Check(MemberRedirectParamsSchema, params), true);
	assert.equal(Value.Check(MemberFollowUpParamsSchema, { target: "Kelly", message: "hi" }), true);
	assert.equal(Value.Check(MemberFollowUpParamsSchema, { target: "Kelly" }), false);
	assert.equal(Value.Check(MemberFollowUpParamsSchema, { target: "Kelly", message: "" }), false);
	assert.equal(Value.Check(MemberFollowUpParamsSchema, { target: "", message: "hi" }), false);
	assert.equal(Value.Check(MemberFollowUpParamsSchema, { target: "Kelly", message: "hi", extra: true }), false);
	assert.equal(Value.Check(MemberFollowUpParamsSchema, { target: "Kelly", message: "hi", instructions: [] }), false);
	assert.equal(
		Value.Check(MemberFollowUpParamsSchema, { target: "Kelly", message: "hi", instructions: ["ok", "ok", "ok"] }),
		true,
	);
	assert.equal(Value.Check(MemberFollowUpParamsSchema, { target: "x".repeat(1000), message: "hi" }), false);
});

test("member_follow_up and member_redirect commands are closed and discriminated by type", () => {
	assert.equal(
		Value.Check(MemberFollowUpCommandSchema, { type: "member_follow_up", target: "Kelly", message: "hi" }),
		true,
	);
	assert.equal(
		Value.Check(MemberRedirectCommandSchema, { type: "member_redirect", target: "Kelly", message: "hi" }),
		true,
	);
	assert.equal(
		Value.Check(MemberFollowUpCommandSchema, { type: "member_redirect", target: "Kelly", message: "hi" }),
		false,
	);
	assert.equal(Value.Check(MemberFollowUpCommandSchema, { type: "member_follow_up", target: "Kelly" }), false);
	assert.equal(
		Value.Check(MemberFollowUpCommandSchema, {
			type: "member_follow_up",
			target: "Kelly",
			message: "hi",
			id: "m1",
		}),
		true,
	);
	assert.equal(
		Value.Check(MemberFollowUpCommandSchema, {
			type: "member_follow_up",
			target: "Kelly",
			message: "hi",
			wait_for: "response",
		}),
		false,
	);
});

test("member.follow_up / member.redirect round-trip with the delivery-ack result schema", () => {
	const request = {
		jsonrpc: "2.0" as const,
		id: "m-1",
		method: "member.follow_up" as const,
		params: { target: "Kelly", message: "wrap up", instructions: ["careful"] },
	};
	assert.deepEqual(requestToCommand(request), {
		type: "member_follow_up",
		target: "Kelly",
		message: "wrap up",
		instructions: ["careful"],
		id: "m-1",
	});
	assert.deepEqual(requestToCommand({ ...request, method: "member.redirect" as const }), {
		type: "member_redirect",
		target: "Kelly",
		message: "wrap up",
		instructions: ["careful"],
		id: "m-1",
	});

	const followUp = { type: "member_follow_up" as const, target: "Kelly", message: "wrap up", id: "m-2" };
	assert.deepEqual(commandToRequest(followUp, "m-2"), {
		jsonrpc: "2.0",
		id: "m-2",
		method: "member.follow_up",
		params: { target: "Kelly", message: "wrap up" },
	});
	const redirect = { type: "member_redirect" as const, target: "Kelly", message: "go", instructions: ["now"] };
	assert.deepEqual(commandToRequest(redirect, "m-3"), {
		jsonrpc: "2.0",
		id: "m-3",
		method: "member.redirect",
		params: { target: "Kelly", message: "go", instructions: ["now"] },
	});

	// Delivery acknowledgement result with resolved identity; never a response
	// correlation field, and the closed member.message result is not the raw
	// target-side send ack.
	assert.deepEqual(methodResultSchema("member.follow_up"), MemberMessageResultSchema);
	assert.deepEqual(methodResultSchema("member.redirect"), MemberMessageResultSchema);
	assert.equal(
		isMemberMessageResult({
			member: { name: "Kelly", role: "qa" },
			deliveryId: "d-1",
			disposition: "queued",
		}),
		true,
	);
	assert.equal(
		isMemberMessageResult({ member: { name: "Kelly", role: "qa" }, deliveryId: "d-1", disposition: "replied" }),
		false,
	);
	assert.equal(
		isMemberMessageResult({
			member: { name: "Kelly", role: "qa" },
			deliveryId: "d-1",
			disposition: "queued",
			reply: "x",
		}),
		false,
	);
	assert.equal(isMemberMessageResult({ deliveryId: "d-1", disposition: "queued" }), false);
});

test("member.inbox_send and crew.broadcast are closed persistence commands", () => {
	assert.equal(
		Value.Check(MemberInboxSendRequestSchema, {
			jsonrpc: "2.0",
			id: "i-1",
			method: "member.inbox_send",
			params: { target: "Kelly", message: "hello", instructions: ["careful"] },
		}),
		true,
	);
	assert.equal(
		Value.Check(MemberInboxSendRequestSchema, {
			jsonrpc: "2.0",
			id: "i-1",
			method: "member.inbox_send",
			params: { target: "Kelly", message: "hello", source: "caller" },
		}),
		false,
	);
	assert.equal(
		Value.Check(CrewBroadcastRequestSchema, {
			jsonrpc: "2.0",
			id: "b-1",
			method: "crew.broadcast",
			params: { message: "hello", instructions: ["careful"] },
		}),
		true,
	);
	assert.equal(
		Value.Check(CrewBroadcastRequestSchema, {
			jsonrpc: "2.0",
			id: "b-1",
			method: "crew.broadcast",
			params: { message: "hello", manifestPath: "/tmp/crew.json" },
		}),
		false,
	);
	assert.equal(
		Value.Check(MemberInboxSendCommandSchema, { type: "member_inbox_send", target: "Kelly", message: "hello" }),
		true,
	);
	assert.equal(Value.Check(CrewBroadcastCommandSchema, { type: "crew_broadcast", message: "hello" }), true);
	assert.equal(
		Value.Check(CrewBroadcastCommandSchema, { type: "crew_broadcast", message: "hello", socketPath: "/x" }),
		false,
	);
	assert.deepEqual(
		requestToCommand({
			jsonrpc: "2.0",
			id: "i-2",
			method: "member.inbox_send",
			params: { target: "Kelly", message: "hello" },
		}),
		{ type: "member_inbox_send", target: "Kelly", message: "hello", id: "i-2" },
	);
	assert.deepEqual(
		requestToCommand({
			jsonrpc: "2.0",
			id: "b-2",
			method: "crew.broadcast",
			params: { message: "hello" },
		}),
		{ type: "crew_broadcast", message: "hello", id: "b-2" },
	);
	assert.deepEqual(methodResultSchema("member.inbox_send"), MemberInboxSendResultSchema);
	assert.deepEqual(methodResultSchema("crew.broadcast"), CrewBroadcastResultSchema);
	assert.equal(
		isMemberInboxSendResult({
			member: { name: "Kelly", role: "qa" },
			itemId: "inbox-1",
			persisted: true,
			hint: "skipped",
		}),
		true,
	);
	assert.equal(
		isCrewBroadcastResult({
			broadcastId: "broadcast-1",
			dispositions: [],
			summary: { persisted: 0, alreadyPersisted: 0, failed: 0, total: 0 },
		}),
		true,
	);
	assert.equal(
		isCrewBroadcastResult({
			broadcastId: "broadcast-1",
			dispositions: [{ member: "Mary", role: "po", itemId: "item-1", disposition: "failed" }],
			summary: { persisted: 0, alreadyPersisted: 0, failed: 1, total: 1 },
		}),
		false,
	);
	assert.equal(
		isCrewBroadcastResult({
			broadcastId: "broadcast-1",
			dispositions: [
				{ member: "Mary", role: "po", itemId: "item-1", disposition: "persisted", code: "unexpected" },
			],
			summary: { persisted: 1, alreadyPersisted: 0, failed: 0, total: 1 },
		}),
		false,
	);
	assert.equal(
		isCrewBroadcastResult({
			broadcastId: "broadcast-1",
			dispositions: [
				{ member: "Mary", role: "po", itemId: "item-1", disposition: "failed", code: "not-approved" },
			],
			summary: { persisted: 0, alreadyPersisted: 0, failed: 1, total: 1 },
		}),
		false,
	);
	assert.equal(
		isCrewBroadcastResult({
			broadcastId: "broadcast-1",
			dispositions: [{ member: "Mary", role: "po", itemId: "item-1", disposition: "failed", code: "inbox-full" }],
			summary: { persisted: 0, alreadyPersisted: 0, failed: 0, total: 1 },
		}),
		false,
	);
});
