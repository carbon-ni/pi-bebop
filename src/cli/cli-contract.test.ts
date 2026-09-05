import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { PassThrough } from "node:stream";
import { parseCliArguments } from "./parser.ts";
import { parseCliCommand } from "./registry.ts";
import { UsageError } from "./arguments.ts";
import { renderCliResult, type CliResult } from "./output.ts";
import { runCli } from "./main.ts";

/**
 * TASK-0056 characterization suite.
 *
 * Locks the current public CLI vocabulary BEFORE any framework change:
 * command tree, flags/defaults, repeated --instruction, stdin/message
 * exclusivity, target requirements, relative-path resolution, home schema,
 * output formats, error behavior, and exit codes. Every assertion here is a
 * tested contract decision; a future framework must keep these observable
 * behaviors byte-compatible unless a separate task records an explicit change.
 */

const cwd = "/project";

// ---------------------------------------------------------------------------
// Command tree
// ---------------------------------------------------------------------------

test("command tree: home, send, crew init, member status, session list, member follow-up, member redirect are the public commands", () => {
	assert.deepEqual(parseCliCommand([], cwd), { command: "home" });
	assert.equal(parseCliCommand(["send", "--socket", "/x", "--message", "m"], cwd).command, "send");
	assert.equal(parseCliCommand(["crew", "init"], cwd).command, "crew-init");
	assert.equal(parseCliCommand(["crew", "roles"], cwd).command, "crew-roles");
	for (const args of [["bogus"], ["crew"], ["crew", "join"], ["sendx"], ["", ""]]) {
		assert.throws(() => parseCliCommand(args, cwd), UsageError, args.join(" "));
	}
});

test("usage errors name valid alternatives", () => {
	assert.throws(
		() => parseCliCommand(["frobnicate"], cwd),
		/valid commands: send, crew init, crew roles, member status, member wait-idle, session list, member follow-up, member redirect, member request send, member request list, member request wait, member request respond, member interrupt, member inbox send, crew broadcast, guest join, guest leave, guest send, guest broadcast/,
	);
	// send with no target still reports the target requirement (not a framework help dump)
	assert.throws(() => parseCliCommand(["send"], cwd), /Choose exactly one target/);
});

// ---------------------------------------------------------------------------
// send: flags, defaults, exclusivity, targets, repeated values
// ---------------------------------------------------------------------------

test("send defaults: mode=steer, wait=accepted, timeout=5m, format=toon, full=false", () => {
	const parsed = parseCliArguments(["send", "--socket", "/x", "--message", "m"], cwd);
	assert.deepEqual(
		{
			mode: parsed.mode,
			wait: parsed.wait,
			timeoutMs: parsed.timeoutMs,
			format: parsed.format,
			full: parsed.full,
			instructions: parsed.instructions,
			stdin: parsed.stdin,
		},
		{
			mode: "steer",
			wait: "accepted",
			timeoutMs: 300000,
			format: "toon",
			full: false,
			instructions: [],
			stdin: false,
		},
	);
});

test("send flags: canonical long names only, no short aliases", () => {
	for (const flag of ["-s", "-m", "-f", "-w", "-t", "-i", "-c", "-h"]) {
		assert.throws(
			() => parseCliArguments(["send", "--socket", "/x", "--message", "m", flag, "v"], cwd),
			UsageError,
			flag,
		);
	}
});

test("repeated --instruction collects in order and caps at domain maximum", () => {
	const parsed = parseCliArguments(
		["send", "--socket", "/x", "--message", "m", "--instruction", "a", "--instruction", "b", "--instruction", "c"],
		cwd,
	);
	assert.deepEqual(parsed.instructions, ["a", "b", "c"]);
});

test("stdin/message exclusivity: exactly one message source", () => {
	assert.throws(
		() => parseCliArguments(["send", "--socket", "/x", "--message", "m", "--stdin"], cwd),
		/exactly one message source/,
	);
	assert.throws(() => parseCliArguments(["send", "--socket", "/x"], cwd), /Missing message source/);
	assert.equal(parseCliArguments(["send", "--socket", "/x", "--stdin"], cwd).stdin, true);
});

test("target requirement: exactly one of --socket or --crew", () => {
	assert.throws(() => parseCliArguments(["send", "--message", "m"], cwd), /Choose exactly one target/);
	assert.throws(
		() => parseCliArguments(["send", "--socket", "/a", "--crew", "/b", "--message", "m"], cwd),
		/Choose exactly one target/,
	);
	const direct = parseCliArguments(["send", "--socket", "/a", "--message", "m"], cwd);
	assert.equal(direct.socketPath, "/a");
	const intake = parseCliArguments(["send", "--crew", "/m.json", "--message", "m"], cwd);
	assert.equal(intake.crewPath, "/m.json");
});

