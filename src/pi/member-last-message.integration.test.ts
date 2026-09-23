import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { closeRpcServer, createRpcServer, writeResponse } from "../infra/rpc-server.ts";
import { createMemberLastMessageFlow } from "../application/member-last-message-flow.ts";
import { createMemberLastMessageTransport } from "../infra/member-last-message-transport.ts";

async function targetServer(
	socketPath: string,
	message: { role: "assistant"; content: string; timestamp: number } | null,
): Promise<net.Server> {
	return createRpcServer(socketPath, async (command, socket) => {
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
