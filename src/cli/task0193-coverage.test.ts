import assert from "node:assert/strict";
import test from "node:test";
import { parseDurableMessageCommand } from "./commands/durable-message.ts";
import { parseGuestJoinCommand, parseGuestLeaveCommand, parseGuestMessageCommand } from "./commands/guest.ts";
import { parseMemberIdleWaitCommand } from "./commands/member-idle-wait.ts";
import { parseMemberInterruptCommand } from "./commands/member-interrupt.ts";
import { parseMemberMessageCommand } from "./commands/member-message.ts";
import {
	parseMemberRequestRespondCommand,
	parseMemberRequestSendCommand,
	parseMemberRequestWaitCommand,
} from "./commands/member-request.ts";
import { parseMemberStatusCommand } from "./commands/member-status.ts";
import { parseSessionListCommand } from "./commands/session-list.ts";
import { parseCrewRolesCommand } from "./commands/crew-roles.ts";

const message = ["--message", "hello"] as const;

test("TASK-0193 CLI parser seams cover request source and help branches", () => {
	assert.equal(
		parseMemberRequestSendCommand(["Bob", ...message, "--session", "source", "--format", "json"]).format,
		"json",
	);
	assert.equal(parseMemberRequestSendCommand(["Bob", "--stdin"]).stdin, true);
	assert.equal(parseMemberRequestRespondCommand(["request-1", ...message]).requestId, "request-1");
	assert.equal(parseMemberRequestWaitCommand(["--help"]).help, true);
	assert.equal(parseMemberRequestRespondCommand(["--help"]).help, true);
	assert.throws(() => parseMemberRequestRespondCommand(["request-1"]), /Missing message source/);
	assert.throws(
		() => parseMemberRequestRespondCommand(["request-1", "--message", "hello", "--stdin"]),
		/Choose exactly one message source/,
	);
});

test("TASK-0193 parser seams cover member command Commander error mappings", () => {
	assert.equal(parseMemberMessageCommand(["Bob", ...message, "--format", "json"], "follow_up").format, "json");
	assert.throws(() => parseMemberMessageCommand(["Bob", ...message, "extra"], "follow_up"), /Too many arguments/);
	assert.throws(() => parseMemberStatusCommand(["Bob", "--bogus"]), /Unknown flag/);
	assert.throws(() => parseMemberStatusCommand(["Bob", "--format"]), /Missing value/);
	assert.equal(parseMemberStatusCommand(["--help"]).help, true);
	assert.throws(() => parseMemberIdleWaitCommand(["Bob", "--bogus"]), /Unknown flag/);
	assert.throws(() => parseMemberIdleWaitCommand(["Bob", "--timeout"]), /Missing value/);
	assert.equal(parseMemberIdleWaitCommand(["--help"]).help, true);
	assert.equal(parseMemberInterruptCommand(["--help"]).help, true);
});

test("TASK-0193 parser seams cover durable and guest validation branches", () => {
	assert.equal(parseDurableMessageCommand(["--help"], "broadcast").help, true);
	assert.equal(parseDurableMessageCommand(["--help"], "inbox").help, true);
	assert.equal(parseDurableMessageCommand(["Bob", ...message], "inbox").member, "Bob");
	assert.throws(() => parseDurableMessageCommand(["--bogus"], "broadcast"), /Unknown flag/);
	assert.throws(() => parseDurableMessageCommand(["--message", ""], "broadcast"), /empty content/);
	assert.throws(() => parseDurableMessageCommand(["Bob", "--message", "x", "--stdin"], "inbox"), /exactly one/);
	assert.throws(() => parseDurableMessageCommand([" ", ...message], "inbox"), /Missing <member>/);
	assert.throws(() => parseDurableMessageCommand(["--format", "xml", ...message], "broadcast"), /Invalid --format/);
	assert.throws(() => parseDurableMessageCommand(["--message", "a\0b"], "broadcast"), /NUL/);
	assert.throws(() => parseDurableMessageCommand(["--message", "x", "--instruction", " "], "broadcast"), /trimmed/);

	assert.equal(parseGuestJoinCommand(["--help"]).help, true);
	assert.equal(parseGuestLeaveCommand(["--help"]).help, true);
	assert.equal(parseGuestMessageCommand(["--help"], "send").help, true);
	assert.throws(() => parseGuestJoinCommand(["Bob", "--identity", "i", "--as", "A", "--callback"]), /Missing value/);
	assert.throws(
		() => parseGuestJoinCommand(["Bob", "--identity", "i", "--as", "A", "--callback", "c", "--bogus"]),
		/unknown option/,
	);
	assert.throws(
		() => parseGuestLeaveCommand(["Bob", "--crew", "c", "--identity", "i", "--callback", "x", "--format", "xml"]),
		/Invalid --format/,
	);
	assert.throws(
		() =>
			parseGuestMessageCommand(
				[
					"--crew",
					"c",
					"--identity",
					"i",
					"--as",
					"A",
					"--callback",
					"cb",
					"--capability",
					"cap",
					"--message",
					"m",
					"--target",
				],
				"send",
			),
		/Missing value/,
	);
});

test("TASK-0193 parser seams cover session and role format/error paths", () => {
	assert.equal(parseSessionListCommand(["--format", "json"]).format, "json");
	assert.equal(parseSessionListCommand(["--help"]).help, true);
	assert.throws(() => parseSessionListCommand(["--bogus"]), /unknown option/);
	assert.throws(() => parseSessionListCommand(["--format"]), /Missing value/);
	assert.equal(parseCrewRolesCommand(["--help"]).help, true);
	assert.throws(() => parseCrewRolesCommand(["--bogus"]), /unknown option/);
});