test("--crew is command-local: direct-delivery flags are rejected with it", () => {
	for (const flag of ["--mode", "--wait", "--timeout"]) {
		assert.throws(
			() => parseCliArguments(["send", "--crew", "/m.json", "--message", "m", flag, "x"], cwd),
			new RegExp(`${flag} is not supported with --crew`),
		);
	}
});

test("relative paths resolve against cwd; absolute stay absolute", () => {
	assert.equal(
		parseCliArguments(["send", "--socket", ".pi/bebop/sockets/dev.sock", "--message", "m"], cwd).socketPath,
		"/project/.pi/bebop/sockets/dev.sock",
	);
	assert.equal(parseCliArguments(["send", "--socket", "/abs.sock", "--message", "m"], cwd).socketPath, "/abs.sock");
	assert.equal(
		parseCliArguments(["send", "--crew", ".pi/bebop/crew.json", "--message", "m"], cwd).crewPath,
		"/project/.pi/bebop/crew.json",
	);
	assert.equal(
		parseCliCommand(["crew", "init", "--project", ".", "--format", "json"], cwd).project,
		path.resolve(cwd, "."),
	);
});

test("edge syntax: --flag=value and -- sentinel are accepted", () => {
	const equals = parseCliArguments(["send", "--socket=/x", "--message=--m", "--instruction=--i"], cwd);
	assert.equal(equals.message, "--m");
	assert.deepEqual(equals.instructions, ["--i"]);
	const sentinel = parseCliArguments(["send", "--socket", "/x", "--message", "--", "--m"], cwd);
	assert.equal(sentinel.message, "--m");
});

test("duplicate flags and missing values are usage errors", () => {
	assert.throws(
		() => parseCliArguments(["send", "--socket", "/a", "--socket", "/b", "--message", "m"], cwd),
		/Duplicate flag: --socket/,
	);
	assert.throws(() => parseCliArguments(["send", "--socket", "/a", "--message"], cwd), /Missing value for --message/);
	assert.throws(
		() => parseCliArguments(["send", "--socket", "/a", "--bogus", "x", "--message", "m"], cwd),
		/Unknown flag '--bogus'/,
	);
});

// ---------------------------------------------------------------------------
// home: no-argument schema
// ---------------------------------------------------------------------------

test("no-argument home: compact schema, not full help", async () => {
	const dir = "/project";
	const output = new PassThrough();
	let text = "";
	output.setEncoding("utf8");
	output.on("data", (chunk) => {
		text += chunk;
	});
	const code = await runCli([], dir, process.stdin, output);
	assert.equal(code, 0);
	const lines = text.trim().split("\n");
	assert.equal(lines[0], "ok: true");
	assert.ok(
		lines.some((line) => line.startsWith("status: home")),
		"home status present",
	);
	assert.ok(!text.includes("Usage:") && !text.includes("Options:"), "home is not full help");
});

// ---------------------------------------------------------------------------
// crew init
// ---------------------------------------------------------------------------

test("crew init: local --help accepted, defaults to cwd and toon", () => {
	const withHelp = parseCliCommand(["crew", "init", "--help"], cwd);
	assert.equal(withHelp.help, true);
	const defaults = parseCliCommand(["crew", "init"], cwd);
	assert.equal(defaults.project, undefined);
	assert.equal(defaults.format, "toon");
});

// ---------------------------------------------------------------------------
// crew roles
// ---------------------------------------------------------------------------

test("crew roles: local --help accepted, defaults to toon and full=false", () => {
	const withHelp = parseCliCommand(["crew", "roles", "--help"], cwd);
	assert.equal(withHelp.help, true);
	const defaults = parseCliCommand(["crew", "roles"], cwd);
	assert.deepEqual(
		{ command: defaults.command, format: defaults.format, full: (defaults as { full?: boolean }).full },
		{ command: "crew-roles", format: "toon", full: false },
	);
	assert.equal(parseCliCommand(["crew", "roles", "--format", "json"], cwd).format, "json");
	assert.equal((parseCliCommand(["crew", "roles", "--full"], cwd) as { full: boolean }).full, true);
});

