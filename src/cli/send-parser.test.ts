import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseSendCommand } from "./parser.ts";
import { UsageError } from "./arguments.ts";
import { MAX_MESSAGE_INSTRUCTIONS } from "../domain/index.ts";

/**
 * TASK-0058 facade tests: the Commander-backed declarative send parser.
 * The existing arguments.test.ts + cli-contract.test.ts suites lock the public
 * contract through parseCliArguments/parseCliCommand; these tests exercise the
 * facade directly with injected argv and assert the same byte-compatible
 * UsageError messages plus zero ambient IO and validation-before-IO.
 */

const cwd = "/project";

test("send defaults: direct target, steer, accepted, 5m, toon, no instructions", () => {
	assert.deepEqual(parseSendCommand(["--socket", "/x", "--message", "hello"], cwd), {
		command: "send",
		socketPath: "/x",
		message: "hello",
		instructions: [],
		stdin: false,
		mode: "steer",
		wait: "accepted",
		timeoutMs: 300000,
		format: "toon",
		full: false,
	});
});

test("send resolves relative paths and parses enums, duration, format, full", () => {
	const parsed = parseSendCommand(
		[
			"--socket",
			".pi/bebop/sockets/dev.sock",
			"--message",
			"m",
			"--mode",
			"follow_up",
			"--wait",
			"accepted",
			"--timeout",
			"30s",
			"--format",
			"json",
			"--full",
		],
		cwd,
	);
	assert.equal(parsed.socketPath, "/project/.pi/bebop/sockets/dev.sock");
	assert.equal(parsed.mode, "follow_up");
	assert.equal(parsed.wait, "accepted");
	assert.equal(parsed.timeoutMs, 30000);
	assert.equal(parsed.format, "json");
	assert.equal(parsed.full, true);
});

test("send crew target: durable intake with manifest resolution and no live flags", () => {
	assert.deepEqual(parseSendCommand(["--crew", ".pi/bebop/crew.json", "--message", "m"], cwd), {
		command: "send",
		crewPath: "/project/.pi/bebop/crew.json",
		message: "m",
		instructions: [],
		stdin: false,
		mode: "steer",
		wait: "accepted",
		timeoutMs: 300000,
		format: "toon",
		full: false,
	});
});

test("send collects repeated --instruction in order and enforces the cap", () => {
	const parsed = parseSendCommand(
		["--socket", "/x", "--message", "m", "--instruction", "a", "--instruction", "b", "--instruction=--c"],
		cwd,
	);
	assert.deepEqual(parsed.instructions, ["a", "b", "--c"]);
	assert.throws(
		() =>
			parseSendCommand(
				[
					"--socket",
					"/x",
					"--message",
					"m",
					...Array.from({ length: MAX_MESSAGE_INSTRUCTIONS + 1 }, () => "--instruction").flatMap((f) => [
						f,
						"i",
					]),
				],
				cwd,
			),
		/Too many --instruction values/,
	);
});

test("send --from validates origin: trimmed, non-empty, byte-limited, no NUL", () => {
	assert.deepEqual(parseSendCommand(["--socket", "/x", "--message", "m", "--from", "CI"], cwd).origin, {
		kind: "external",
		label: "CI",
	});
	for (const bad of ["  ", "", " has space ", "a\u0000b"]) {
		assert.throws(
			() => parseSendCommand(["--socket", "/x", "--message", "m", "--from", bad], cwd),
			/--from must be trimmed, non-empty, within the UTF-8 byte limit, and must not contain NUL/,
			JSON.stringify(bad),
		);
	}
});

test("send rejects invalid mode, wait, format, and duration values", () => {
	assert.throws(
		() => parseSendCommand(["--socket", "/x", "--message", "m", "--mode", "steer2"], cwd),
		/Invalid --mode 'steer2'; valid alternatives: steer, follow_up/,
	);
	assert.throws(
		() => parseSendCommand(["--socket", "/x", "--message", "m", "--wait", "later"], cwd),
		/Invalid --wait 'later'; valid alternatives: turn_end, accepted/,
	);
	assert.throws(
		() => parseSendCommand(["--socket", "/x", "--message", "m", "--format", "yaml"], cwd),
		/Invalid --format 'yaml'; valid alternatives: toon, json, text/,
	);
	assert.throws(
		() => parseSendCommand(["--socket", "/x", "--message", "m", "--timeout", "600"], cwd),
		/Invalid --timeout '600'; use a positive duration such as 500ms, 30s, or 5m/,
	);
	assert.throws(
		() => parseSendCommand(["--socket", "/x", "--message", "m", "--timeout", "0s"], cwd),
		/Invalid --timeout '0s'/,
	);
});

test("send supports --flag=value and the -- sentinel escape", () => {
	const equals = parseSendCommand(["--socket=/x", "--message=--m", "--instruction=--i", "--from=--ci"], cwd);
	assert.equal(equals.message, "--m");
	assert.deepEqual(equals.instructions, ["--i"]);
	assert.deepEqual(equals.origin, { kind: "external", label: "--ci" });
	const sentinel = parseSendCommand(["--socket", "/x", "--message", "--", "--content"], cwd);
	assert.equal(sentinel.message, "--content");
	const sentinelInstruction = parseSendCommand(
		["--socket", "/x", "--message", "m", "--instruction", "--", "--focus"],
		cwd,
	);
	assert.deepEqual(sentinelInstruction.instructions, ["--focus"]);
});

