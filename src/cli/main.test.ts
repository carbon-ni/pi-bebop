import test from "node:test";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import net from "node:net";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { errorCode, runCli } from "./main.ts";

const execFile = promisify(execFileCallback);
const root = path.resolve(".");

async function withEndpoint(handler: (command: Record<string, unknown>, socket: net.Socket, messages: Record<string, unknown>[]) => void, run: (socketPath: string, messages: Record<string, unknown>[]) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(path.join(tmpdir(), "bebop-cli-endpoint-"));
	const socketPath = path.join(dir, "member.sock");
	const messages: Record<string, unknown>[] = [];
	const server = net.createServer((socket) => {
					socket.setEncoding("utf8"); let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk;
			let index = buffer.indexOf("\n");
			while (index !== -1) { const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1); index = buffer.indexOf("\n"); if (line) { const command = JSON.parse(line) as Record<string, unknown>; messages.push(command); handler(command, socket, messages); } }

		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	try { await run(socketPath, messages); } finally { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
}

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

test("renders stdin read failures in the selected structured format", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	let text = "";
	output.setEncoding("utf8");
	output.on("data", (chunk) => { text += chunk; });
	const pending = runCli(["send", "--socket", "/offline.sock", "--stdin", "--format", "json"], process.cwd(), input, output);
	input.emit("error", Object.assign(new Error("stdin closed"), { code: "EIO" }));
	assert.equal(await pending, 1);
	assert.deepEqual(JSON.parse(text), { ok: false, target: "/offline.sock", status: "error", error: { code: "offline", message: "stdin closed" } });
});

test("rejects empty stdin before connecting", async () => {
	const input = new PassThrough(); input.end();
	const output = new PassThrough(); let text = "";
	output.setEncoding("utf8"); output.on("data", (chunk) => { text += chunk; });
	const code = await runCli(["send", "--socket", "/offline.sock", "--stdin", "--format", "json"], process.cwd(), input, output);
	assert.equal(code, 2);
	assert.equal(JSON.parse(text).error.code, "usage");
});

test("runs the built CLI artifact under plain Node", async () => {
	const artifact = path.resolve("dist/cli/main.js");
	const child = spawn(process.execPath, [artifact, "send", "--socket", "/x", "--message", "a", "--wait", "later"], { stdio: ["ignore", "pipe", "pipe"] });
	let stdout = ""; child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk) => { stdout += chunk; });
	const code = await new Promise<number>((resolve) => child.once("exit", (value) => resolve(value ?? 1)));
	assert.equal(code, 2);
	assert.match(stdout, /Invalid --wait/);
});

test("aborts a held-open stdin read on SIGINT and exits cleanly", async () => {
	const script = path.resolve("dist/cli/main.js");
	const child = spawn(process.execPath, [script, "send", "--socket", "/offline.sock", "--stdin", "--format", "json"], { stdio: ["pipe", "pipe", "pipe"] });
	let stdout = "";
	child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk) => { stdout += chunk; });
	await new Promise((resolve) => setTimeout(resolve, 300));
	child.kill("SIGINT");
	const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
	assert.equal(exit.code, 1);
	assert.equal(exit.signal, null);
	assert.equal(JSON.parse(stdout).error.code, "aborted");
});

test("uses injected output for selected-format usage errors", async () => {
	const output = new PassThrough(); let text = "";
	output.setEncoding("utf8"); output.on("data", (chunk) => { text += chunk; });
	const code = await runCli(["send", "--socket", "/x", "--message", "a", "--format", "json", "--wait", "later"], process.cwd(), process.stdin, output);
	assert.equal(code, 2);
	assert.equal(JSON.parse(text).error.code, "usage");
});

test("covers accepted, rejection, timeout, exact multiline stdin, and no sender metadata", async () => {
	await withEndpoint((command, socket) => {
		if (command.type === "send") socket.write('{"type":"response","command":"send","success":true,"data":{"delivered":true}}\n');
	}, async (socketPath, messages) => {
		const input = new PassThrough(); input.end("line one\nline two\n"); const output = new PassThrough(); let text = ""; output.setEncoding("utf8"); output.on("data", (chunk) => { text += chunk; });
		assert.equal(await runCli(["send", "--socket", socketPath, "--stdin", "--wait", "accepted", "--format", "json"], root, input, output), 0);
		assert.equal(JSON.parse(text).status, "accepted");
		assert.equal(messages[0]?.message, "line one\nline two\n"); assert.equal((messages[0]?.message as string).includes("sender_info"), false);
	});
	await withEndpoint((command, socket) => { if (command.type === "send") socket.write('{"type":"response","command":"send","success":false,"error":"busy"}\n'); }, async (socketPath) => {
		const output = new PassThrough(); let text = ""; output.setEncoding("utf8"); output.on("data", (chunk) => { text += chunk; });
		assert.equal(await runCli(["send", "--socket", socketPath, "--message", "x", "--wait", "accepted", "--format", "json"], root, process.stdin, output), 1); assert.equal(JSON.parse(text).ok, false);
	});
	await withEndpoint(() => undefined, async (socketPath) => {
		const output = new PassThrough(); let text = ""; output.setEncoding("utf8"); output.on("data", (chunk) => { text += chunk; });
		assert.equal(await runCli(["send", "--socket", socketPath, "--message", "x", "--wait", "accepted", "--timeout", "20ms", "--format", "json"], root, process.stdin, output), 1); assert.equal(JSON.parse(text).error.code, "timeout");
	});
});

test("packs and loads the extension entrypoint alongside the plain-Node CLI", async () => {
	const dir = await mkdtemp(path.join(root, ".tmp", "bebop-pack-"));
	try {
		await mkdir(dir, { recursive: true });
		const packed = await execFile("npm", ["pack", "--pack-destination", dir], { cwd: root });
		const archive = packed.stdout.trim().split("\n").find((line) => line.endsWith(".tgz"))!;
		const extract = path.join(dir, "package"); await mkdir(extract);
		await execFile("tar", ["-xzf", path.join(dir, archive), "-C", extract, "--strip-components=1"]);
		assert.equal((await readFile(path.join(extract, "index.ts"))).includes("src/extension.ts"), true);
		assert.equal((await readFile(path.join(extract, "src/extension.ts"))).includes("registerMemberTool"), true);
		assert.equal((await readFile(path.join(extract, "dist/cli/main.js"))).includes("function runCli"), true);
		await execFile(process.execPath, ["--import", "tsx", "-e", "import(process.argv[1])", path.join(extract, "index.ts")], { cwd: root });
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("reports real Unix socket directory permission denial", { skip: process.platform === "win32" || process.getuid?.() === 0 ? "Unix permission fixture unsupported for Windows/root" : false }, async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "bebop-permission-"));
	try {
		await chmod(dir, 0o000);
		const output = new PassThrough(); let text = "";
		output.setEncoding("utf8"); output.on("data", (chunk) => { text += chunk; });
		const code = await runCli(["send", "--socket", path.join(dir, "member.sock"), "--message", "x", "--format", "json", "--wait", "accepted", "--timeout", "100ms"], process.cwd(), process.stdin, output);
		assert.equal(code, 1);
		assert.equal(JSON.parse(text).error.code, "permission-denied");
	} finally {
		await chmod(dir, 0o700); await rm(dir, { recursive: true, force: true });
	}
});

test("distinguishes permission denial from an offline endpoint", () => {
	assert.equal(errorCode(Object.assign(new Error("denied"), { code: "EACCES" })), "permission-denied");
	assert.equal(errorCode(Object.assign(new Error("missing"), { code: "ENOENT" })), "offline");
});
