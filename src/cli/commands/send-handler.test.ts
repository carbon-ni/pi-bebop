import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { runSendCommand, type SendHandlerAdapters } from "./send-handler.ts";
import { UsageError, type SendCliOptions } from "../arguments.ts";
import type { CliContext } from "../context.ts";
import type { CliOutcome } from "../output.ts";
import { sendHelp } from "./send.ts";

function sendOptions(overrides: Partial<SendCliOptions> = {}): SendCliOptions {
	return {
		command: "send",
		socketPath: "/tmp/peer.sock",
		instructions: [],
		stdin: false,
		mode: "steer",
		wait: "turn_end",
		timeoutMs: 5000,
		format: "json",
		full: false,
		...overrides,
	};
}

function context(): CliContext {
	return { cwd: "/project", input: new PassThrough(), signal: new AbortController().signal };
}

function okOutcome(status: string): CliOutcome {
	return { kind: "result", result: { ok: true, target: "/tmp/peer.sock", status }, format: "json", full: false };
}

function fakeAdapters(overrides: Partial<SendHandlerAdapters> = {}): SendHandlerAdapters {
	return {
		readStdin: async () => "stdin content",
		deliverDirect: async (options, message) => okOutcome("accepted"),
		intake: async (options, message) => okOutcome("persisted"),
		...overrides,
	};
}

test("send --help returns deterministic local help with zero IO", async () => {
	const outcome = await runSendCommand(sendOptions({ help: true }), context());
	assert.equal(outcome.kind, "help");
	if (outcome.kind !== "help") return;
	assert.equal(outcome.text, sendHelp());
});

test("empty stdin is a usage error before any delivery", async () => {
	await assert.rejects(
		runSendCommand(sendOptions({ stdin: true }), context(), fakeAdapters({ readStdin: async () => "" })),
		/empty input/,
	);
});

test("stdin read failures surface as usage errors and cancel delivery", async () => {
	const usage = new UsageError("--stdin exceeds the 8-byte message limit");
	await assert.rejects(
		runSendCommand(
			sendOptions({ stdin: true }),
			context(),
			fakeAdapters({
				readStdin: async () => {
					throw usage;
				},
			}),
		),
		/exceeds/,
	);
});

test("cancellation maps to the aborted code and never leaks a stack", async () => {
	const abortError = Object.assign(new Error("Operation aborted"), { name: "AbortError" });
	const outcome = await runSendCommand(
		sendOptions({ stdin: true }),
		context(),
		fakeAdapters({
			readStdin: async () => {
				throw abortError;
			},
		}),
	);
	assert.equal(outcome.kind, "result");
	if (outcome.kind !== "result") return;
	assert.equal(outcome.result.ok, false);
	assert.equal(outcome.result.error?.code, "aborted");
	assert.equal(outcome.result.error?.message, "Operation aborted");
});

test("operational failures map to stable codes with the delivery target", async () => {
	const outcome = await runSendCommand(
		sendOptions({ socketPath: "/offline.sock" }),
		context(),
		fakeAdapters({
			deliverDirect: async () => {
				throw Object.assign(new Error("missing"), { code: "ENOENT" });
			},
		}),
	);
	assert.equal(outcome.kind, "result");
	if (outcome.kind !== "result") return;
	assert.equal(outcome.result.ok, false);
	assert.equal(outcome.result.target, "/offline.sock");
	assert.equal(outcome.result.error?.code, "offline");
});

test("--crew routes to the durable intake adapter, never the direct RPC adapter", async () => {
	const calls: string[] = [];
	const outcome = await runSendCommand(
		sendOptions({ crewPath: "/m.json", message: "hello" }),
		context(),
		fakeAdapters({
			intake: async (options, message) => {
				calls.push("intake");
				assert.equal(options.crewPath, "/m.json");
				assert.equal(message, "hello");
				return okOutcome("persisted");
			},
			deliverDirect: async () => {
				calls.push("direct");
				throw new Error("direct must not run for --crew");
			},
		}),
	);
	assert.deepEqual(calls, ["intake"]);
	assert.equal(outcome.kind, "result");
	if (outcome.kind !== "result") return;
	assert.equal(outcome.result.status, "persisted");
});

test("--socket routes to the direct RPC adapter with the exact delivery request", async () => {
	const calls: string[] = [];
	const outcome = await runSendCommand(
		sendOptions({ socketPath: "/tmp/peer.sock", message: "hello" }),
		context(),
		fakeAdapters({
			intake: async () => {
				calls.push("intake");
				throw new Error("intake must not run for --socket");
			},
			deliverDirect: async (options, message, signal) => {
				calls.push("direct");
				assert.equal(options.socketPath, "/tmp/peer.sock");
				assert.equal(message, "hello");
				assert.equal(signal.aborted, false);
				return okOutcome("accepted");
			},
		}),
	);
	assert.deepEqual(calls, ["direct"]);
	assert.equal(outcome.kind, "result");
	if (outcome.kind !== "result") return;
	assert.equal(outcome.result.status, "accepted");
});

test("message flag bypasses stdin entirely", async () => {
	let readStdinCalled = false;
	const outcome = await runSendCommand(
		sendOptions({ message: "hello" }),
		context(),
		fakeAdapters({
			readStdin: async () => {
				readStdinCalled = true;
				return "ignored";
			},
			deliverDirect: async (options, message) => {
				assert.equal(message, "hello");
				return okOutcome("accepted");
			},
		}),
	);
	assert.equal(readStdinCalled, false);
	assert.equal(outcome.kind, "result");
});