test("TASK-0193 parser seams exhaust member validation alternatives without transport", () => {
	assert.equal(parseMemberStatusCommand(["Bob", "--session", "source", "--format", "text"]).session, "source");
	assert.throws(() => parseMemberStatusCommand(["Bob", "Sue"]), /Too many arguments/);
	assert.throws(() => parseMemberStatusCommand([" "]), /Missing <member>/);
	assert.throws(() => parseMemberStatusCommand(["x".repeat(257)]), /at most/);
	assert.throws(() => parseMemberStatusCommand(["Bob", "--format", "xml"]), /Invalid --format/);

	assert.equal(parseMemberMessageCommand(["Bob", "--stdin", "--format=text"], "redirect").stdin, true);
	assert.equal(parseMemberMessageCommand(["--help", "--format", "json"], "follow_up").help, true);
	assert.throws(() => parseMemberMessageCommand(["Bob", "--message", "a\0b"], "follow_up"), /NUL/);
	assert.throws(() => parseMemberMessageCommand(["x".repeat(257), "--message", "x"], "follow_up"), /at most/);
	assert.throws(
		() => parseMemberMessageCommand(["Bob", "--message", "x", "--instruction", "x".repeat(100_001)], "follow_up"),
		/exceeds the 100000-byte limit/,
	);
	assert.throws(
		() => parseMemberMessageCommand(["Bob", "--message", "x", "--instruction", "a\0b"], "follow_up"),
		/NUL/,
	);

	assert.equal(parseMemberInterruptCommand(["Bob", "--message", "recover", "--format", "json"]).format, "json");
	assert.throws(() => parseMemberInterruptCommand(["Bob"]), /Missing message source/);
	assert.throws(() => parseMemberInterruptCommand(["Bob", "--message", "x", "--stdin"]), /exactly one/);
	assert.throws(() => parseMemberInterruptCommand(["Bob", "--stdin", "--format", "xml"]), /Invalid --format/);
});

test("TASK-0193 parser seams exhaust request and idle-wait duration branches", () => {
	assert.equal(
		parseMemberRequestSendCommand(["Bob", "--message", "x", "--response-grace", "60s", "--max-wait", "120s"])
			.responseGraceSeconds,
		60,
	);
	assert.throws(
		() => parseMemberRequestSendCommand(["Bob", "--message", "x", "--response-grace", "0s"]),
		/whole-second duration/,
	);
	assert.throws(
		() => parseMemberRequestSendCommand(["Bob", "--message", "x", "--max-wait", "60s", "--response-grace", "60s"]),
		/strictly greater/,
	);
	assert.throws(
		() => parseMemberRequestSendCommand(["Bob", "--message", "x", "--direction", "sideways"]),
		/unknown option/,
	);
	assert.equal(
		parseMemberRequestWaitCommand(["request-1", "--session", "source", "--format", "text"]).session,
		"source",
	);
	assert.throws(() => parseMemberRequestWaitCommand([" request-1 "]), /Missing exact/);

	assert.equal(
		parseMemberIdleWaitCommand(["Bob", "--session", "source", "--timeout", "1s", "--format", "json"])
			.timeoutSeconds,
		1,
	);
	assert.throws(() => parseMemberIdleWaitCommand(["Bob", "--timeout", "0s"]), /whole-second duration/);
	assert.throws(() => parseMemberIdleWaitCommand(["Bob", " "]), /Too many arguments/);
	assert.throws(() => parseMemberIdleWaitCommand([" "]), /Missing <member>/);
	assert.throws(() => parseMemberIdleWaitCommand(["x".repeat(257)]), /at most/);
});

test("TASK-0193 parser seams cover complete guest command value matrix", () => {
	const join = parseGuestJoinCommand([
		"/tmp/member.sock",
		"--identity",
		"guest-1",
		"--as",
		"Guest",
		"--callback",
		"/tmp/callback.sock",
		"--format",
		"json",
	]);
	assert.equal(join.format, "json");
	const leave = parseGuestLeaveCommand([
		"/tmp/member.sock",
		"--crew",
		"crew-1",
		"--identity",
		"guest-1",
		"--callback",
		"/tmp/callback.sock",
		"--format",
		"text",
	]);
	assert.equal(leave.format, "text");
	const common = [
		"--crew",
		"crew-1",
		"--identity",
		"guest-1",
		"--as",
		"Guest",
		"--callback",
		"/tmp/callback.sock",
		"--capability",
		"cap",
		"--message",
		"hello",
	] as const;
	assert.equal(parseGuestMessageCommand([...common, "--target", "Bob", "--format", "json"], "send").format, "json");
	assert.equal(parseGuestMessageCommand([...common, "--format", "text"], "broadcast").format, "text");
	assert.throws(
		() => parseGuestMessageCommand([...common, "--target", "Bob", "--format", "xml"], "send"),
		/Invalid --format/,
	);
	assert.throws(() => parseGuestMessageCommand([...common, "--target", ""], "send"), /requires a non-empty/);
	assert.throws(
		() => parseGuestJoinCommand([" ", "--identity", "i", "--as", "A", "--callback", "c"]),
		/require one live/,
	);
	assert.throws(
		() => parseGuestJoinCommand(["target", "--identity", " ", "--as", "A", "--callback", "c"]),
		/requires a non-empty/,
	);
	assert.throws(
		() =>
			parseGuestMessageCommand(
				[
					"--crew",
					"c",
					"--identity",
					"i",
					"--as",
					"A",
					"--callback",
					"cb",
					"--capability",
					"cap",
					"--message",
					"m",
					"--bogus",
				],
				"broadcast",
			),
		/unknown option/,
	);
});
