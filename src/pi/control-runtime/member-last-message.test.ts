import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { handleMemberLastMessageTarget } from "./member-handlers.ts";
import { handleGetMessage } from "./system-handlers.ts";
import { MAX_MESSAGE_CONTENT_BYTES } from "../../domain/message-payload.ts";
import type { CommandHandlerContext, SocketState } from "./types.ts";

function context(
	overrides: Partial<SocketState> = {},
	respond: CommandHandlerContext["respond"] = () => {},
): CommandHandlerContext {
	const socket = new EventEmitter();
	const state = {
		membershipRuntime: {
			getMembership: () => ({
				member: { name: "lead", role: "Lead", socketPath: "/tmp/lead.sock" },
				socketPath: "/tmp/lead.sock",
				manifest: {
					members: [
						{ name: "lead", role: "Lead", socketPath: "/tmp/lead.sock" },
						{ name: "developer", role: "Developer", socketPath: "/tmp/developer.sock" },
					],
				},
			}),
		},
		context: { isProjectTrusted: () => true },
		memberLastMessageTransport: {
			requestLastMessage: async () => ({ ok: true as const, message: null }),
		},
		...overrides,
	} as unknown as SocketState;
	return {
		pi: {} as CommandHandlerContext["pi"],
		state,
		ctx: {} as CommandHandlerContext["ctx"],
		socket: socket as never,
		id: "last-message-1",
		respond,
	};
}

test("member.last_message_target delegates read-only empty snapshots through source authorization", async () => {
	const responses: unknown[] = [];
	await handleMemberLastMessageTarget(
		context({}, (...args) => responses.push(args)),
		{ type: "member_last_message_target", target: "developer", id: "last-message-1" },
	);
	assert.deepEqual(responses[0], [
		true,
		"member_last_message_target",
		{ member: { name: "developer", role: "Developer" }, message: null },
	]);
});

test("get_message rejects a malformed newest assistant entry without revealing older text", async () => {
	const responses: unknown[] = [];
	const socket = new EventEmitter();
	await handleGetMessage(
		{
			pi: {} as CommandHandlerContext["pi"],
			state: {} as SocketState,
			ctx: {
				sessionManager: {
					getBranch: () => [
						{
							type: "message",
							message: { role: "assistant", content: [{ type: "text", text: "older" }], timestamp: 1 },
						},
						{
							type: "message",
							message: { role: "assistant", content: [{ type: "text", text: 7 }], timestamp: 2 },
						},
					],
				},
			} as never,
			socket: socket as never,
			id: "get-message-1",
			respond: (...args) => responses.push(args),
		},
		{ type: "get_message", id: "get-message-1" },
	);
	assert.deepEqual(responses[0], [false, "get_message", undefined, "malformed-response"]);
});

test("get_message rejects an oversized newest assistant entry", async () => {
	const responses: unknown[] = [];
	const socket = new EventEmitter();
	await handleGetMessage(
		{
			pi: {} as CommandHandlerContext["pi"],
			state: {} as SocketState,
			ctx: {
				sessionManager: {
					getBranch: () => [
						{
							type: "message",
							message: { role: "assistant", content: [{ type: "text", text: "older" }], timestamp: 1 },
						},
						{
							type: "message",
							message: {
								role: "assistant",
								content: [{ type: "text", text: "x".repeat(MAX_MESSAGE_CONTENT_BYTES + 1) }],
								timestamp: 2,
							},
						},
					],
				},
			} as never,
			socket: socket as never,
			id: "get-message-2",
			respond: (...args) => responses.push(args),
		},
		{ type: "get_message", id: "get-message-2" },
	);
	assert.deepEqual(responses[0], [false, "get_message", undefined, "message-too-large"]);
});

test("member.last_message_target rejects an untrusted source before target IO", async () => {
	let requests = 0;
	const responses: unknown[] = [];
	await handleMemberLastMessageTarget(
		context(
			{
				context: { isProjectTrusted: () => false } as never,
				memberLastMessageTransport: {
					requestLastMessage: async () => {
						requests += 1;
						return { ok: true as const, message: null };
					},
				},
			},
			(...args) => responses.push(args),
		),
		{ type: "member_last_message_target", target: "developer", id: "last-message-2" },
	);
	assert.equal(requests, 0);
	assert.equal((responses[0] as unknown[])[3], "untrusted");
});
