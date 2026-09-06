import test from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { buildSendCommand, readSendLeafOptions, readSendCommand } from "./send.ts";
import { buildMemberMessageCommand, readMemberMessageCommand } from "./member-message.ts";
import {
	buildMemberIdleWaitCommand,
	readMemberIdleWaitCommand,
	parseMemberIdleWaitCommand,
} from "./member-idle-wait.ts";
import { buildCrewInitCommand, readCrewInitCommand, readCrewInitLeafOptions } from "./crew-init.ts";
import { buildGuestMessageCommand, readGuestMessageCommand } from "./guest.ts";
import {
	buildMemberRequestSendCommand,
	buildMemberRequestListCommand,
	buildMemberRequestWaitCommand,
	buildMemberRequestRespondCommand,
	readMemberRequestSendCommand,
	readMemberRequestListCommand,
	readMemberRequestWaitCommand,
	readMemberRequestRespondCommand,
} from "./member-request.ts";
import { defaultFormatForCommand } from "../audience-policy.ts";

function parseCommand(build: () => Command, tokens: readonly string[]): Command {
	const command = build()
		.exitOverride()
		.configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} });
	command.parse([...tokens], { from: "user" });
	return command;
}

test("send reader: defaults, repeatable instruction order, origin, and stdin", () => {
	const defaults = readSendLeafOptions(parseCommand(buildSendCommand, []));
	assert.equal(defaults.format, defaultFormatForCommand("send"));
	assert.equal(defaults.instructions.length, 0);
	assert.equal(defaults.stdin, false);

	const parsed = readSendLeafOptions(
		parseCommand(buildSendCommand, [
			"--crew",
			"/tmp/crew.json",
			"--instruction",
			"first",
			"--instruction=second",
			"--from",
			"external:console",
			"--stdin",
			"--format",
			"json",
			"--full",
		]),
	);
	assert.equal(parsed.crewPath, "/tmp/crew.json");
	assert.deepEqual(parsed.instructions, ["first", "second"]);
	assert.deepEqual(parsed.origin, { kind: "external", label: "external:console" });
	assert.equal(parsed.stdin, true);
	assert.equal(parsed.format, "json");
	assert.equal(parsed.full, true);
});

test("member message reader: follow-up and redirect defaults and overrides", () => {
	const defaults = readMemberMessageCommand(
		parseCommand(() => buildMemberMessageCommand("follow_up"), ["someone", "--message", "hello"]),
		"follow_up",
	);
	assert.equal(defaults.format, defaultFormatForCommand("member-follow-up"));
	const redirect = readMemberMessageCommand(
		parseCommand(
			() => buildMemberMessageCommand("redirect"),
			["someone", "--format", "json", "--message", "hello"],
		),
		"redirect",
	);
	assert.equal(redirect.format, "json");
});

test("member idle wait reader: duration and format defaults", () => {
	const defaults = readMemberIdleWaitCommand(parseCommand(buildMemberIdleWaitCommand, ["someone"]));
	assert.equal(defaults.format, defaultFormatForCommand("member-idle-wait"));
	const explicit = readMemberIdleWaitCommand(
		parseCommand(buildMemberIdleWaitCommand, ["someone", "--format", "json"]),
	);
	assert.equal(explicit.format, "json");
	assert.equal(explicit.command, "member-idle-wait");
});

test("crew init reader: human-first text default with explicit overrides", () => {
	const defaults = readCrewInitCommand(parseCommand(buildCrewInitCommand, []));
	assert.equal(defaults.format, "text");
	const toon = readCrewInitCommand(parseCommand(buildCrewInitCommand, ["--format", "toon"]));
	assert.equal(toon.format, "toon");
	const leaf = readCrewInitLeafOptions(parseCommand(buildCrewInitCommand, ["--format=json"]));
	assert.equal(leaf.format, "json");
});

test("guest message reader: no positional socket, crew routing options only", () => {
	const defaults = readGuestMessageCommand(
		parseCommand(
			() => buildGuestMessageCommand("send"),
			[
				"--crew",
				"funzzy",
				"--identity",
				"guest-1",
				"--as",
				"Guest",
				"--callback",
				"/tmp/guest-callback.sock",
				"--capability",
				"cap-1",
				"--target",
				"Mony",
				"--message",
				"hello",
			],
		),
		"send",
	);
	assert.equal(defaults.format, defaultFormatForCommand("guest-send"));
	const broadcast = readGuestMessageCommand(
		parseCommand(
			() => buildGuestMessageCommand("broadcast"),
			[
				"--crew",
				"funzzy",
				"--identity",
				"guest-1",
				"--as",
				"Guest",
				"--callback",
				"/tmp/guest-callback.sock",
				"--capability",
				"cap-1",
				"--message",
				"hello",
				"--format",
				"text",
			],
		),
		"broadcast",
	);
	assert.equal(broadcast.format, "text");
});

