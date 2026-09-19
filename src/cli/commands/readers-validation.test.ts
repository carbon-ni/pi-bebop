import test from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { UsageError } from "../support/arguments.ts";
import { buildDurableMessageCommand, readDurableMessageCommand } from "./durable-message.ts";
import {
	buildGuestJoinCommand,
	buildGuestLeaveCommand,
	buildGuestMessageCommand,
	readGuestJoinCommand,
	readGuestLeaveCommand,
	readGuestMessageCommand,
} from "./guest.ts";
import { buildMemberIdleWaitCommand, readMemberIdleWaitCommand } from "./member-idle-wait.ts";
import { buildMemberMessageCommand, readMemberMessageCommand } from "./member-message.ts";
import {
	buildMemberRequestListCommand,
	buildMemberRequestRespondCommand,
	buildMemberRequestSendCommand,
	buildMemberRequestWaitCommand,
	readMemberRequestListCommand,
	readMemberRequestRespondCommand,
	readMemberRequestSendCommand,
	readMemberRequestWaitCommand,
} from "./member-request.ts";
import {
	buildCrewSessionAddCommand,
	buildCrewSessionCaptureCommand,
	buildCrewSessionListCommand,
	buildCrewSessionResolveCommand,
	buildCrewSessionShowCommand,
	readCrewSessionAddCommand,
	readCrewSessionCaptureCommand,
	readCrewSessionListCommand,
	readCrewSessionResolveCommand,
	readCrewSessionShowCommand,
} from "./crew-session.ts";
import { buildSessionListCommand, readSessionListCommand } from "./session-list.ts";
import { buildCrewRolesCommand, readCrewRolesCommand } from "./crew-roles.ts";
import { buildCrewListCommand, readCrewListCommand } from "./crew-list.ts";
import { composeRegistry } from "../registry.ts";

function parseInto(build: () => Command, tokens: readonly string[]): Command {
	const command = build()
		.exitOverride()
		.configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} });
	command.parse([...tokens], { from: "user" });
	return command;
}

function usage(predicate: () => void, pattern: RegExp): void {
	assert.throws(predicate, (error: unknown) => error instanceof UsageError && pattern.test(error.message));
}

// --- durable message (inbox / broadcast) reader + validation ---

test("durable message readers validate member, format, source exclusivity, and content bounds", () => {
	const inbox = readDurableMessageCommand(
		parseInto(() => buildDurableMessageCommand("inbox"), ["Kelly", "--message", "hi"]),
		"inbox",
	);
	assert.equal(inbox.command, "member-inbox-send");
	assert.equal(inbox.member, "Kelly");

	usage(
		() =>
			readDurableMessageCommand(
				parseInto(() => buildDurableMessageCommand("inbox"), ["--message", "hi"]),
				"inbox",
			),
		/Missing <member>/,
	);
	usage(
		() =>
			readDurableMessageCommand(
				parseInto(() => buildDurableMessageCommand("inbox"), ["  Kelly  ", "--message", "hi"]),
				"inbox",
			),
		/<member> must be trimmed/,
	);
	usage(
		() =>
			readDurableMessageCommand(
				parseInto(() => buildDurableMessageCommand("inbox"), ["Kelly"]),
				"inbox",
			),
		/Choose exactly one message source/,
	);
	usage(
		() =>
			readDurableMessageCommand(
				parseInto(() => buildDurableMessageCommand("inbox"), ["Kelly", "--message", "x", "--stdin"]),
				"inbox",
			),
		/Choose exactly one message source/,
	);
	usage(
		() =>
			readDurableMessageCommand(
				parseInto(() => buildDurableMessageCommand("broadcast"), ["--message", ""]),
				"broadcast",
			),
		/--message received empty content/,
	);
	usage(
		() =>
			readDurableMessageCommand(
				parseInto(() => buildDurableMessageCommand("broadcast"), ["--message", "a\0b"]),
				"broadcast",
			),
		/--message must not contain NUL bytes/,
	);
	usage(
		() =>
			readDurableMessageCommand(
				parseInto(() => buildDurableMessageCommand("broadcast"), ["--format", "yaml", "--message", "x"]),
				"broadcast",
			),
		/Invalid --format 'yaml'/,
	);
	usage(
		() =>
			readDurableMessageCommand(
				parseInto(() => buildDurableMessageCommand("inbox"), ["Kelly", "--instruction", " "]),
				"inbox",
			),
		/Each --instruction must be trimmed and non-empty/,
	);
	usage(
		() =>
			readDurableMessageCommand(
				parseInto(() => buildDurableMessageCommand("inbox"), ["Kelly", "--instruction", "a\0b"]),
				"inbox",
			),
		/--instruction must not contain NUL bytes/,
	);
	// broadcast has no member requirement and accepts a message.
	const broadcast = readDurableMessageCommand(
		parseInto(() => buildDurableMessageCommand("broadcast"), ["--message", "hello"]),
		"broadcast",
	);
	assert.equal(broadcast.command, "crew-broadcast");
});

