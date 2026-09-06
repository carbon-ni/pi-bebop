import test from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { PassThrough } from "node:stream";
import { composeRegistry, createCliRegistry, type CliLeaf } from "./registry.ts";
import { createCliExecutionAdapter, rejectDuplicateScalarOptions } from "./execution-adapter.ts";
import { UsageError } from "./support/arguments.ts";
import type { CliContext } from "./support/context.ts";

function context(): CliContext {
	return { cwd: "/project", input: new PassThrough(), signal: new AbortController().signal };
}

function registry(run: CliLeaf["run"], parse: CliLeaf["parse"] = (tokens) => ({ command: "ping", tokens })) {
	const leaf: CliLeaf = {
		id: "ping",
		names: ["crew", "member", "ping"],
		build: () => new Command("ping").argument("<target>").option("--format <format>"),
		help: () => "ping help",
		parse,
		run,
	};
	return composeRegistry([
		{
			id: "home",
			names: [],
			build: () => new Command("home"),
			help: () => "",
			parse: () => ({ command: "home" }),
			run: async (_options, _context) => ({
				kind: "result",
				result: { ok: true, target: "", status: "home" },
				format: "toon",
				full: false,
			}),
		},
		leaf,
	]);
}

function request(args: string[]) {
	return { args, cwd: "/project", input: new PassThrough(), output: new PassThrough(), signal: context().signal };
}

test("Commander adapter dispatches three-level commands and awaits async handlers", async () => {
	const seen: unknown[] = [];
	const adapter = createCliExecutionAdapter(
		registry(async (options, _context) => {
			await Promise.resolve();
			seen.push(options);
			return { kind: "help", text: "async result" };
		}),
	);
	const outcome = await adapter.execute(request(["crew", "member", "ping", "target"]));
	assert.deepEqual(outcome, { kind: "help", text: "async result" });
	assert.deepEqual(seen, [{ command: "ping", tokens: ["target"] }]);
	await adapter.execute(request(["crew", "member", "ping", "target", "--", "-h"]));
	assert.deepEqual(seen[1], { command: "ping", tokens: ["target", "--", "-h"] });
});

test("duplicate scalar policy preserves repeatables and the option sentinel", () => {
	const program = new Command("test").option("--format <format>").option("--instruction <value>");
	// A selected command that declares --instruction keeps its repeatable contract.
	rejectDuplicateScalarOptions(
		["--format=toon", "--instruction", "one", "--instruction", "two", "--", "--format", "json"],
		program,
	);
	// The option sentinel ends duplicate scanning: later tokens are positional.
	const sentinel = new Command("sentinel").option("--format <format>");
	rejectDuplicateScalarOptions(["--format", "json", "--", "--format", "toon"], sentinel);
	// Scalar options still reject on the selected command.
	const nonRepeatable = new Command("plain").option("--format <format>").option("--instruction <value>");
	assert.throws(
		() => rejectDuplicateScalarOptions(["--format", "json", "--format", "toon"], nonRepeatable),
		/Duplicate flag: --format/,
	);
	// Repeatable status follows the SELECTED command, not the tree union:
	// a root-level --instruction declaration does not exempt a selected
	// subcommand that does not declare it.
	const root = new Command("root").option("--instruction <value>");
	const leaf = new Command("leaf").option("--format <format>");
	root.addCommand(leaf);
	assert.throws(
		() => rejectDuplicateScalarOptions(["leaf", "--instruction", "one", "--instruction", "two"], root),
		/Duplicate flag: --instruction/,
	);
});

test("duplicate scalar policy rejects before parse or handler and permits repeated instructions by contract", async () => {
	let parsed = 0;
	const adapter = createCliExecutionAdapter(
		registry(
			async () => ({ kind: "help", text: "not reached" }),
			(tokens) => {
				parsed += 1;
				return { command: "ping", tokens };
			},
		),
	);
	await assert.rejects(
		() => adapter.execute(request(["crew", "member", "ping", "target", "--format", "toon", "--format", "json"])),
		(error: unknown) => error instanceof UsageError && error.message === "Duplicate flag: --format",
	);
	assert.equal(parsed, 0);
});

test("root, group, leaf help and version stay inside the returned outcome boundary", async () => {
	const adapter = createCliExecutionAdapter(registry(async () => ({ kind: "help", text: "handler" })));
	assert.equal((await adapter.execute(request(["--help"]))).kind, "help");
	assert.match(String((await adapter.execute(request(["crew", "--help"]))).text), /Usage:.*crew/s);
	assert.match(String((await adapter.execute(request(["crew", "member", "ping", "-h"]))).text), /ping help/);
	assert.equal((await adapter.execute(request(["--version"]))).kind, "result");
});

test("all communication leaves use Commander readers while retaining semantic parser facades", () => {
	const communication = new Set([
		"send",
		"guest-join",
		"guest-leave",
		"guest-send",
		"guest-broadcast",
		"member-follow-up",
		"member-redirect",
		"member-request-send",
		"member-request-list",
		"member-request-wait",
		"member-request-respond",
		"member-inbox-send",
		"member-interrupt",
		"crew-broadcast",
	]);
	const leaves = createCliRegistry().leaves.filter((leaf) => communication.has(leaf.id));
	assert.equal(leaves.length, communication.size);
	assert.ok(leaves.every((leaf) => leaf.read !== undefined));
	assert.ok(leaves.every((leaf) => leaf.parse !== undefined));
});

test("migrated read leaves reject unknown options and excess arguments before handlers", async () => {
	let ran = false;
	const leaf: CliLeaf = {
		id: "probe",
		names: ["crew", "probe"],
		build: () => new Command("probe").option("--format <format>"),
		help: () => "probe help",
		parse: (tokens) => ({ command: "probe", tokens }),
		read: (command) => ({ command: "probe", format: command.opts<{ format?: string }>().format ?? "toon" }),
		run: async () => {
			ran = true;
			return { kind: "result", result: { ok: true, target: "", status: "probe" }, format: "toon", full: false };
		},
	};
	const adapter = createCliExecutionAdapter(
		composeRegistry([
			{
				id: "home",
				names: [],
				build: () => new Command("home"),
				help: () => "",
				parse: () => ({ command: "home" }),
				run: async () => ({
					kind: "result",
					result: { ok: true, target: "", status: "home" },
					format: "toon",
					full: false,
				}),
			},
			leaf,
		]),
	);
	await assert.rejects(
		adapter.execute(request(["crew", "probe", "--bogus"])),
		(error: unknown) => error instanceof UsageError && /unknown option/i.test(error.message) && ran === false,
	);
	await assert.rejects(
		adapter.execute(request(["crew", "probe", "stray"])),
		(error: unknown) => error instanceof UsageError && /too many arguments/i.test(error.message) && ran === false,
	);
});

test("unknown syntax is rejected before the async handler", async () => {
	let called = false;
	const adapter = createCliExecutionAdapter(
		registry(async () => {
			called = true;
			return { kind: "help", text: "not reached" };
		}),
	);
	await assert.rejects(() => adapter.execute(request(["crew", "member", "unknown"])), UsageError);
	await assert.rejects(() => adapter.execute(request(["frobnicate"])), /Invalid command/);
	await assert.rejects(() => adapter.execute(request(["crew", "--bogus"])), /unknown option/);
	await assert.rejects(() => adapter.execute(request(["crew", "member", "ping"])), UsageError);
	assert.equal(called, false);
});
