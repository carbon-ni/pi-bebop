import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { handleMemberLastMessageTarget } from "./member-handlers.ts";
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
			probeEndpoint: async () => true,
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

test("member.last_message_target rejects an untrusted source before target IO", async () => {
	let requests = 0;
	const responses: unknown[] = [];
	await handleMemberLastMessageTarget(
		context(
			{
				context: { isProjectTrusted: () => false } as never,
				memberLastMessageTransport: {
					probeEndpoint: async () => {
						requests += 1;
						return true;
					},
					requestLastMessage: async () => ({ ok: true as const, message: null }),
				},
			},
			(...args) => responses.push(args),
		),
		{ type: "member_last_message_target", target: "developer", id: "last-message-2" },
	);
	assert.equal(requests, 0);
	assert.equal((responses[0] as unknown[])[3], "untrusted");
});
