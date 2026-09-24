import test from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { PassThrough } from "node:stream";
import { composeRegistry, createCliRegistry, type CliLeaf } from "./registry.ts";
import { createCliExecutionAdapter } from "./execution-adapter.ts";
import { UsageError } from "./support/arguments.ts";
import type { CliContext } from "./support/context.ts";

function context(): CliContext {
	return { cwd: "/project", input: new PassThrough(), signal: new AbortController().signal };
}

function registry(run: CliLeaf["run"], read: CliLeaf["read"] = () => ({ command: "ping" })): CliRegistry {
	const leaf: CliLeaf = {
		id: "ping",
		names: ["crew", "member", "ping"],
		build: () => new Command("ping").argument("<target>").option("--format <format>"),
		read,
		run,
	};
	return composeRegistry([leaf]);
}

function request(args: string[]) {
	return { args, cwd: "/project", input: new PassThrough(), output: new PassThrough(), signal: context().signal };
}

test("Commander adapter dispatches three-level commands and awaits async handlers", async () => {
	const seen: unknown[] = [];
	const adapter = createCliExecutionAdapter(
		registry(async (options) => {
			await Promise.resolve();
			seen.push(options);
			return { kind: "help", text: "async result" };
		}),
	);
	const outcome = await adapter.execute(request(["crew", "member", "ping", "target"]));
	assert.deepEqual(outcome, { kind: "help", text: "async result" });
	assert.deepEqual(seen, [{ command: "ping" }]);
});

test("root, group, and leaf help stay inside the returned outcome boundary", async () => {
	const adapter = createCliExecutionAdapter(registry(async () => ({ kind: "help", text: "handler" })));
	const root = await adapter.execute(request(["--help"]));
	assert.equal(root.kind, "help");
	assert.match(String((await adapter.execute(request(["crew", "--help"]))).text), /Usage:.*crew/s);
	const bare = await adapter.execute(request(["crew"]));
	assert.equal(bare.kind, "help");
	assert.match(String(bare.text), /Usage: bebop crew/);
	// Leaf help is Commander-generated; the semantic reader never runs.
	const leaf = await adapter.execute(request(["crew", "member", "ping", "-h"]));
	assert.match(String(leaf.text), /Usage: bebop crew member ping/);
	const version = await adapter.execute(request(["-v"]));
	assert.match(String(version.text), /^bebop \d+\.\d+\.\d+/);
});

test("every production leaf owns a Commander reader", () => {
	const leaves = createCliRegistry().leaves;
	assert.equal(leaves.length, 28);
	assert.ok(leaves.every((leaf) => typeof leaf.read === "function"));
	assert.ok(leaves.every((leaf) => leaf.names.length > 0));
});

test("Commander rejects unknown options and excess arguments before handlers run", async () => {
	let ran = false;
	const leaf: CliLeaf = {
		id: "probe",
		names: ["crew", "probe"],
		build: () => new Command("probe").option("--format <format>"),
		read: (command) => ({ command: "probe", format: command.opts<{ format?: string }>().format ?? "toon" }),
		run: async () => {
			ran = true;
			return { kind: "result", result: { ok: true, target: "", status: "probe" }, format: "toon", full: false };
		},
	};
	const adapter = createCliExecutionAdapter(composeRegistry([leaf]));
	await assert.rejects(
		adapter.execute(request(["crew", "probe", "--bogus"])),
		(error: unknown) =>
			error instanceof UsageError && /unknown option '--bogus'/i.test(error.message) && ran === false,
	);
	await assert.rejects(
		adapter.execute(request(["crew", "probe", "stray"])),
		(error: unknown) =>
			error instanceof UsageError && /usage: bebop crew probe/i.test(error.message) && ran === false,
	);
});

test("unknown syntax is rejected before the async handler, with local usage and suggestions", async () => {
	let called = false;
	const adapter = createCliExecutionAdapter(
		registry(async () => {
			called = true;
			return { kind: "help", text: "not reached" };
		}),
	);
	await assert.rejects(
		() => adapter.execute(request(["crew", "member", "unknown"])),
		(error: unknown) => error instanceof UsageError && /unknown command 'unknown'/.test(error.message),
	);
	await assert.rejects(
		() => adapter.execute(request(["frobnicate"])),
		(error: unknown) => error instanceof UsageError && /unknown command 'frobnicate'/.test(error.message),
	);
	await assert.rejects(
		() => adapter.execute(request(["crew", "--bogus"])),
		(error: unknown) => error instanceof UsageError && /unknown option '--bogus'/.test(error.message),
	);
	// The required <target> argument is missing: Commander rejects first.
	await assert.rejects(() => adapter.execute(request(["crew", "member", "ping"])), UsageError);
	assert.equal(called, false);
});
