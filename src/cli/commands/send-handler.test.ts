import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { runSendCommand, type SendHandlerAdapters } from "./send-handler.ts";
import { UsageError, type SendCliOptions } from "../arguments.ts";
import { ExternalIntakeError } from "../../application/external-intake.ts";
import type { CliContext } from "../context.ts";
import { renderCliResult, writeOutcome, type CliOutcome } from "../output.ts";
import { buildSendCommand, readSendLeafOptions, sendHelp } from "./send.ts";

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

test("send leaf metadata preserves defaults and explicit option values", () => {
	const command = buildSendCommand();
	command.parse(
		[
			"--crew",
			"/tmp/crew.json",
			"--message",
			"hello",
			"--instruction",
			"one",
			"--from",
			"CI",
			"--mode",
			"follow_up",
			"--wait",
			"accepted",
			"--timeout",
			"1s",
			"--format",
			"json",
			"--stdin",
			"--full",
		],
		{ from: "user" },
	);
	const explicit = readSendLeafOptions(command);
	assert.equal(explicit.crewPath, "/tmp/crew.json");
	assert.equal(explicit.origin?.label, "CI");
	assert.equal(explicit.mode, "follow_up");
	assert.equal(explicit.wait, "accepted");
	assert.equal(explicit.timeout, "1s");
	assert.equal(explicit.format, "json");
	assert.equal(explicit.stdin, true);
	assert.deepEqual(explicit.instructions, ["one"]);
	assert.equal(explicit.full, true);
	const defaults = readSendLeafOptions(buildSendCommand());
	assert.deepEqual(defaults.instructions, []);
	assert.equal(defaults.mode, "steer");
	assert.equal(defaults.wait, "turn_end");
	assert.equal(defaults.full, false);
	assert.match(sendHelp(command), /--instruction/);
});

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
	assert.match(outcome.result.error?.message ?? "", /send operation was aborted/);
	assert.match(outcome.result.error?.message ?? "", /Next:/);
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
	assert.equal(outcome.result.target, "");
	assert.equal(outcome.result.error?.code, "offline");
	assert.equal(outcome.result.error?.location?.value, undefined);
});

test("unknown send failures use unexpected-failure and hide dependency details", async () => {
	const outcome = await runSendCommand(
		sendOptions({ socketPath: "/tmp/peer.sock", message: "hello" }),
		context(),
		fakeAdapters({
			deliverDirect: async () => {
				throw new Error("dependency failed at /tmp/quarantine-123");
			},
		}),
	);
	assert.equal(outcome.kind, "result");
	if (outcome.kind !== "result") return;
	assert.equal(outcome.result.error?.code, "unexpected-failure");
	assert.equal(outcome.result.target, "");
	assert.equal(outcome.result.error?.location?.value, undefined);
	assert.equal(outcome.result.error?.message.includes("quarantine-123"), false);
	const output = new PassThrough();
	const chunks: Buffer[] = [];
	output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
	writeOutcome(output, outcome);
	assert.equal(Buffer.concat(chunks).toString().includes("peer.sock"), false);
	assert.equal(Buffer.concat(chunks).toString().includes("quarantine-123"), false);
});

test("--crew known intake failures hide raw details in text, JSON, and TOON", async () => {
	for (const format of ["text", "json", "toon"] as const) {
		const outcome = await runSendCommand(
			sendOptions({ crewPath: "/var/folders/qa/private.sock", format, socketPath: undefined }),
			context(),
			fakeAdapters({
				intake: async () => {
					throw new ExternalIntakeError("read-failed", "failed at /var/folders/qa/private.sock");
				},
			}),
		);
		assert.equal(outcome.kind, "result");
		if (outcome.kind !== "result") continue;
		const rendered = renderCliResult(outcome.result, format, false);
		assert.equal(outcome.result.error?.code, "read-failed");
		assert.equal(outcome.result.target, "");
		assert.equal(rendered.includes("private.sock"), false);
		assert.equal(rendered.includes("failed at /var"), false);
	}
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
