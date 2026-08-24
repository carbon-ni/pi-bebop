import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";
import { PassThrough } from "node:stream";
import { composeRegistry, createCliRegistry, type CliContext, type CliLeaf } from "./registry.ts";
import { UsageError } from "./arguments.ts";
import { writeOutcome, type CliOutcome } from "./output.ts";

function context(): CliContext {
	return { cwd: "/project", input: new PassThrough(), signal: new AbortController().signal };
}

const pingLeaf: CliLeaf = {
	id: "ping",
	names: ["ping"],
	build: () => new Command("ping").description("Respond to pings"),
	help: () => "pi-bebop ping <target> — pong",
	parse: (tokens) => ({ command: "ping", target: tokens.join(" ") }),
	run: async (options) => ({
		kind: "result",
		result: {
			ok: true,
			target: String((options as { target?: string }).target ?? ""),
			status: "pong",
		},
		format: "toon",
		full: false,
	}),
};

const crewAuditLeaf: CliLeaf = {
	id: "crew-audit",
	names: ["crew", "audit"],
	build: () => new Command("audit").description("Audit crew state"),
	help: () => "pi-bebop crew audit — audit help",
	parse: (tokens) => ({ command: "crew-audit", scope: tokens[0] ?? "" }),
	run: async () => ({ kind: "help", text: "crew audit ran" }),
};

/**
 * QA blocker integration test: adding a membership leaf is ONE registry
 * contribution — append the leaf module to the ordered list. Vocabulary
 * (parse), command-tree metadata (root), help, and dispatch all derive from
 * the registry; parser.ts and commands/root.ts are never edited.
 */
test("synthetic nested/top-level leaves work through real parse/help/root/dispatch with one registry contribution each", async () => {
	const base = createCliRegistry();
	const registry = composeRegistry([...base.leaves, pingLeaf, crewAuditLeaf]);

	// Real registry-driven parse: longest-prefix matching for nested + top-level leaves.
	const ping = registry.parseCliCommand(["ping", "socket-1"], "/p") as { command: string; target?: string };
	assert.equal(ping.command, "ping");
	assert.equal(ping.target, "socket-1");
	const audit = registry.parseCliCommand(["crew", "audit"], "/p") as { command: string };
	assert.equal(audit.command, "crew-audit");
	assert.equal((registry.parseCliCommand(["crew", "audit", "x"], "/p") as { command: string }).command, "crew-audit");

	// Existing real leaves still parse through the same registry (no regression).
	assert.equal(
		(registry.parseCliCommand(["send", "--socket", "/x", "--message", "m"], "/p") as { command: string }).command,
		"send",
	);
	assert.equal(
		(registry.parseCliCommand(["crew", "init", "--help"], "/p") as { command: string }).command,
		"crew-init",
	);

	// Unknown commands list the full ordered vocabulary including the new leaves.
	assert.throws(() => registry.parseCliCommand(["nope"], "/p"), /valid commands: send, crew init, ping, crew audit/);

	// Command-tree metadata derives from the registry: top-level leaf + nested leaf under the crew group.
	const root = registry.root();
	assert.ok(
		root.commands.some((command) => command.name() === "ping"),
		"top-level ping leaf present",
	);
	const crew = root.commands.find((command) => command.name() === "crew");
	assert.ok(crew, "crew group derived from registry");
	assert.ok(crew!.commands.some((command) => command.name() === "init"));
	assert.ok(crew!.commands.some((command) => command.name() === "audit"));

	// Help derives from the leaf modules through the registry.
	assert.equal(registry.leafById("ping").help(), "pi-bebop ping <target> — pong");
	assert.equal(registry.leafById("crew-audit").help(), "pi-bebop crew audit — audit help");

	// Dispatch derives from the registry and renders through the single output boundary.
	const outcome = await registry.leafById(ping.command).run(ping, context());
	const output = new PassThrough();
	let text = "";
	output.setEncoding("utf8");
	output.on("data", (chunk) => {
		text += chunk;
	});
	assert.equal(writeOutcome(output, outcome), 0);
	assert.match(text, /status: pong/);
	assert.match(text, /target: socket-1/);
});

test("composeRegistry yields deterministic ordered parse/help/dispatch without shared mutable state", async () => {
	const base = createCliRegistry();
	const first = composeRegistry([...base.leaves, pingLeaf, crewAuditLeaf]);
	const second = composeRegistry([...base.leaves, pingLeaf, crewAuditLeaf]);

	assert.deepEqual(
		first.leaves.map((leaf) => leaf.id),
		second.leaves.map((leaf) => leaf.id),
	);
	assert.equal(first.vocabulary().join(", "), "send, crew init, ping, crew audit");
	assert.deepEqual(first.parseCliCommand(["ping", "a"], "/p"), second.parseCliCommand(["ping", "a"], "/p"));
	assert.deepEqual(first.parseCliCommand(["ping", "a"], "/p"), first.parseCliCommand(["ping", "a"], "/p"));
	assert.equal(first.leafById("ping").help(), second.leafById("ping").help());
	assert.throws(() => first.leafById("gamma"), UsageError);
	assert.throws(() => first.parseCliCommand(["gamma"], "/p"), UsageError);
});

test("createCliRegistry composes the ordered built-in leaves", async () => {
	const registry = createCliRegistry();
	assert.deepEqual(
		registry.leaves.map((leaf) => leaf.id),
		["home", "send", "crew-init"],
	);
	assert.equal(registry.vocabulary().join(", "), "send, crew init");
	assert.equal((registry.parseCliCommand([], "/p") as { command: string }).command, "home");
	assert.equal(
		(registry.parseCliCommand(["send", "--socket", "/x", "--message", "m"], "/p") as { command: string }).command,
		"send",
	);
	assert.equal((registry.parseCliCommand(["crew", "init"], "/p") as { command: string }).command, "crew-init");
	assert.throws(() => registry.parseCliCommand(["bogus"], "/p"), /valid commands: send, crew init/);

	// Home derives vocabulary from the registry order and is deterministic.
	const first = await registry.leafById("home").run({ command: "home" }, context());
	const second = await registry.leafById("home").run({ command: "home" }, context());
	assert.deepEqual(first, second);
	assert.equal(first.kind, "result");
	if (first.kind !== "result") return;
	assert.deepEqual((first.result.data as { commands: string[] }).commands, ["send", "crew init"]);
});

test("registry leaf run adapters produce outcomes without shared state", async () => {
	const registry = createCliRegistry();
	const first = await registry.leafById("send").run(
		{
			command: "send",
			socketPath: "/offline.sock",
			message: "x",
			instructions: [],
			stdin: false,
			mode: "steer",
			wait: "accepted",
			timeoutMs: 100,
			format: "json",
			full: false,
		},
		context(),
	);
	const second = await registry.leafById("send").run(
		{
			command: "send",
			socketPath: "/offline.sock",
			message: "x",
			instructions: [],
			stdin: false,
			mode: "steer",
			wait: "accepted",
			timeoutMs: 100,
			format: "json",
			full: false,
		},
		context(),
	);
	assert.deepEqual(first, second);
	assert.equal(first.kind, "result");
	if (first.kind !== "result") return;
	assert.equal(first.result.ok, false);
	assert.equal(first.result.error?.code, "offline");
});