test("send rejects duplicate flags including booleans, but allows repeated --instruction", () => {
	for (const [args, flag] of [
		[["--socket", "/a", "--socket", "/b"], "--socket"],
		[["--socket", "/a", "--message", "m", "--format", "toon", "--format", "json"], "--format"],
		[["--socket", "/a", "--stdin", "--stdin"], "--stdin"],
		[["--socket", "/a", "--message", "m", "--full", "--full"], "--full"],
		[["--socket", "/a", "--message", "m", "--mode", "steer", "--mode", "follow_up"], "--mode"],
		[["--socket", "/a", "--message", "m", "--from", "a", "--from", "b"], "--from"],
	] as const) {
		assert.throws(
			() => parseSendCommand(args as string[], cwd),
			new RegExp(`Duplicate flag: ${flag}`),
			args.join(" "),
		);
	}
});

test("send rejects unknown flags and missing values with exact legacy messages", () => {
	assert.throws(
		() => parseSendCommand(["--socket", "/x", "--bogus", "--message", "m"], cwd),
		/Unknown flag '--bogus'; valid flags: --socket, --message, --stdin, --instruction, --from, --mode, --wait, --timeout, --format, --full/,
	);
	assert.throws(() => parseSendCommand(["--socket", "/x", "--message"], cwd), /Missing value for --message/);
	assert.throws(() => parseSendCommand(["--socket", "/x", "--timeout"], cwd), /Missing value for --timeout/);
	assert.throws(() => parseSendCommand(["--socket", "/x", "extra", "--message", "m"], cwd), /Unknown flag 'extra'/);
});

test("send enforces exactly one target and exactly one message source", () => {
	assert.throws(
		() => parseSendCommand(["--message", "m"], cwd),
		/Choose exactly one target: --socket <path> for direct delivery or --crew <manifest> for durable intake/,
	);
	assert.throws(
		() => parseSendCommand(["--socket", "/a", "--crew", "/b", "--message", "m"], cwd),
		/Choose exactly one target/,
	);
	assert.throws(
		() => parseSendCommand(["--socket", "/a", "--message", "m", "--stdin"], cwd),
		/Choose exactly one message source: --message <text> or --stdin/,
	);
	assert.throws(
		() => parseSendCommand(["--socket", "/a"], cwd),
		/Missing message source; use --message <text> or --stdin/,
	);
	assert.throws(() => parseSendCommand(["--socket", "/a", "--message", ""], cwd), /--message must not be empty/);
});

test("send rejects live-delivery flags with --crew", () => {
	for (const [flag, value] of [
		["--mode", "follow_up"],
		["--wait", "accepted"],
		["--timeout", "30s"],
	]) {
		assert.throws(
			() => parseSendCommand(["--crew", "/m.json", "--message", "m", flag, value], cwd),
			new RegExp(`${flag} is not supported with --crew; external intake is one-way persisted delivery`),
		);
	}
});

test("send --help is additive: returns help marker with zero IO", () => {
	const parsed = parseSendCommand(["--socket", "/x", "--message", "m", "--help"], cwd);
	assert.equal(parsed.help, true);
	assert.equal(parsed.socketPath, "/x");
});

test("send parse performs zero ambient stdout/stderr writes", () => {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const originalOut = process.stdout.write.bind(process.stdout);
	const originalErr = process.stderr.write.bind(process.stderr);
	process.stdout.write = ((chunk: unknown) => {
		stdout.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: unknown) => {
		stderr.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	try {
		parseSendCommand(["--socket", "/x", "--message", "m"], cwd);
		assert.throws(() => parseSendCommand(["--socket", "/x", "--bogus", "--message", "m"], cwd), UsageError);
	} finally {
		process.stdout.write = originalOut;
		process.stderr.write = originalErr;
	}
	assert.deepEqual(stdout, [], "no ambient stdout writes");
	assert.deepEqual(stderr, [], "no ambient stderr writes");
});

test("send validation happens before any filesystem access", async () => {
	const { mkdtemp, readdir, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = await mkdtemp(join(tmpdir(), "bebop-send-"));
	try {
		assert.throws(() => parseSendCommand(["--socket", "/x", "--bogus", "--message", "m"], dir), UsageError);
		assert.throws(() => parseSendCommand(["--crew", "/m.json"], dir), UsageError);
		assert.deepEqual(await readdir(dir), [], "usage errors must not touch the filesystem");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("send rejects short aliases including -h; only --help is recognized", () => {
	for (const flag of ["-s", "-m", "-f", "-w", "-t", "-i", "-c", "-h"]) {
		assert.throws(() => parseSendCommand(["--socket", "/x", "--message", "m", flag, "v"], cwd), UsageError, flag);
	}
	assert.equal(parseSendCommand(["--socket", "/x", "--message", "m", "--help"], cwd).help, true);
});

test("bare send --help succeeds without target or message (zero validation)", () => {
	const parsed = parseSendCommand(["--help"], cwd);
	assert.equal(parsed.help, true);
	assert.equal(parsed.socketPath, undefined);
	assert.equal(parsed.crewPath, undefined);
});
