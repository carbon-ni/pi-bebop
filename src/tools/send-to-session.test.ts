import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerSessionTool } from "./send-to-session.ts";
import type { RpcClientOptions } from "../infra/rpc-client.ts";
import { parseCrewManifest, type RpcCommand } from "../domain/index.ts";

interface RegisteredTool {
	execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean; details?: unknown }>;
}

function setup(sendRpcCommand: (socketPath: string, command: RpcCommand, options?: RpcClientOptions) => Promise<any>, dependencies: Record<string, unknown> = {}) {
	let registeredTool: RegisteredTool | undefined;
	const pi = {
		registerTool(tool: unknown) {
			registeredTool = tool as RegisteredTool;
		},
	} as unknown as ExtensionAPI;

	registerSessionTool(
		pi,
		{
			context: {
				sessionManager: {
					getSessionId: () => "sender-id",
					getSessionName: () => "sender",
				},
			} as never,
		},
		{ sendRpcCommand, ...dependencies },
	);

	assert.ok(registeredTool);
	return registeredTool;
}

function successfulSend(): Promise<any> {
	return Promise.resolve({ response: { type: "response", command: "send", success: true, data: { delivered: true } } });
}

test("send_to_session defaults to synchronous turn_end without reverse-reply metadata", async () => {
	const calls: Array<{ command: RpcCommand; options?: RpcClientOptions }> = [];
	const tool = setup(async (socketPath, command, options) => {
		calls.push({ command, options });
		return {
			response: { type: "response", command: "send", success: true },
			event: { message: { role: "assistant", content: "answer", timestamp: 1 }, turnIndex: 2 },
		};
	});
	const signal = new AbortController().signal;

	const result = await tool.execute("call", { sessionId: "target-id", message: "hello" }, signal, undefined, undefined);

	assert.equal(result.isError, undefined);
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0]?.command, { type: "send", message: "hello", mode: "steer" });
	assert.equal(calls[0]?.options?.waitForEvent, "turn_end");
	assert.equal(calls[0]?.options?.signal, signal);
});

test("send_to_session rejects turn_end plus allow_reply before RPC IO", async () => {
	let rpcCalls = 0;
	const tool = setup(async () => {
		rpcCalls += 1;
		return successfulSend();
	});

	const result = await tool.execute("call", {
		sessionId: "target-id",
		message: "hello",
		wait_until: "turn_end",
		reply_behavior: "allow_reply",
	}, new AbortController().signal, undefined, undefined);

	assert.equal(result.isError, true);
	assert.match(result.content[0]?.text ?? "", /turn_end.*allow_reply/);
	assert.equal(rpcCalls, 0);
});

test("send_to_session targets an authoritative socket path with cwd and preserves wait/abort semantics", async () => {
	const calls: Array<{ socketPath: string; command: RpcCommand; options?: RpcClientOptions }> = [];
	const signal = new AbortController().signal;
	const tool = setup(async (socketPath, command, options) => {
		calls.push({ socketPath, command, options });
		return { response: { type: "response", command: "send", success: true }, event: { message: { role: "assistant", content: "answer" } } };
	}, {
		loadCrewManifest: async () => parseCrewManifest({ version: 1, members: [{ name: "dev", role: "developer", socket: "sockets/dev.sock" }] }, "/project/.pi/intray/crew.json"),
	});
	const result = await tool.execute("call", { socketPath: "@.pi/intray/sockets/dev.sock", message: "hello" }, signal, undefined, { cwd: "/project", isProjectTrusted: () => true } as never);
	assert.equal(result.isError, undefined);
	assert.equal(calls[0]?.socketPath, "/project/.pi/intray/sockets/dev.sock");
	assert.equal(calls[0]?.options?.waitForEvent, "turn_end");
	assert.equal(calls[0]?.options?.signal, signal);
});

test("send_to_session distinguishes unknown member, offline endpoint, self, and conflicting targets", async () => {
	let rpcCalls = 0;
	const tool = setup(async () => { rpcCalls += 1; throw new Error("connect failed"); }, {
		loadCrewManifest: async () => parseCrewManifest({ version: 1, members: [{ name: "dev", role: "developer", socket: "sockets/dev.sock" }] }, "/project/.pi/intray/crew.json"),
	});
	const context = { cwd: "/project", isProjectTrusted: () => true, sessionManager: { getSessionId: () => "sender-id" } } as never;
	const unknown = await tool.execute("call", { socketPath: ".pi/intray/sockets/qa.sock", message: "hello" }, undefined, undefined, context);
	assert.equal(unknown.isError, true);
	assert.match(unknown.content[0]!.text, /Unknown configured crew member/);
	const offline = await tool.execute("call", { socketPath: ".pi/intray/sockets/dev.sock", message: "hello" }, undefined, undefined, context);
	assert.equal(offline.isError, true);
	assert.match(offline.content[0]!.text, /Member endpoint offline/);
	const self = await tool.execute("call", { sessionId: "sender-id", message: "hello" }, undefined, undefined, context);
	assert.equal(self.isError, true);
	assert.match(self.content[0]!.text, /current session/);
	const conflict = await tool.execute("call", { socketPath: ".pi/intray/sockets/dev.sock", sessionId: "other-id", message: "hello" }, undefined, undefined, context);
	assert.equal(conflict.isError, true);
	assert.match(conflict.content[0]!.text, /does not match/);
	assert.equal(rpcCalls, 1);
});

test("send_to_session includes callback metadata for asynchronous allow_reply", async () => {
	const calls: Array<{ command: RpcCommand; options?: RpcClientOptions }> = [];
	const tool = setup(async (_socketPath, command, options) => {
		calls.push({ command, options });
		return successfulSend();
	});

	await tool.execute("call", {
		sessionId: "target-id",
		message: "hello",
		wait_until: "message_processed",
		reply_behavior: "allow_reply",
	}, new AbortController().signal, undefined, undefined);

	const command = calls[0]?.command;
	assert.equal(command?.type, "send");
	assert.doesNotMatch((command as { message: string }).message, /<reply_instruction>/);
	assert.match((command as { message: string }).message, /<sender_info>.*sender-id/);
	assert.equal(((command as { message: string }).message.match(/<sender_info>/g) ?? []).length, 1);
	assert.equal(calls[0]?.options?.waitForEvent, undefined);
});
