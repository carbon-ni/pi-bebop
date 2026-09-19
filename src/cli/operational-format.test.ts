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

interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

async function run(args: readonly string[]): Promise<RunResult> {
	let out = "";
	let err = "";
	const outSink = new Writable({
		write(c: unknown, _e: unknown, cb: () => void) {
			out += String(c);
			cb();
		},
	});
	const errSink = new Writable({
		write(c: unknown, _e: unknown, cb: () => void) {
			err += String(c);
			cb();
		},
	});
	const code = await runCli([...args], "/project", process.stdin, outSink, errSink, {
		...process.env,
		PI_SESSION_ID: SESSION_ID,
	});
	return { code, stdout: out, stderr: err };
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

test("operational failures are plain text on stderr with exit 1 and an empty stdout", async () => {
	for (const scenario of CASES) {
		const { code, stdout, stderr } = await run(scenario.args);
		assert.equal(code, 1, scenario.name);
		assert.equal(stdout, "", scenario.name);
		assert.match(stderr, new RegExp(scenario.code), scenario.name);
		assert.doesNotMatch(stderr, /^[\[{]/, scenario.name);
	}
});

test("operational failures are identical regardless of --format", async () => {
	for (const scenario of CASES) {
		const toon = await run([...scenario.args, "--format", "toon"]);
		const json = await run([...scenario.args, "--format", "json"]);
		const text = await run([...scenario.args, "--format", "text"]);
		assert.equal(toon.stderr, json.stderr, scenario.name);
		assert.equal(json.stderr, text.stderr, scenario.name);
		assert.match(text.stderr, new RegExp(scenario.code), scenario.name);
	}
});

test("an unresolvable source session degrades to the operational unknown-session outcome", async () => {
	const { code, stdout, stderr } = await run(["member", "status", "someone", "--session", "does-not-exist"]);
	assert.equal(code, 1);
	assert.equal(stdout, "");
	assert.match(stderr, /unknown-session/);
});