// --- guest readers ---

test("guest readers require a live member socket target and non-empty routing values", () => {
	const join = readGuestJoinCommand(
		parseInto(() => buildGuestJoinCommand(), ["/tmp/s.sock", "--identity", "g", "--as", "Alex", "--callback", "c"]),
	);
	assert.equal(join.command, "guest-join");
	usage(
		() =>
			readGuestJoinCommand(
				parseInto(
					() => buildGuestJoinCommand(),
					["/tmp/s.sock", "--identity", "", "--as", "A", "--callback", "c"],
				),
			),
		/--identity <guest-identity> requires a non-empty value/,
	);
	usage(
		() =>
			readGuestMessageCommand(
				parseInto(
					() => buildGuestMessageCommand("send"),
					[
						"--crew",
						"c",
						"--target",
						"M",
						"--identity",
						"g",
						"--as",
						"A",
						"--callback",
						"x",
						"--capability",
						"k",
						"--message",
						"m",
						"--format",
						"bad",
					],
				),
				"send",
			),
		/Invalid --format 'bad'/,
	);
	const broadcast = readGuestMessageCommand(
		parseInto(
			() => buildGuestMessageCommand("broadcast"),
			["--crew", "c", "--identity", "g", "--as", "A", "--callback", "x", "--capability", "k", "--message", "m"],
		),
		"broadcast",
	);
	assert.equal(broadcast.command, "guest-broadcast");
	const leave = readGuestLeaveCommand(
		parseInto(() => buildGuestLeaveCommand(), ["/tmp/s.sock", "--crew", "c", "--identity", "g", "--callback", "x"]),
	);
	assert.equal(leave.command, "guest-leave");
});

// --- member idle wait reader ---

test("member idle wait reader validates duration, format, and member target", () => {
	const parsed = readMemberIdleWaitCommand(
		parseInto(() => buildMemberIdleWaitCommand(), ["Mary", "--timeout", "30s", "--format", "json"]),
	);
	assert.equal(parsed.timeoutSeconds, 30);
	assert.equal(parsed.format, "json");
	usage(
		() => readMemberIdleWaitCommand(parseInto(() => buildMemberIdleWaitCommand(), ["--timeout", "x"])),
		/Missing <member>/,
	);
	usage(
		() => readMemberIdleWaitCommand(parseInto(() => buildMemberIdleWaitCommand(), ["Mary", "--timeout", "500ms"])),
		/Invalid --timeout '500ms'/,
	);
	usage(
		() => readMemberIdleWaitCommand(parseInto(() => buildMemberIdleWaitCommand(), ["Mary", "--timeout", "15m"])),
		/Invalid --timeout '15m'/,
	);
	usage(
		() => readMemberIdleWaitCommand(parseInto(() => buildMemberIdleWaitCommand(), ["Mary", "--format", "xml"])),
		/Invalid --format 'xml'/,
	);
});

// --- member message reader ---

test("member message reader validates content, instructions, source exclusivity, and member", () => {
	const parsed = readMemberMessageCommand(
		parseInto(() => buildMemberMessageCommand("follow_up"), ["Kelly", "--message", "hi"]),
		"follow_up",
	);
	assert.equal(parsed.command, "member-follow-up");
	usage(
		() =>
			readMemberMessageCommand(
				parseInto(() => buildMemberMessageCommand("follow_up"), ["--message", "hi"]),
				"follow_up",
			),
		/Missing <member>/,
	);
	usage(
		() =>
			readMemberMessageCommand(
				parseInto(() => buildMemberMessageCommand("follow_up"), ["Kelly"]),
				"follow_up",
			),
		/Missing message source/,
	);
	usage(
		() =>
			readMemberMessageCommand(
				parseInto(() => buildMemberMessageCommand("follow_up"), ["Kelly", "--message", ""]),
				"follow_up",
			),
		/--message must not be empty/,
	);
	usage(
		() =>
			readMemberMessageCommand(
				parseInto(() => buildMemberMessageCommand("follow_up"), ["Kelly", "--message", "a\0b"]),
				"follow_up",
			),
		/--message must not contain NUL bytes/,
	);
	usage(
		() =>
			readMemberMessageCommand(
				parseInto(
					() => buildMemberMessageCommand("follow_up"),
					["Kelly", "--message", "x", "--instruction", "  "],
				),
				"follow_up",
			),
		/Each --instruction must be trimmed and non-empty/,
	);
});

// --- member request readers ---

