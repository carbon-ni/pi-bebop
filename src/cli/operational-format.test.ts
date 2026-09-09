import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import type { RpcServer } from "../infra/rpc-server.ts";

const originalHome = process.env.HOME;
const testHome = await mkdtemp(join(tmpdir(), "pi-bebop-operational-format-"));
process.env.HOME = testHome;

const { runCli } = await import("./run.ts");
const { createRpcServer, closeRpcServer, writeResponse } = await import("../infra/rpc-server.ts");
const { getSocketPath } = await import("../infra/intray-paths.ts");

const SESSION_ID = randomUUID();
const SESSION_SOCKET = getSocketPath(SESSION_ID);
let server: RpcServer;

async function run(args: readonly string[]): Promise<{ code: number; text: string }> {
	let out = "";
	const sink = new Writable({
		write(c: unknown, _e: unknown, cb: () => void) {
			out += String(c);
			cb();
		},
	});
	const code = await runCli([...args], "/project", process.stdin, sink, process.stderr, {
		...process.env,
		PI_SESSION_ID: SESSION_ID,
	});
	return { code, text: out };
}

test.before(async () => {
	await mkdir(dirname(SESSION_SOCKET), { recursive: true });
	server = await createRpcServer(SESSION_SOCKET, (command, socket) => {
		writeResponse(socket, {
			type: "response",
			command: command.type,
			success: false,
			error: "unknown-member",
			id: command.id,
		});
	});
});

test.after(async () => {
	await closeRpcServer(server);
	await rm(testHome, { recursive: true, force: true });
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
});

const CASES: ReadonlyArray<{ name: string; args: readonly string[]; code: string }> = [
	{ name: "member status", args: ["member", "status", "someone"], code: "unknown-member" },
	{ name: "member follow-up", args: ["member", "follow-up", "someone", "--message", "hi"], code: "unknown-member" },
	{
		name: "member interrupt",
		args: ["member", "interrupt", "someone", "--message", "recover"],
		code: "unknown-member",
	},
];

test("operational failures render in the selected format with stable codes", async () => {
	for (const scenario of CASES) {
		for (const [format, probe] of [
			["toon", /ok: false/],
			["json", /\{"ok":false/],
			["text", /failed: /],
		] as const) {
			const { code, text } = await run([...scenario.args, "--format", format]);
			assert.equal(code, 1, `${scenario.name} --format ${format} :: ${text.slice(0, 60)}`);
			assert.match(text, probe, `${scenario.name} --format ${format}`);
		}
	}
});

test("operational failures keep semantic parity across formats", async () => {
	for (const scenario of CASES) {
		const toon = await run([...scenario.args, "--format", "toon"]);
		const json = await run([...scenario.args, "--format", "json"]);
		const text = await run([...scenario.args, "--format", "text"]);
		assert.match(toon.text, new RegExp(`code: ["']?${scenario.code}`), scenario.name);
		assert.match(json.text, new RegExp(`"code":"${scenario.code}"`), scenario.name);
		assert.match(text.text, new RegExp(scenario.code), scenario.name);
	}
});

test("invalid --session degrades to the operational unknown-session outcome in every format", async () => {
	for (const format of ["toon", "json", "text"]) {
		const { code, text } = await run(["member", "status", "someone", "--session", "bad;id", "--format", format]);
		assert.equal(code, 1, format);
		assert.match(text, new RegExp(format === "json" ? '"code":"unknown-session"' : "unknown-session"));
		if (format === "json") assert.match(text, /^\{/);
	}
});
