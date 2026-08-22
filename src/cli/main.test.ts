import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { runCli } from "./main.ts";

test("runs against a live Unix socket and waits for the assistant response", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "bebop-cli-"));
	const socketPath = path.join(dir, "member.sock");
	const server = net.createServer((socket) => {
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk;
			while (buffer.includes("\n")) {
				const [line, rest] = buffer.split(/\n(.*)/s);
				buffer = rest ?? "";
				if (!line) continue;
				const command = JSON.parse(line) as { type: string };
				if (command.type === "send") socket.write('{"type":"response","command":"send","success":true}\n');
				if (command.type === "subscribe") {
					socket.write('{"type":"response","command":"subscribe","success":true}\n');
					socket.write('{"type":"event","event":"turn_end","data":{"message":{"content":"answer"},"turnIndex":2}}\n');
				}
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	try {
		const output = new PassThrough();
		let text = "";
		output.setEncoding("utf8");
		output.on("data", (chunk) => { text += chunk; });
		const code = await runCli(["send", "--socket", socketPath, "--message", "hello", "--format", "json"], process.cwd(), process.stdin, output);
		assert.equal(code, 0);
		assert.equal(JSON.parse(text).response, "answer");
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(dir, { recursive: true, force: true });
	}
});
