import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createPiLauncher, sanitizePiEnvironment } from "./pi-launcher.ts";

class FakeChild extends EventEmitter {}

test("sanitizes inherited Pi session environment", () => {
	const env = sanitizePiEnvironment({
		PI_SESSION_ID: "old",
		PI_SESSION_FILE: "/old",
		PI_MODEL: "model",
		KEEP: "yes",
	});
	assert.deepEqual(env, { KEEP: "yes" });
});

test("launches exact Pi session with original cwd, inherited stdio, and no shell", async () => {
	let invocation: { command: string; args: readonly string[]; options: Record<string, unknown> } | undefined;
	const child = new FakeChild();
	const launcher = createPiLauncher(((command, args, options) => {
		invocation = { command, args, options: options as Record<string, unknown> };
		setImmediate(() => child.emit("close", 0, null));
		return child;
	}) as never);
	const result = await launcher.launch({
		sessionFile: "/sessions/exact.jsonl",
		cwd: "/original/project",
		environment: { PI_SESSION_ID: "current", PATH: "/bin" },
	});
	assert.deepEqual(result, { ok: true, exitCode: 0 });
	assert.deepEqual(invocation, {
		command: "pi",
		args: ["--session", "/sessions/exact.jsonl"],
		options: { cwd: "/original/project", env: { PATH: "/bin" }, stdio: "inherit" },
	});
});