test("unknown --format is rejected by readers, not silently defaulted", () => {
	assert.throws(
		() => readCrewInitCommand(parseCommand(buildCrewInitCommand, ["--format", "yaml"])),
		/Invalid --format 'yaml'/,
	);
});

test("send reader: every branch is exercised including validation errors", () => {
	const full = readSendLeafOptions(
		parseCommand(
			buildSendCommand,
			[
				"--socket",
				"/tmp/member.sock",
				"--message",
				"hello",
				"--instruction",
				"only",
				"--from",
				"external:console",
				"--format",
				"toon",
			].map(String),
		),
	);
	assert.equal(full.socketPath, "/tmp/member.sock");
	assert.equal(full.message, "hello");
	assert.equal(full.origin?.kind, "external");
	assert.equal(full.format, "toon");
	assert.throws(
		() => readSendCommand(parseCommand(buildSendCommand, ["--socket", "/tmp/s.sock", "--from", "   "]), "/project"),
		/--from must be trimmed/,
	);
	assert.throws(
		() =>
			readSendCommand(
				parseCommand(buildSendCommand, ["--socket", "/tmp/s.sock", "--message", "hello", "--format", "yaml"]),
				"/project",
			),
		/Invalid --format 'yaml'/,
	);
	// The pure leaf read does not validate; the read+validate hook does both.
	assert.equal(readSendLeafOptions(parseCommand(buildSendCommand, ["--format", "yaml"])).format, "yaml");
});

test("member idle wait reader: member target, session, timeout override", () => {
	const explicit = readMemberIdleWaitCommand(
		parseCommand(buildMemberIdleWaitCommand, ["Kelly", "--session", "s-9", "--timeout", "10s", "--format", "text"]),
	);
	assert.equal(explicit.member, "Kelly");
	assert.equal(explicit.session, "s-9");
	assert.equal(explicit.format, "text");
	assert.throws(() => readMemberIdleWaitCommand(parseCommand(buildMemberIdleWaitCommand, ["--format", "yaml"])));
});

test("crew init reader: project resolution and invalid format", () => {
	const withProject = readCrewInitCommand(parseCommand(buildCrewInitCommand, ["--project", "."]));
	assert.equal(withProject.project, "."); // reader returns the raw --project value
	assert.throws(() => readCrewInitCommand(parseCommand(buildCrewInitCommand, ["--format", "bogus"])));
});

test("member message reader: message and stdin exclusivity errors surface", () => {
	assert.throws(() =>
		readMemberMessageCommand(
			parseCommand(() => buildMemberMessageCommand("follow_up"), ["someone"]),
			"follow_up",
		),
	);
});

test("member request readers: four kinds, defaults, direction, durations, and help", () => {
	const send = readMemberRequestSendCommand(
		parseCommand(buildMemberRequestSendCommand, [
			"Mony",
			"--message",
			"status?",
			"--response-grace",
			"5s",
			"--max-wait",
			"1m",
		]),
	);
	assert.equal(send.command, "member-request-send");
	assert.equal(send.member, "Mony");
	assert.equal(send.format, defaultFormatForCommand("member-request-send"));
	assert.throws(
		() =>
			readMemberRequestSendCommand(
				parseCommand(buildMemberRequestSendCommand, [
					"Mony",
					"--message",
					"x",
					"--response-grace",
					"2m",
					"--max-wait",
					"1m",
				]),
			),
		/--max-wait must be strictly greater/,
	);
	assert.throws(
		() => readMemberRequestSendCommand(parseCommand(buildMemberRequestSendCommand, ["--message", "x"])),
		/missing required argument 'member'/,
	);
	assert.throws(
		() => readMemberRequestSendCommand(parseCommand(buildMemberRequestSendCommand, [" Mony", "--message", "x"])),
		/Missing <member>/,
	);
	assert.throws(
		() =>
			readMemberRequestSendCommand(
				parseCommand(buildMemberRequestSendCommand, ["Mony", "--direction", "sideways", "--message", "x"]),
			),
		/unknown option '--direction'/,
	);

	const list = readMemberRequestListCommand(parseCommand(buildMemberRequestListCommand, ["--direction", "inbound"]));
	assert.equal(list.command, "member-request-list");
	assert.equal((list as { direction: string }).direction, "inbound");
	assert.throws(
		() => readMemberRequestListCommand(parseCommand(buildMemberRequestListCommand, ["--direction", "sideways"])),
		/Invalid --direction/,
	);

	const wait = readMemberRequestWaitCommand(parseCommand(buildMemberRequestWaitCommand, ["req-1"]));
	assert.equal(wait.command, "member-request-wait");
	const respond = readMemberRequestRespondCommand(
		parseCommand(buildMemberRequestRespondCommand, ["req-1", "--message", "done"]),
	);
	assert.equal(respond.command, "member-request-respond");
	assert.throws(
		() => readMemberRequestWaitCommand(parseCommand(buildMemberRequestWaitCommand, [])),
		/missing required argument 'request-id'/,
	);
});

