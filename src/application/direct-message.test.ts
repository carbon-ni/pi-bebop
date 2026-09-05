import test from "node:test";
import assert from "node:assert/strict";
import { sendDirectMessage } from "./direct-message.ts";
import type { RpcCommand } from "../domain/index.ts";
import type { RpcClientOptions } from "../infra/rpc-client.ts";

test("sends exact message without sender metadata and returns an accepted result", async () => {
	let call: { path: string; command: RpcCommand; options: RpcClientOptions } | undefined;
	const result = await sendDirectMessage(
		{ socketPath: "/x", message: "private\ntext", mode: "steer", wait: "accepted", timeoutMs: 123 },
		async (path, command, options) => {
			call = { path, command, options };
			return { response: { type: "response", command: "send", success: true, data: { delivered: true } } };
		},
	);
	assert.deepEqual(call, {
		path: "/x",
		command: { type: "send", payload: { content: "private\ntext" }, delivery: "immediate" },
		options: { timeout: 123, signal: undefined },
	});
	assert.equal((call!.command as { payload: { content: string } }).payload.content, "private\ntext");
	assert.equal(JSON.stringify(call!.command).includes("sender_info"), false);
	assert.deepEqual(result, { status: "accepted", data: { delivered: true } });
});

test("keeps callback routing separate from claimed origin", async () => {
	const calls: RpcCommand[] = [];
	const send = async (_path: string, command: RpcCommand) => {
		calls.push(command);
		return { response: { type: "response", command: "send", success: true, data: { delivered: true } } };
	};
	await sendDirectMessage(
		{
			socketPath: "/x",
			message: "hello",
			mode: "steer",
			wait: "accepted",
			origin: { kind: "external", label: "CI" },
		},
		send,
	);
	await sendDirectMessage(
		{
			socketPath: "/x",
			message: "hello",
			mode: "steer",
			wait: "accepted",
			origin: { kind: "external", label: "CI" },
			sender: { sessionId: "s" },
		},
		send,
	);
	assert.deepEqual(calls[0]?.payload.origin, calls[1]?.payload.origin);
	assert.equal(calls[0]?.payload.replyTo, undefined);
	assert.deepEqual(calls[1]?.payload.replyTo, { sessionId: "s" });
});

test("keeps accepted callback routing separate from claimed origin", async () => {
	const calls: RpcCommand[] = [];
	const send = async (_path: string, command: RpcCommand) => {
		calls.push(command);
		return { response: { type: "response", command: "send", success: true, data: { delivered: true } } };
	};
	await sendDirectMessage(
		{
			socketPath: "/x",
			message: "x",
			mode: "steer",
			wait: "accepted",
			origin: { kind: "crew", name: "Bob", role: "dev" },
		},
		send,
	);
	await sendDirectMessage(
		{
			socketPath: "/x",
			message: "x",
			mode: "steer",
			wait: "accepted",
			origin: { kind: "crew", name: "Bob", role: "dev" },
			sender: { sessionId: "s" },
		},
		send,
	);
	assert.equal(calls[0]?.payload.replyTo, undefined);
	assert.deepEqual(calls[0]?.payload.origin, calls[1]?.payload.origin);
	assert.deepEqual(calls[1]?.payload.replyTo, { sessionId: "s" });
});

test("rejects uncorrelated turn_end before sending or reading peer output", async () => {
	let called = false;
	await assert.rejects(
		() =>
			sendDirectMessage(
				{ socketPath: "/x", message: "x", mode: "follow_up", wait: "turn_end", timeoutMs: 500 },
				async () => {
					called = true;
					return { response: { type: "response", command: "send", success: true } };
				},
			),
		(error: unknown) =>
			error instanceof Error &&
			error.name === "DirectMessageError" &&
			(error as { code?: string }).code === "uncorrelated-response" &&
			error.message.includes("pi-bebop member request send") &&
			error.message.includes("pi-bebop member request wait") &&
			!error.message.includes("send_member_request"),
	);
	assert.equal(called, false);
});

test("accepted delivery never exposes an assistant response", async () => {
	const result = await sendDirectMessage(
		{ socketPath: "/x", message: "x", mode: "steer", wait: "accepted" },
		async () => ({
			response: { type: "response", command: "send", success: true },
			event: { message: { role: "assistant", content: "unrelated", timestamp: 1 }, turnIndex: 7 },
		}),
	);
	assert.deepEqual(result, { status: "accepted" });
});
