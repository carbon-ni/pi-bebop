import test from "node:test";
import assert from "node:assert/strict";
import { cliFormatForArgs, defaultCliFormat, defaultFormatForCommand, parseHomeFormat } from "./audience-policy.ts";
import { runCli } from "./run.ts";
import { Writable } from "node:stream";

test("every result command's declared default matches the audience matrix", () => {
	assert.equal(defaultFormatForCommand("crew-init"), "text");
	for (const command of [
		"home",
		"send",
		"crew-roles",
		"crew-broadcast",
		"session-list",
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
	// Malformed explicit format is not an override: matched command's default applies.
	assert.equal(cliFormatForArgs(["crew", "init", "--format", "xml", "--bogus"]), "text");
	assert.equal(cliFormatForArgs(["member", "status", "--format", "xml"]), "toon");
});

test("home format: explicit valid wins, malformed rejected, default policy applies", () => {
	assert.equal(parseHomeFormat([]), "toon");
	assert.equal(parseHomeFormat(["--format", "json"]), "json");
	assert.equal(parseHomeFormat(["--format=json"]), "json");
	assert.equal(parseHomeFormat(["--format", "text"]), "text");
	assert.throws(() => parseHomeFormat(["--format", "yaml"]), /Invalid --format 'yaml'/);
});

test("live runCli: explicit overrides and defaults survive the adapter boundary", async () => {
	async function run(args: readonly string[]): Promise<{ code: number; text: string }> {
		let out = "";
		const sink = new Writable({
			write(c: unknown, _e: unknown, cb: () => void) {
				out += String(c);
				cb();
			},
		});
		const code = await runCli([...args], "/project", process.stdin, sink);
		return { code, text: out };
	}
	const sessionList = await run(["session", "list"]);
	assert.equal(sessionList.code, 0);
	assert.match(sessionList.text, /^ok: true/);

	const sessionListJson = await run(["session", "list", "--format", "json"]);
	assert.equal(sessionListJson.code, 0);
	assert.match(sessionListJson.text, /^\{/);

	const crewInitHelp = await run(["crew", "init", "--help"]);
	assert.equal(crewInitHelp.code, 0);
	assert.doesNotMatch(crewInitHelp.text, /^ok:/); // help stays plain text, no result envelope

	const version = await run(["--version"]);
	assert.equal(version.code, 0);
	assert.match(version.text, /^pi-bebop /); // version stays plain text

	const usageError = await run(["member", "status"]);
	assert.equal(usageError.code, 2);
	assert.match(usageError.text, /^ok: false/); // agent-first usage errors stay TOON
});
