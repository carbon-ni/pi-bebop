import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { composeLeafTable, createCliRegistry, type CliContext, type CliLeaf } from "./registry.ts";
import { UsageError } from "./arguments.ts";
import type { CliOutcome } from "./output.ts";

function context(): CliContext {
	return { cwd: "/project", input: new PassThrough(), signal: new AbortController().signal };
}

function syntheticLeaf(id: string, helpText: string, outcome: CliOutcome): CliLeaf<{ command: string }> {
	return {
		id,
		help: () => helpText,
		run: async (options) =>
			outcome.kind === "help" ? { kind: "help" as const, text: `${outcome.text}:${options.command}` } : outcome,
	};
}

test("composeLeafTable yields deterministic ordered help/dispatch/error without shared mutable state", async () => {
	const alpha = syntheticLeaf("alpha", "alpha help", { kind: "help", text: "alpha ran" });
	const beta = syntheticLeaf("beta", "beta help", { kind: "help", text: "beta ran" });
	const table = composeLeafTable([alpha, beta]);

	// Ordered leaf ids reflect registration order.
	assert.deepEqual(table.ids, ["alpha", "beta"]);

	// Deterministic help: repeated calls return identical bytes.
	assert.equal(table.help("alpha"), "alpha help");
	assert.equal(table.help("alpha"), "alpha help");
	assert.equal(table.help("beta"), "beta help");

	// Deterministic dispatch: repeated dispatches return identical outcomes.
	const first = await table.dispatch({ command: "beta" }, context());
	const second = await table.dispatch({ command: "beta" }, context());
	assert.deepEqual(first, second);

	// Unknown ids fail identically and deterministically for help and dispatch.
	assert.throws(() => table.help("gamma"), UsageError);
	assert.throws(() => table.help("gamma"), UsageError);
	await assert.rejects(table.dispatch({ command: "gamma" }, context()), UsageError);

	// Composing the same leaves twice yields independent, equivalent tables.
	const other = composeLeafTable([alpha, beta]);
	assert.deepEqual(other.ids, table.ids);
	assert.equal(other.help("alpha"), table.help("alpha"));
	assert.deepEqual(
		await other.dispatch({ command: "alpha" }, context()),
		await table.dispatch({ command: "alpha" }, context()),
	);
});

test("createCliRegistry composes an exhaustive typed leaf map over the command union", () => {
	const registry = createCliRegistry();
	assert.deepEqual(Object.keys(registry.leaves), ["home", "crew-init", "send"]);
	assert.equal(registry.leaves.home.id, "home");
	assert.equal(registry.leaves["crew-init"].id, "crew-init");
	assert.equal(registry.leaves.send.id, "send");
});

test("registry leaf run adapters produce outcomes without shared state", async () => {
	const registry = createCliRegistry();
	const first = await registry.leaves.home.run({ command: "home" }, context());
	const second = await registry.leaves.home.run({ command: "home" }, context());
	assert.deepEqual(first, second);
});