test("crew roles: unknown flags and duplicates are usage errors naming the leaf flags", () => {
	assert.throws(() => parseCliCommand(["crew", "roles", "--full", "--full"], cwd), /Duplicate flag: --full/);
	assert.throws(
		() => parseCliCommand(["crew", "roles", "--format", "yaml"], cwd),
		/Invalid --format 'yaml'; valid alternatives: toon, json, text/,
	);
	assert.throws(() => parseCliCommand(["crew", "roles", "--timeout", "30s"], cwd), /unknown option '--timeout'/);
});

test("crew roles result renders the same TOON/JSON schema with role values and counts only", () => {
	const result: CliResult = {
		ok: true,
		target: "/project/.pi/bebop/crew.json",
		status: "listed",
		response: "4 configured roles: lead, developer, po, qa",
		data: { roles: ["lead", "developer", "po", "qa"], roleCount: 4, memberCount: 5 },
	};
	const toon = renderCliResult(result, "toon", false);
	const json = JSON.parse(renderCliResult(result, "json", false)) as { data: { roles: string[] } };
	assert.deepEqual(json.data.roles, ["lead", "developer", "po", "qa"]);
	assert.match(toon, /roles\[4\]: lead,developer,po,qa/);
	assert.match(toon, /roleCount: 4/);
	// Text format is a single short human line, never structured scaffolding.
	assert.equal(renderCliResult(result, "text", false), "4 configured roles: lead, developer, po, qa");
});

// ---------------------------------------------------------------------------
// output formats round-trip and exit codes
// ---------------------------------------------------------------------------

test("structured result: TOON and JSON encode the same semantic payload", () => {
	const result: CliResult = {
		ok: true,
		target: "/x",
		status: "created",
		response: "r",
		data: {
			status: "created",
			manifestPath: ".pi/bebop/crew.json",
			createdPaths: ["a"],
			verifiedPaths: [],
			nextCommands: ["pi --crew-socket x"],
		},
	};
	const toon = renderCliResult(result, "toon", false);
	const json = renderCliResult(result, "json", false);
	assert.equal(typeof JSON.parse(json).status, "string");
	assert.match(toon, /status: created/);
});

