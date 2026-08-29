import test from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildWaitStateNotification } from "../domain/index.ts";
import { sendMemberWaitState } from "./wait-state-client.ts";

const snapshot = (wait: null) => ({ member: { name: "Dave", role: "dev" }, wait });
const listen = (server: net.Server, socketPath: string) =>
	new Promise<void>((resolve) => server.listen(socketPath, resolve));

test("wait-state client keeps a real socket for one transition and closes it on abort", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "bebop-wait-state-"));
	const socketPath = path.join(root, "peer.sock");
	let connections = 0;
	const server = net.createServer((connection) => {
		connections += 1;
		connection.once("close", () => {
			connections -= 1;
		});
		connection.setEncoding("utf8");
		connection.once("data", (chunk) => {
			const request = JSON.parse(String(chunk).trim()) as { id: string | number };
			connection.write(
				`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { subscriptionId: String(request.id), snapshot: snapshot(null) } })}\n`,
			);
			setTimeout(
				() =>
					connection.write(
						`${JSON.stringify(buildWaitStateNotification(String(request.id), snapshot(null)))}\n`,
					),
				5,
			);
		});
	});
	await listen(server, socketPath);
	const controller = new AbortController();
	const transition = new Promise<void>((resolve) => {
		void sendMemberWaitState(
			socketPath,
			{ type: "wait_state", member: "Mony" },
			{
				signal: controller.signal,
				onTransition: (value) => {
					assert.deepEqual(value, snapshot(null));

					resolve();
				},
			},
		).then((result) => assert.equal(result.ok, true));
	});
	await transition;
	controller.abort();
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(connections, 0);
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await rm(root, { recursive: true, force: true });
});
