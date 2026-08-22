import test from "node:test";
import assert from "node:assert/strict";
import { parseCliArguments, UsageError } from "./arguments.ts";

const cwd = "/project";

test("parses direct send defaults and resolves a relative socket", () => {
	assert.deepEqual(parseCliArguments(["send", "--socket", ".pi/bebop/sockets/dev.sock", "--message", "hello"], cwd), {
		command: "send", socketPath: "/project/.pi/bebop/sockets/dev.sock", message: "hello", stdin: false,
		mode: "steer", wait: "turn_end", timeoutMs: 300000, format: "toon", full: false,
	});
});

test("parses stdin, enum, duration, format, and full options", () => {
	const parsed = parseCliArguments(["send", "--socket", "/tmp/dev.sock", "--stdin", "--mode", "follow_up", "--wait", "accepted", "--timeout", "1500ms", "--format", "json", "--full"], cwd);
	assert.equal(parsed.stdin, true);
	assert.equal(parsed.timeoutMs, 1500);
	assert.equal(parsed.format, "json");
	assert.equal(parsed.full, true);
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
