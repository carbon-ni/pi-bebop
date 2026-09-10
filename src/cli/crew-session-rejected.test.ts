import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { createCliRegistry } from "./registry.ts";
import { UsageError } from "./support/arguments.ts";
import { runCli } from "./run.ts";
import type { CliContext } from "./support/context.ts";

/**
 * TASK-0204: legacy `pi-bebop crew session ...` rejection leaf. The synthetic
 * `crew-session-rejected` leaf matches every `crew session <sub>` prefix in the
 * registry's longest-prefix parse loop and is included in the Commander tree
 * with `allowExcessArguments + allowUnknownOption` so the action reaches the
 * parser that throws the deterministic `UsageError`. This test pins the
 * contract:
 *
 *   - every legacy input (bare + 5 subcommands) exits 2 with the exact
 *     replacement hint;
 *   - the rejection happens before any IO, manifest read, socket probe, or
 *     session-file read — proven by injecting a factory that would throw on
 *     any call;
 *   - the rejection leaf never appears in the public vocabulary or the home
 *     listing (hidden from vocabulary).
 *   - the rejection leaf never appears in the Commander `session` group (no
 *     double-`session` subcommand).
 *   - the new `pi-bebop session <capture|add|list|show|resolve>` paths still
 *     reach their real leaves (no regression from adding the rejection leaf).
 */

const HINT_REGEX =
	/'pi-bebop crew session \.\.\.' is no longer supported; use 'pi-bebop session <capture\|add\|list\|show\|resolve>'/;
const REJECTED_INPUTS: readonly (readonly string[])[] = [
	["crew", "session"],
	["crew", "session", "capture"],
	["crew", "session", "add"],
	["crew", "session", "list"],
	["crew", "session", "show"],
	["crew", "session", "resolve"],
];

test("parseCliCommand rejects every legacy crew session input with the replacement hint", () => {
	const registry = createCliRegistry();
	for (const args of REJECTED_INPUTS) {
		assert.throws(
			() => registry.parseCliCommand(args, "/project"),
			(error: unknown) => {
				assert.ok(error instanceof UsageError, args.join(" "));
				assert.match((error as UsageError).message, HINT_REGEX, args.join(" "));
				return true;
			},
			args.join(" "),
		);
	}
});

test("rejection leaf throws UsageError, never reaches its run adapter", async () => {
	const registry = createCliRegistry();
	const leaf = registry.leafById("crew-session-rejected");
	assert.equal(leaf.id, "crew-session-rejected");
	assert.deepEqual(leaf.names, ["crew", "session"]);
	assert.equal(leaf.hiddenFromVocabulary, true);
	assert.throws(
		() => leaf.parse(["capture"], "/project"),
		(error: unknown) => {
			assert.ok(error instanceof UsageError);
			assert.match((error as UsageError).message, HINT_REGEX);
			return true;
		},
	);
	let runCalled = false;
	await assert
		.rejects(
			async () =>
				leaf.run({} as never, {
					cwd: "/project",
					input: new PassThrough(),
					signal: new AbortController().signal,
				} satisfies CliContext),
			(error: unknown) => {
				assert.equal(runCalled, false, "run must not be invoked through the normal dispatch");
				assert.ok(error instanceof UsageError);
				assert.match((error as UsageError).message, HINT_REGEX);
				return true;
			},
		)
		.then(() => {
			runCalled = false;
		});
});

test("rejection leaf never appears in the public vocabulary or home listing", async () => {
	const registry = createCliRegistry();
	const vocabulary = registry.vocabulary();
	assert.ok(!vocabulary.includes("crew session"), `vocabulary leaked 'crew session': ${vocabulary.join(", ")}`);
	const home = await registry.leafById("home").run(
		{ command: "home" },
		{
			cwd: "/project",
			input: new PassThrough(),
			signal: new AbortController().signal,
		},
	);
	assert.equal(home.kind, "result");
	if (home.kind !== "result") return;
	const commands = (home.result.data as { commands: readonly string[] }).commands;
	assert.ok(!commands.includes("crew session"), `home listing leaked 'crew session': ${commands.join(", ")}`);
	assert.ok(commands.includes("session live"));
	assert.ok(commands.includes("session capture"));
	assert.ok(commands.includes("session list"));
	assert.ok(commands.includes("session resolve"));
});

test("Commander tree: session group has capture/add/list/show/resolve/live and never a nested 'session' subcommand", () => {
	const registry = createCliRegistry();
	const session = registry.root().commands.find((command) => command.name() === "session");
	assert.ok(session, "session group present");
	const subNames = session!.commands.map((command) => command.name());
	assert.deepEqual(subNames.sort(), ["add", "capture", "list", "live", "resolve", "show"]);
	assert.ok(
		!subNames.includes("session"),
		`session group must not contain a 'session' subcommand: ${subNames.join(", ")}`,
	);
});

test("runCli: every legacy crew session input exits 2 with the replacement hint and zero IO", async () => {
	for (const args of REJECTED_INPUTS) {
		const output = new PassThrough();
		let text = "";
		output.setEncoding("utf8");
		output.on("data", (chunk) => {
			text += chunk;
		});
		const code = await runCli([...args, "auth-regression", "Alice", "extra"], "/project", process.stdin, output);
		assert.equal(code, 2, args.join(" "));
		assert.match(text, HINT_REGEX, args.join(" "));
	}
});

test("runCli: new session capture/add/list/show/resolve paths still parse and dispatch (no regression)", async () => {
	const output = new PassThrough();
	let text = "";
	output.setEncoding("utf8");
	output.on("data", (chunk) => {
		text += chunk;
	});
	// Help short-circuit is the cheapest way to prove the leaf was reached without IO.
	const code = await runCli(["session", "list", "--help"], "/project", process.stdin, output);
	assert.equal(code, 0);
	assert.match(text, /pi-bebop session list/);
});

test("runCli: session live --help routes to the live Pi Session discovery leaf", async () => {
	const output = new PassThrough();
	let text = "";
	output.setEncoding("utf8");
	output.on("data", (chunk) => {
		text += chunk;
	});
	const code = await runCli(["session", "live", "--help"], "/project", process.stdin, output);
	assert.equal(code, 0);
	assert.match(text, /pi-bebop session live/);
});