test("member request readers: wait and respond happy paths and request-id requirement", () => {
	const wait = readMemberRequestWaitCommand(parseCommand(buildMemberRequestWaitCommand, ["req-7"]));
	assert.equal(wait.command, "member-request-wait");
	const respond = readMemberRequestRespondCommand(
		parseCommand(buildMemberRequestRespondCommand, ["req-7", "--message", "done"]),
	);
	assert.equal(respond.command, "member-request-respond");
	assert.throws(
		() => readMemberRequestWaitCommand(parseCommand(buildMemberRequestWaitCommand, [])),
		/missing required argument 'request-id'/,
	);
	// The builds declare helpOption(false): --help is consumed by the adapter's
	// central help pre-scan before parsing, so the leaf reader rejects it here.
	assert.throws(
		() => readMemberRequestWaitCommand(parseCommand(buildMemberRequestWaitCommand, ["--help"])),
		/unknown option '--help'/,
	);
});

test("send reader: option-presence arms, origin validation, and semantic errors", () => {
	// socket + message combination covers the presence arms not hit by the
	// crew-only and defaults-only cases.
	const both = readSendLeafOptions(parseCommand(buildSendCommand, ["--socket", "/tmp/s.sock", "--message", "hello"]));
	assert.equal(both.socketPath, "/tmp/s.sock");
	assert.equal(both.message, "hello");
	assert.equal(both.instructions.length, 0);
	assert.equal(both.origin, undefined);

	// Valid origin labels pass; NUL/oversized/whitespace labels fail.
	const validOrigin = readSendCommand(
		parseCommand(buildSendCommand, ["--socket", "/tmp/s.sock", "--message", "m", "--from", "external:console"]),
		"/project",
	);
	assert.equal(validOrigin.origin?.label, "external:console");
	assert.throws(
		() =>
			readSendCommand(
				parseCommand(buildSendCommand, ["--socket", "/tmp/s.sock", "--message", "m", "--from", "has\0nul"]),
				"/project",
			),
		/--from must be trimmed/,
	);
	assert.throws(
		() =>
			readSendCommand(
				parseCommand(buildSendCommand, [
					"--socket",
					"/tmp/s.sock",
					"--message",
					"m",
					"--from",
					"x".repeat(300),
				]),
				"/project",
			),
		/--from must be trimmed/,
	);

	// Semantic validation arms: mode/wait/format values, empty message, both sources.
	assert.throws(
		() =>
			readSendCommand(
				parseCommand(buildSendCommand, ["--socket", "/s", "--message", "m", "--mode", "yolo"]),
				"/project",
			),
		/Invalid --mode 'yolo'/,
	);
	assert.throws(
		() =>
			readSendCommand(
				parseCommand(buildSendCommand, ["--socket", "/s", "--message", "m", "--wait", "whenever"]),
				"/project",
			),
		/Invalid --wait 'whenever'/,
	);
	assert.throws(
		() => readSendCommand(parseCommand(buildSendCommand, ["--socket", "/s", "--message", ""]), "/project"),
		/--message must not be empty/,
	);
	assert.throws(
		() =>
			readSendCommand(
				parseCommand(buildSendCommand, ["--socket", "/s", "--message", "m", "--stdin"]),
				"/project",
			),
		/Choose exactly one message source/,
	);
	assert.throws(
		() => readSendCommand(parseCommand(buildSendCommand, ["--socket", "/s"]), "/project"),
		/Missing message source/,
	);
});

test("member idle wait facade: missing value, unknown option, duplicates, help", () => {
	assert.throws(() => parseMemberIdleWaitCommand(["Bob", "--timeout"]), /Missing value for --timeout/);
	assert.throws(() => parseMemberIdleWaitCommand(["Bob", "--bogus"]), /Unknown flag '--bogus'/);
	assert.throws(
		() => parseMemberIdleWaitCommand(["Bob", "--session", "a", "--session", "b"]),
		/Duplicate flag: --session/,
	);
	const help = parseMemberIdleWaitCommand(["--help"]);
	assert.equal(help.help, true);
});
