import test from "node:test";
import assert from "node:assert/strict";
import { parseCliArguments, UsageError } from "./arguments.ts";

const cwd = "/project";

test("parses direct send defaults and resolves a relative socket", () => {
	assert.deepEqual(parseCliArguments(["send", "--socket", ".pi/bebop/sockets/dev.sock", "--message", "hello"], cwd), {
		command: "send",
		socketPath: "/project/.pi/bebop/sockets/dev.sock",
		message: "hello",
		instructions: [],
		stdin: false,
		mode: "steer",
		wait: "turn_end",
		timeoutMs: 300000,
		format: "toon",
		full: false,
	});
});

test("preserves ordered instructions and claimed external origin", () => {
	const parsed = parseCliArguments(
		[
			"send",
			"--socket",
			"/tmp/dev.sock",
			"--message",
			"hello",
			"--instruction",
			"first",
			"--instruction",
			"second",
			"--from",
			"CI",
		],
		cwd,
	);
	assert.deepEqual(parsed.instructions, ["first", "second"]);
	assert.deepEqual(parsed.origin, { kind: "external", label: "CI" });
});

test("accepts equals and sentinel syntax for values beginning with option prefixes", () => {
	const inline = parseCliArguments(
		["send", "--socket", "/tmp/x", "--message=--content", "--instruction=--focus", "--from=--ci"],
		cwd,
	);
	assert.equal(inline.message, "--content");
	assert.deepEqual(inline.instructions, ["--focus"]);
	assert.deepEqual(inline.origin, { kind: "external", label: "--ci" });
	const sentinel = parseCliArguments(["send", "--socket", "/tmp/x", "--message", "--", "--content"], cwd);
	assert.equal(sentinel.message, "--content");
});

test("resolves both supported direct endpoint layouts", () => {
	assert.equal(
		parseCliArguments(["send", "--socket", ".pi/bebop/sockets/dev.sock", "--message", "x"], cwd).socketPath,
		"/project/.pi/bebop/sockets/dev.sock",
	);
	assert.equal(
		parseCliArguments(["send", "--socket", ".pi/crew/sockets/dev.sock", "--message", "x"], cwd).socketPath,
		"/project/.pi/crew/sockets/dev.sock",
	);
});

test("parses stdin, enum, duration, format, and full options", () => {
	const parsed = parseCliArguments(
		[
			"send",
			"--socket",
			"/tmp/dev.sock",
			"--stdin",
			"--mode",
			"follow_up",
			"--wait",
			"accepted",
			"--timeout",
			"1500ms",
			"--format",
			"json",
			"--full",
		],
		cwd,
	);
	assert.equal(parsed.stdin, true);
	assert.equal(parsed.timeoutMs, 1500);
	assert.equal(parsed.format, "json");
	assert.equal(parsed.full, true);
});

test("rejects missing, repeated-over-limit, whitespace, and oversized context values", () => {
	assert.throws(
		() => parseCliArguments(["send", "--socket", "/tmp/x", "--message", "x", "--instruction"]),
		/Missing value/,
	);
	assert.throws(
		() => parseCliArguments(["send", "--socket", "/tmp/x", "--message", "x", "--from", " CI"]),
		/trimmed/,
	);
	assert.throws(
		() => parseCliArguments(["send", "--socket", "/tmp/x", "--message", "x", "--from", "x".repeat(257)]),
		/UTF-8/,
	);
	assert.throws(
		() =>
			parseCliArguments([
				"send",
				"--socket",
				"/tmp/x",
				"--message",
				"x",
				...Array.from({ length: 33 }, () => ["--instruction", "x"]).flat(),
			]),
		/Too many/,
	);
});

test("rejects missing, conflicting, invalid, duplicate, and unknown inputs", () => {
	const invalid = [
		["send", "--message", "x"],
		["send", "--socket", "/x", "--message", "x", "--stdin"],
		["send", "--socket", "/x"],
		["send", "--socket", "/x", "--message", ""],
		["send", "--socket", "/x", "--message", "x", "--wait", "later"],
		["send", "--socket", "/x", "--message", "x", "--timeout", "forever"],
		["send", "--socket", "/x", "--message", "x", "--wat"],
		["send", "--socket", "/x", "--socket", "/y", "--message", "x"],
		["other", "--socket", "/x", "--message", "x"],
	];
	for (const args of invalid) assert.throws(() => parseCliArguments(args, cwd), UsageError, args.join(" "));
});

test("requires exactly one of --socket or --crew with self-correcting usage", () => {
	assert.throws(
		() => parseCliArguments(["send", "--message", "hello"], cwd),
		(error: unknown) => error instanceof UsageError && /exactly one target.*--socket.*--crew/.test(error.message),
	);
	assert.throws(
		() =>
			parseCliArguments(
				["send", "--socket", "/tmp/a.sock", "--crew", ".pi/bebop/crew.json", "--message", "hello"],
				cwd,
			),
		(error: unknown) => error instanceof UsageError && /exactly one target.*--socket.*--crew/.test(error.message),
	);
});

test("parses a crew intake target and resolves the manifest path", () => {
	const parsed = parseCliArguments(
		["send", "--crew", ".pi/bebop/crew.json", "--message", "evaluate", "--from", "jira-automation"],
		cwd,
	);
	assert.equal(parsed.crewPath, "/project/.pi/bebop/crew.json");
	assert.equal(parsed.socketPath, undefined);
	assert.deepEqual(parsed.origin, { kind: "external", label: "jira-automation" });
	assert.equal(parsed.message, "evaluate");
});

test("rejects live-delivery flags with --crew and keeps --socket surface intact", () => {
	const incompatible: Array<[string, string]> = [
		["--mode", "follow_up"],
		["--wait", "accepted"],
		["--timeout", "30s"],
	];
	for (const [flag, value] of incompatible) {
		const args = ["send", "--crew", ".pi/bebop/crew.json", "--message", "x", flag, value];
		assert.throws(
			() => parseCliArguments(args, cwd),
			(error: unknown) => error instanceof UsageError && /not supported with --crew/.test(error.message),
			`expected usage error for ${flag}`,
		);
	}
	const direct = parseCliArguments(["send", "--socket", "/tmp/a.sock", "--message", "x", "--wait", "accepted"], cwd);
	assert.equal(direct.socketPath, "/tmp/a.sock");
	assert.equal(direct.crewPath, undefined);
	assert.equal(direct.wait, "accepted");
});
