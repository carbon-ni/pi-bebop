import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { closeRpcServer, createRpcServer, writeResponse } from "../infra/rpc-server.ts";
import { createMemberLastMessageFlow } from "../application/member-last-message-flow.ts";
import { createMemberLastMessageTransport } from "../infra/member-last-message-transport.ts";
import { handleMemberLastMessageTarget } from "./control-runtime/member-handlers.ts";
import type { CommandHandlerContext, SocketState } from "./control-runtime/types.ts";
import { sendRpcCommand } from "../infra/rpc-client.ts";
import { getSocketPath, CONTROL_DIR } from "../infra/intray-paths.ts";
import { runMemberLastMessageCommand } from "../cli/commands/member-last-message.ts";
import { createBebopClient } from "../sdk/index.ts";

async function targetServer(
	socketPath: string,
	message: { role: "assistant"; content: string; timestamp: number } | null,
	onCommand: (command: string) => void = () => {},
): Promise<net.Server> {
	return createRpcServer(socketPath, async (command, socket) => {
		onCommand(command.type);
		if (command.type !== "get_message") return;
		writeResponse(socket, {
			type: "response",
			command: "get_message",
			success: true,
			data: { message },
			id: command.id,
		});
	});
}

test("member last-message flow delegates through a real local target socket without waking it", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "intray-last-message-"));
	const targetPath = path.join(root, "target.sock");
	const server = await targetServer(targetPath, { role: "assistant", content: "recorded", timestamp: 10 });
	t.after(async () => {
		await closeRpcServer(server);
		await fs.rm(root, { recursive: true, force: true });
	});

	const transport = createMemberLastMessageTransport(300);
	const flow = createMemberLastMessageFlow({
		getMembership: () => ({
			member: { name: "lead", role: "Lead", socketPath: path.join(root, "source.sock") },
			socketPath: path.join(root, "source.sock"),
			manifest: {
				members: [
					{ name: "lead", role: "Lead", socketPath: path.join(root, "source.sock") },
					{ name: "developer", role: "Developer", socketPath: targetPath },
				],
			},
		}),
		isTrusted: () => true,
		probeEndpoint: transport.probeEndpoint,
		requestLastMessage: transport.requestLastMessage,
	});

	assert.deepEqual(await flow.queryLastMessage("Developer"), {
		member: { name: "developer", role: "Developer" },
		message: { role: "assistant", content: "recorded", timestamp: 10 },
	});
});

test("CLI/SDK-shaped RPC traverses source authorization into target get_message without waking it", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "intray-last-message-chain-"));
	await fs.mkdir(CONTROL_DIR, { recursive: true });
	const sourceSession = `000last-message-chain-${process.pid}-${Date.now()}`;
	const sourcePath = getSocketPath(sourceSession);
	const targetPath = path.join(root, "target.sock");
	const targetCommands: string[] = [];
	const target = await targetServer(
		targetPath,
		{ role: "assistant", content: "chain result", timestamp: 11 },
		(command) => {
			targetCommands.push(command);
		},
	);
	const sourceState = {
		membershipRuntime: {
			getMembership: () => ({
				member: { name: "lead", role: "Lead", socketPath: sourcePath },
				socketPath: sourcePath,
				manifest: {
					members: [
						{ name: "lead", role: "Lead", socketPath: sourcePath },
						{ name: "developer", role: "Developer", socketPath: targetPath },
					],
				},
			}),
		},
		context: { isProjectTrusted: () => true },
	} as unknown as SocketState;
	const source = await createRpcServer(sourcePath, async (command, socket) => {
		if (command.type === "status") {
			writeResponse(socket, {
				type: "response",
				command: "status",
				success: true,
				data: { status: "joined", projectTrusted: true },
				id: command.id,
			});
			return;
		}
		if (command.type !== "member_last_message_target") return;
		const respond: CommandHandlerContext["respond"] = (success, commandName, data, error) =>
			writeResponse(socket, { type: "response", command: commandName, success, data, error, id: command.id });
		await handleMemberLastMessageTarget(
			{
				pi: {} as CommandHandlerContext["pi"],
				state: sourceState,
				ctx: {} as CommandHandlerContext["ctx"],
				socket,
				id: command.id,
				respond,
			},
			command,
		);
	});
	t.after(async () => {
		await closeRpcServer(source);
		await closeRpcServer(target);
		await fs.rm(sourcePath, { force: true });
		await fs.rm(root, { recursive: true, force: true });
	});

	const cliOutcome = await runMemberLastMessageCommand(
		{ command: "member-last-message", member: "developer", format: "json" },
		{ cwd: root, input: new PassThrough(), signal: new AbortController().signal },
		{
			resolveSource: () => ({ ok: true, kind: "id", idSocketPath: sourcePath, aliasSocketPath: sourcePath }),
			sendLastMessage: async (sourceResolution, target, signal) => {
				const result = await sendRpcCommand(
					sourceResolution.idSocketPath,
					{
						type: "member_last_message_target",
						target,
					},
					{ signal },
				);
				return result.response.success
					? { ok: true as const, result: result.response.data as never }
					: { ok: false as const, code: result.response.error ?? "remote-rejected" };
			},
			environmentSession: () => undefined,
		},
	);
	assert.equal(cliOutcome.kind, "result");
	const sdk = await createBebopClient().selectSource({ session: sourceSession });
	assert.deepEqual(await sdk.getMemberLastMessage("developer"), {
		member: { name: "developer", role: "Developer" },
		message: { role: "assistant", content: "chain result", timestamp: 11 },
	});
	assert.deepEqual(targetCommands, ["get_message", "get_message"]);
});