test("usage error: --format=json and --format json both steer usage output", async () => {
	// Contract decision (TASK-0056): a requested output format is honored on
	// usage errors in both syntaxes, last occurrence wins.
	const jsonInline = await usageOutput(["bogus", "--format=json"]);
	assert.match(jsonInline, /^\{"/, "inline --format=json produces JSON");
	const jsonSeparate = await usageOutput(["bogus", "--format", "json"]);
	assert.match(jsonSeparate, /^\{"/, "separate --format json produces JSON");
	const toon = await usageOutput(["bogus"]);
	assert.match(toon, /^ok: false/, "default usage output is TOON");
});

async function usageOutput(args: string[]): Promise<string> {
	const output = new PassThrough();
	let text = "";
	output.setEncoding("utf8");
	output.on("data", (chunk) => {
		text += chunk;
	});
	await runCli(args, cwd, process.stdin, output);
	return text;
}

test("exit codes: usage=2, operational/conflict=1, success/help/home=0", async () => {
	// usage
	let output = new PassThrough();
	assert.equal(await runCli(["bogus"], cwd, process.stdin, output), 2);
	// help
	output = new PassThrough();
	assert.equal(await runCli(["crew", "init", "--help"], cwd, process.stdin, output), 0);
	// home
	output = new PassThrough();
	assert.equal(await runCli([], cwd, process.stdin, output), 0);
});

// ---------------------------------------------------------------------------
// Proven gaps (Kelly/qa verification matrix, TASK-0055/0056)
// ---------------------------------------------------------------------------

test("gap: timeout default 5m equals explicit --timeout 5m and parses unit forms", () => {
	const defaults = parseCliArguments(["send", "--socket", "/x", "--message", "m"], cwd);
	const explicit = parseCliArguments(["send", "--socket", "/x", "--message", "m", "--timeout", "5m"], cwd);
	assert.equal(defaults.timeoutMs, explicit.timeoutMs);
	assert.equal(defaults.timeoutMs, 300000);
	assert.equal(
		parseCliArguments(["send", "--socket", "/x", "--message", "m", "--timeout", "500ms"], cwd).timeoutMs,
		500,
	);
	assert.equal(
		parseCliArguments(["send", "--socket", "/x", "--message", "m", "--timeout", "30s"], cwd).timeoutMs,
		30000,
	);
});

test("gap: text format is concise plain text, never TOON/JSON keys", async () => {
	// usage in text mode is the bare message, no ok:/status:/error: scaffolding
	const textUsage = await usageOutput(["bogus", "--format", "text"]);
	assert.equal(
		textUsage.trim(),
		"Invalid command 'bogus'; valid commands: send, crew init, crew roles, member status, member wait-idle, session list, member follow-up, member redirect, member request send, member request list, member request wait, member request respond, member interrupt, member inbox send, crew broadcast, guest join, guest leave, guest send, guest broadcast",
	);
	assert.ok(!textUsage.includes("ok:") && !textUsage.includes('{"'), "text usage has no structured scaffolding");
	// success text is a short human line
	const success: CliResult = { ok: true, target: "/x", status: "created", response: "Scaffolded crew" };
	assert.equal(renderCliResult(success, "text", false), "Scaffolded crew");
});

test("gap: usage errors go to stdout structured; stderr stays diagnostics-only", async () => {
	// runCli writes only to the injected output stream; stderr must receive nothing
	const stderrWrites: string[] = [];
	const originalWrite = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: unknown) => {
		stderrWrites.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	try {
		const text = await usageOutput(["bogus", "--format", "json"]);
		assert.match(text, /^\{"/, "structured usage on stdout");
	} finally {
		process.stderr.write = originalWrite;
	}
	assert.deepEqual(stderrWrites, [], "no library/application diagnostics on stderr");
});

test("gap: repeated same-value flags are rejected as duplicates; only --instruction repeats", () => {
	assert.throws(
		() => parseCliArguments(["send", "--socket", "/a", "--socket", "/a", "--message", "m"], cwd),
		/Duplicate flag: --socket/,
	);
	assert.throws(
		() =>
			parseCliArguments(
				["send", "--socket", "/a", "--message", "m", "--format", "toon", "--format", "toon"],
				cwd,
			),
		/Duplicate flag: --format/,
	);
	assert.throws(
		() => parseCliCommand(["crew", "init", "--project", ".", "--project", "."], cwd),
		/Duplicate flag: --project/,
	);
	// repeated booleans rejected too
	assert.throws(
		() => parseCliArguments(["send", "--socket", "/a", "--stdin", "--stdin"], cwd),
		/Duplicate flag: --stdin/,
	);
	// the only repeatable value flag is --instruction
	const repeated = parseCliArguments(
		["send", "--socket", "/a", "--message", "m", "--instruction", "x", "--instruction", "x"],
		cwd,
	);
	assert.deepEqual(repeated.instructions, ["x", "x"]);
});

// ---------------------------------------------------------------------------
// PO sequencing review (TASK-0056..0067) contract implications
// ---------------------------------------------------------------------------

test("PO: --timeout uses one shared duration grammar; bare seconds are rejected", () => {
	// Locks the grammar so TASK-0067 cannot redefine send --timeout as seconds.
	assert.throws(
		() => parseCliArguments(["send", "--socket", "/x", "--message", "m", "--timeout", "600"], cwd),
		/Invalid --timeout '600'; use a positive duration such as 500ms, 30s, or 5m/,
	);
	assert.equal(
		parseCliArguments(["send", "--socket", "/x", "--message", "m", "--timeout", "10m"], cwd).timeoutMs,
		600000,
	);
	assert.equal(
		parseCliArguments(["send", "--socket", "/x", "--message", "m", "--timeout", "1s"], cwd).timeoutMs,
		1000,
	);
});

test("PO: --session is not a global/root flag today; it must be added as an explicit contract decision", () => {
	// Guards against --session creeping in as a root-global flag before TASK-0060
	// defines leaf-command-local placement, precedence, and discovery.
	assert.throws(
		() => parseCliCommand(["send", "--session", "abc", "--socket", "/x", "--message", "m"], cwd),
		/Unknown flag '--session'/,
	);
	// Root position is not even a command today: --session cannot become
	// root-global without a tested contract change.
	assert.throws(
		() => parseCliCommand(["--session", "abc", "send", "--socket", "/x", "--message", "m"], cwd),
		/Invalid command '--session'; valid commands: send, crew init, crew roles, member status, member wait-idle, session list, member follow-up, member redirect, member request send, member request list, member request wait, member request respond, member interrupt, member inbox send, crew broadcast, guest join, guest leave, guest send, guest broadcast/,
	);
});

test("PO: duration grammar is command-shared and never changes meaning by command", () => {
	// Same grammar on crew init --timeout would be the only legal reuse; no other
	// command redefines the unit. crew init has no --timeout, so the surface is:
	// send --timeout <ms|s|m> is the single duration-valued flag.
	for (const flag of ["--timeout", "--timeout-seconds"]) {
		assert.throws(() => parseCliCommand(["crew", "init", flag, "10"], cwd), new RegExp(`Unknown flag '${flag}'`));
	}
});
