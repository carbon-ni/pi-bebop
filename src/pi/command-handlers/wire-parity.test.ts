import test from "node:test";
import assert from "node:assert/strict";
import { createSocketState, handleCommand } from "../control-runtime.ts";
import { createRpcServer, closeRpcServer, writeEvent } from "../../infra/rpc-server.ts";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { wireParityFixtures } from "./wire-parity.fixture.ts";

test("RPC extraction preserves the characterized raw response line for every command type", async () => {
	const state = createSocketState();
	state.server = {} as never;
	state.context = {
		sessionManager: {
			getSessionId: () => "wire-session",
			getBranch: () => [],
			getEntries: () => [],
			getLeafId: () => "root",
		},
		isIdle: () => true,
		isCompacting: () => false,
		hasPendingMessages: () => false,
		isProjectTrusted: () => true,
		abort: () => undefined,
	} as never;
	const pi = { sendMessage: () => undefined, appendEntry: () => undefined } as never;

	for (const fixture of wireParityFixtures) {
		const writes: string[] = [];
		const socket = { write: (value: string) => writes.push(value), once: () => socket } as never;
		await handleCommand(pi, state, fixture.command as never, socket);
		assert.deepEqual(writes, [fixture.expected], fixture.type);
	}
});

test("real RPC server preserves golden response bytes for every command and event ordering", async () => {
	const socketPath = path.join(os.tmpdir(), `bebop-wire-${process.pid}-${Date.now()}.sock`);
	const state = createSocketState();
	let branchEntries: unknown[] = [];
	const context = {
		sessionManager: {
			getSessionId: () => "wire-session",
			getSessionName: () => "wire-session",
			getBranch: () => branchEntries,
			getEntries: () => [],
			getLeafId: () => "root",
		},
		isIdle: () => true,
		isCompacting: () => false,
		hasPendingMessages: () => false,
		isProjectTrusted: () => true,
		abort: () => undefined,
	} as never;
	state.context = context;
	const pi = { sendMessage: () => undefined, appendEntry: () => undefined } as never;
	let serverSocket: net.Socket | undefined;
	const server = await createRpcServer(socketPath, (command, socket) => {
		serverSocket = socket as net.Socket;
		return handleCommand(pi, state, command, socket);
	});
	state.server = server;
	const client = net.createConnection(socketPath);
	client.setEncoding("utf8");
	const lines: string[] = [];
	let buffered = "";
	client.on("data", (chunk) => {
		buffered += chunk;
		for (let index = buffered.indexOf("\n"); index !== -1; index = buffered.indexOf("\n")) {
			lines.push(buffered.slice(0, index + 1));
			buffered = buffered.slice(index + 1);
		}
	});
	await new Promise<void>((resolve) => client.once("connect", () => resolve()));
	const requests = [
		[
			{ jsonrpc: "2.0", id: "status-1", method: "session.status" },
			'{"jsonrpc":"2.0","id":"status-1","result":{"status":"online"}}\n',
		],
		[
			{ jsonrpc: "2.0", id: "get", method: "session.get_message" },
			'{"jsonrpc":"2.0","id":"get","result":{"message":null}}\n',
		],
		[
			{ jsonrpc: "2.0", id: "clear", method: "session.clear" },
			'{"jsonrpc":"2.0","id":"clear","error":{"code":-32603,"message":"No entries in session"}}\n',
		],
		[{ jsonrpc: "2.0", id: "abort", method: "session.abort" }, '{"jsonrpc":"2.0","id":"abort","result":{}}\n'],
		[
			{ jsonrpc: "2.0", id: "sub", method: "event.subscribe", params: { event: "turn_end" } },
			'{"jsonrpc":"2.0","id":"sub","result":{"subscriptionId":"sub","event":"turn_end"}}\n',
		],
		[
			{
				jsonrpc: "2.0",
				id: "send",
				method: "message.send",
				params: { content: 'quote "\\\\', instructions: ["step"], origin: { kind: "external", label: "cli" } },
			},
			'{"jsonrpc":"2.0","id":"send","result":{"deliveryId":"delivery-send","disposition":"direct"}}\n',
		],
		[
			{ jsonrpc: "2.0", id: "interrupt", method: "message.interrupt", params: { payload: {} } },
			'{"jsonrpc":"2.0","id":"interrupt","error":{"code":-32602,"message":"Invalid message.interrupt params"}}\n',
		],
		[
			{
				jsonrpc: "2.0",
				id: "request",
				method: "member.request",
				params: {
					requestId: "r",
					payload: {
						content: "x",
						instructions: ["step"],
						origin: { kind: "crew", name: "Mary", role: "po" },
					},
					timeoutSeconds: 60,
				},
			},
			'{"jsonrpc":"2.0","id":"request","error":{"code":-32603,"message":"not-joined"}}\n',
		],
		[
			{
				jsonrpc: "2.0",
				id: "response",
				method: "member.respond",
				params: { requestId: "r", message: "x", instructions: ["step"] },
			},
			'{"jsonrpc":"2.0","id":"response","error":{"code":-32603,"message":"not-joined"}}\n',
		],
		[
			{
				jsonrpc: "2.0",
				id: "presence",
				method: "presence.hint",
				params: { member: { identity: "i", name: "Mary", role: "po" }, state: "online", instanceId: "i" },
			},
			'{"jsonrpc":"2.0","id":"presence","result":{"accepted":false}}\n',
		],
		[
			{ jsonrpc: "2.0", id: "member-status", method: "member.status", params: { member: "Mary" } },
			'{"jsonrpc":"2.0","id":"member-status","error":{"code":-32603,"message":"not-joined"}}\n',
		],
		[
			{ jsonrpc: "2.0", id: "target-status", method: "member.status_target", params: { target: "Mary" } },
			'{"jsonrpc":"2.0","id":"target-status","error":{"code":-32603,"message":"not-joined"}}\n',
		],
		[
			{
				jsonrpc: "2.0",
				id: "follow",
				method: "member.follow_up",
				params: { target: "Mary", message: "x", instructions: ["step"] },
			},
			'{"jsonrpc":"2.0","id":"follow","error":{"code":-32603,"message":"not-joined"}}\n',
		],
		[
			{
				jsonrpc: "2.0",
				id: "redirect",
				method: "member.redirect",
				params: { target: "Mary", message: "x", instructions: ["step"] },
			},
			'{"jsonrpc":"2.0","id":"redirect","error":{"code":-32603,"message":"not-joined"}}\n',
		],
		[
			{
				jsonrpc: "2.0",
				id: "inbox",
				method: "member.inbox_send",
				params: { target: "Mary", message: "x", instructions: ["step"] },
			},
			'{"jsonrpc":"2.0","id":"inbox","error":{"code":-32603,"message":"not-joined","data":{"code":"not-joined"}}}\n',
		],
		[
			{
				jsonrpc: "2.0",
				id: "broadcast",
				method: "crew.broadcast",
				params: { message: "x", instructions: ["step"] },
			},
			'{"jsonrpc":"2.0","id":"broadcast","error":{"code":-32603,"message":"not-joined","data":{"code":"not-joined"}}}\n',
		],
		[
			{ jsonrpc: "2.0", id: "idle", method: "member.idle_wait", params: { member: "Mary", timeoutSeconds: 60 } },
			'{"jsonrpc":"2.0","id":"idle","error":{"code":-32603,"message":"not-joined"}}\n',
		],
		[
			{
				jsonrpc: "2.0",
				id: "member-interrupt",
				method: "member.interrupt",
				params: { target: "Mary", message: "x", instructions: ["step"] },
			},
			'{"jsonrpc":"2.0","id":"member-interrupt","error":{"code":-32603,"message":"not-joined"}}\n',
		],
	] as const;
	for (const [index, [request, expected]] of requests.entries()) {
		client.write(`${JSON.stringify(request)}\n`);
		await new Promise<void>((resolve) => {
			const check = () => (lines.length >= index + 1 ? resolve() : setImmediate(check));
			check();
		});
		assert.equal(lines.at(-1), expected);
	}
	branchEntries = [
		{
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: 'answer "quoted"' }], timestamp: 8 },
		},
	];
	const successfulGet = { jsonrpc: "2.0", id: "get-success", method: "session.get_message" };
	client.write(`${JSON.stringify(successfulGet)}\n`);
	await new Promise<void>((resolve) => {
		const check = () => (lines.length >= requests.length + 1 ? resolve() : setImmediate(check));
		check();
	});
	assert.equal(
		lines.at(-1),
		'{"jsonrpc":"2.0","id":"get-success","result":{"message":{"role":"assistant","content":"answer \\"quoted\\"","timestamp":8}}}\n',
	);
	assert.ok(serverSocket);
	writeEvent(serverSocket!, {
		subscriptionId: "sub",
		data: { message: { role: "assistant", content: 'escaped "turn"', timestamp: 7 }, turnIndex: 7 },
	});
	await new Promise<void>((resolve) => {
		const check = () => (lines.length === requests.length + 2 ? resolve() : setImmediate(check));
		check();
	});
	assert.equal(
		lines.at(-1),
		'{"jsonrpc":"2.0","method":"session.turn_end","params":{"subscriptionId":"sub","message":{"role":"assistant","content":"escaped \\"turn\\"","timestamp":7},"turnIndex":7}}\n',
	);
	client.destroy();
	await closeRpcServer(server);
	await import("node:fs/promises").then((fs) => fs.rm(socketPath, { force: true }));
});
