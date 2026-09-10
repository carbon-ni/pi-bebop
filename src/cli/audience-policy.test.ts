import test from "node:test";
import assert from "node:assert/strict";
import { cliFormatForArgs, defaultCliFormat, defaultFormatForCommand, parseHomeFormat } from "./audience-policy.ts";
import { parseCliCommand } from "./registry.ts";

test("every result command's declared default matches the audience matrix", () => {
	assert.equal(defaultFormatForCommand("crew-init"), "text");
	for (const command of [
		"home",
		"send",
		"crew-roles",
		"crew-broadcast",
		"session-live",
		"member-status",
		"member-idle-wait",
		"member-follow-up",
		"member-redirect",
		"member-inbox-send",
		"member-interrupt",
		"member-request-send",
		"member-request-list",
		"member-request-wait",
		"member-request-respond",
		"guest-join",
		"guest-leave",
		"guest-send",
		"guest-broadcast",
	]) {
		assert.equal(defaultFormatForCommand(command), "toon", command);
	}
});

test("argv-based default follows the matched command and stays deterministic", () => {
	assert.equal(defaultCliFormat([]), "toon");
	assert.equal(defaultCliFormat(["crew", "init"]), "text");
	assert.equal(defaultCliFormat(["crew", "init", "--project", "."]), "text");
	assert.equal(defaultCliFormat(["crew", "roles"]), "toon");
	assert.equal(defaultCliFormat(["member", "status", "x"]), "toon");
});

test("usage-error format honors explicit valid override else matched command default", () => {
	assert.equal(cliFormatForArgs(["crew", "init"]), "text");
	assert.equal(cliFormatForArgs(["crew", "init", "--bogus"]), "text");
	assert.equal(cliFormatForArgs(["crew", "init", "--format", "toon", "--bogus"]), "toon");
	assert.equal(cliFormatForArgs(["member", "status", "--bogus"]), "toon");
	assert.equal(cliFormatForArgs(["member", "status", "--format", "json", "--bogus"]), "json");
	assert.equal(cliFormatForArgs(["member", "status", "--format=json", "--bogus"]), "json");
	assert.equal(cliFormatForArgs(["member", "status", "--format", "text", "--bogus"]), "text");
	// Malformed explicit format is not an override: matched command's default applies.
	assert.equal(cliFormatForArgs(["crew", "init", "--format", "xml", "--bogus"]), "text");
	assert.equal(cliFormatForArgs(["member", "status", "--format", "xml"]), "toon");
	assert.equal(cliFormatForArgs(["crew", "init", "--format=xml", "--bogus"]), "text");
	assert.equal(cliFormatForArgs(["crew", "init", "--format"]), "text");
});

test("home format: explicit valid wins, malformed rejected, default policy applies", () => {
	assert.equal(parseHomeFormat([]), "toon");
	assert.equal(parseHomeFormat(["--format", "json"]), "json");
	assert.equal(parseHomeFormat(["--format=json"]), "json");
	assert.equal(parseHomeFormat(["--format", "text"]), "text");
	assert.equal(parseHomeFormat(["--other", "value"]), "toon");
	assert.throws(() => parseHomeFormat(["--format", "yaml"]), /Invalid --format 'yaml'/);
	assert.throws(() => parseHomeFormat(["--format=yaml"]), /Invalid --format 'yaml'/);
	assert.equal(parseHomeFormat(["--format"]), "toon");
});

test("all result command leaves parse explicit format overrides without transport", () => {
	// Parser-only matrix: coverage must never inherit PI_SESSION_ID or invoke
	// member/guest transport while checking presentation defaults.
	const commandArgs: readonly (readonly string[])[] = [
		["send", "--socket", "/tmp/socket.sock", "--message", "hello"],
		["crew", "roles"],
		["session", "live"],
		["crew", "broadcast", "--message", "hello"],
		["member", "status", "Bob"],
		["member", "wait-idle", "Bob"],
		["member", "follow-up", "Bob", "--message", "hello"],
		["member", "redirect", "Bob", "--message", "hello"],
		["member", "inbox", "send", "Bob", "--message", "hello"],
		["member", "interrupt", "Bob", "--message", "recover"],
		["member", "request", "send", "Bob", "--message", "hello"],
		["member", "request", "list"],
		["member", "request", "wait", "request-1"],
		["member", "request", "respond", "request-1", "--message", "done"],
		[
			"guest",
			"join",
			"/tmp/member.sock",
			"--identity",
			"guest-1",
			"--as",
			"Guest",
			"--callback",
			"/tmp/callback.sock",
		],
		[
			"guest",
			"leave",
			"/tmp/member.sock",
			"--crew",
			"crew-1",
			"--identity",
			"guest-1",
			"--callback",
			"/tmp/callback.sock",
		],
	];
	for (const args of commandArgs) {
		for (const format of ["toon", "json", "text"] as const) {
			const parsed = parseCliCommand([...args, "--format", format], "/project") as { format?: string };
			assert.equal(parsed.format, format, `${args.join(" ")} --format ${format}`);
		}
	}
});
