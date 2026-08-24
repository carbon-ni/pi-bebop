import test from "node:test";
import assert from "node:assert/strict";
import { rootCliHelp } from "./root-help.ts";
import { createCliRegistry } from "./registry.ts";

test("root help is deterministic, zero-IO, and derived from the registry vocabulary", () => {
	const registry = createCliRegistry();
	const first = rootCliHelp(registry.vocabulary());
	const second = rootCliHelp(registry.vocabulary());
	assert.equal(first, second);
	assert.match(first, /^pi-bebop — Pi Bebop crew coordination CLI/);
	assert.match(first, /Usage:/);
	assert.match(first, /--help \| -h/);
	assert.match(first, /Commands:/);
	for (const command of registry.vocabulary()) {
		assert.ok(first.includes(`  ${command}`), `missing command ${command}`);
	}
	assert.match(first, /Run 'pi-bebop <command> --help' for command details\./);
});

test("root help with an empty vocabulary is still deterministic and non-empty", () => {
	assert.equal(rootCliHelp([]), rootCliHelp([]));
	assert.match(rootCliHelp([]), /Commands:/);
	assert.match(rootCliHelp([]), /pi-bebop — Pi Bebop crew coordination CLI/);
});