test("member request readers validate durations, direction, ids, and message source", () => {
	const send = readMemberRequestSendCommand(
		parseInto(() => buildMemberRequestSendCommand(), ["Mony", "--message", "hi"]),
	);
	assert.equal(send.command, "member-request-send");
	usage(
		() => readMemberRequestSendCommand(parseInto(() => buildMemberRequestSendCommand(), ["Mony"])),
		/Missing message source/,
	);
	usage(
		() =>
			readMemberRequestSendCommand(
				parseInto(() => buildMemberRequestSendCommand(), ["Mony", "--message", "x", "--stdin"]),
			),
		/Choose exactly one message source/,
	);
	usage(
		() =>
			readMemberRequestSendCommand(
				parseInto(
					() => buildMemberRequestSendCommand(),
					["Mony", "--message", "x", "--response-grace", "500ms"],
				),
			),
		/Invalid --response-grace '500ms'/,
	);
	usage(
		() =>
			readMemberRequestSendCommand(
				parseInto(() => buildMemberRequestSendCommand(), ["Mony", "--message", "x", "--max-wait", "30s"]),
			),
		/Invalid --max-wait '30s'/,
	);
	usage(
		() =>
			readMemberRequestSendCommand(
				parseInto(
					() => buildMemberRequestSendCommand(),
					["Mony", "--message", "x", "--response-grace", "10m", "--max-wait", "5m"],
				),
			),
		/--max-wait must be strictly greater than --response-grace/,
	);
	usage(
		() =>
			readMemberRequestListCommand(parseInto(() => buildMemberRequestListCommand(), ["--direction", "sideways"])),
		/Invalid --direction/,
	);
	const list = readMemberRequestListCommand(
		parseInto(() => buildMemberRequestListCommand(), ["--direction", "outbound"]),
	);
	assert.equal(list.direction, "outbound");
	const wait = readMemberRequestWaitCommand(parseInto(() => buildMemberRequestWaitCommand(), ["req-9"]));
	assert.equal(wait.requestId, "req-9");
	usage(
		() => readMemberRequestRespondCommand(parseInto(() => buildMemberRequestRespondCommand(), ["req-1"])),
		/Missing message source/,
	);
	const respond = readMemberRequestRespondCommand(
		parseInto(() => buildMemberRequestRespondCommand(), ["req-1", "--message", "done"]),
	);
	assert.equal(respond.requestId, "req-1");
});

// --- crew session readers ---

test("crew session readers validate names, ids, formats, and counts", () => {
	const capture = readCrewSessionCaptureCommand(
		parseInto(() => buildCrewSessionCaptureCommand(), ["review", "--crew", ".pi/bebop/crew.json"]),
	);
	assert.equal(capture.name, "review");
	assert.equal(capture.crew, ".pi/bebop/crew.json");
	usage(
		() => readCrewSessionCaptureCommand(parseInto(() => buildCrewSessionCaptureCommand(), ["  "])),
		/Expected a non-empty Crew Session name/,
	);
	const list = readCrewSessionListCommand(
		parseInto(() => buildCrewSessionListCommand(), ["--limit", "5", "--offset", "2"]),
	);
	assert.equal(list.limit, 5);
	assert.equal(list.offset, 2);
	usage(
		() => readCrewSessionListCommand(parseInto(() => buildCrewSessionListCommand(), ["--limit", "-1"])),
		/Invalid --limit '-1'/,
	);
	usage(
		() => readCrewSessionListCommand(parseInto(() => buildCrewSessionListCommand(), ["--offset", "x"])),
		/Invalid --offset 'x'/,
	);
	usage(
		() => readCrewSessionListCommand(parseInto(() => buildCrewSessionListCommand(), ["--format", "xml"])),
		/Invalid --format 'xml'/,
	);
	assert.equal(
		readCrewSessionAddCommand(parseInto(() => buildCrewSessionAddCommand(), ["cs_id", "Alice"])).member,
		"Alice",
	);
	assert.equal(readCrewSessionShowCommand(parseInto(() => buildCrewSessionShowCommand(), ["cs_id"])).id, "cs_id");
	const resolved = readCrewSessionResolveCommand(
		parseInto(() => buildCrewSessionResolveCommand(), ["cs_id", "Alice"]),
	);
	assert.equal(resolved.id, "cs_id");
	assert.equal(resolved.member, "Alice");
});

// --- session live / crew roles / crew list readers ---

test("session live, crew roles, and crew list readers validate format", () => {
	assert.equal(readSessionListCommand(parseInto(buildSessionListCommand, [])).format, "toon");
	usage(
		() => readSessionListCommand(parseInto(buildSessionListCommand, ["--format", "xml"])),
		/Invalid --format 'xml'/,
	);
	assert.equal(readCrewRolesCommand(parseInto(buildCrewRolesCommand, [])).format, "toon");
	usage(() => readCrewRolesCommand(parseInto(buildCrewRolesCommand, ["--format", "xml"])), /Invalid --format 'xml'/);
	assert.equal(readCrewListCommand(parseInto(buildCrewListCommand, ["--full"])).full, true);
	usage(() => readCrewListCommand(parseInto(buildCrewListCommand, ["--format", "xml"])), /Invalid --format 'xml'/);
});

// --- registry composition ---

test("registry leafById rejects unknown leaves", () => {
	const registry = composeRegistry([]);
	assert.throws(() => registry.leafById("nope"), /Unknown command 'nope'/);
});
