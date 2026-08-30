import assert from "node:assert/strict";
import test from "node:test";
import { runQualityGate } from "./quiet-quality-gate.mjs";

function output() {
	const standard = [];
	const error = [];
	return {
		standard,
		error,
		write: (text) => standard.push(text),
		writeError: (text) => error.push(text),
	};
}

test("prints true without command output when every quality command passes", () => {
	const captured = output();
	const calls = [];

	const passed = runQualityGate({
		commands: [
			["lint", []],
			["test", []],
		],
		run: (command, args) => {
			calls.push([command, args]);
			return { status: 0, stdout: "noisy success", stderr: "" };
		},
		...captured,
	});

	assert.equal(passed, true);
	assert.deepEqual(calls, [
		["lint", []],
		["test", []],
	]);
	assert.deepEqual(captured.standard, ["true\n"]);
	assert.deepEqual(captured.error, []);
});

test("prints false and failing command output without running later commands", () => {
	const captured = output();
	const calls = [];

	const passed = runQualityGate({
		commands: [
			["lint", []],
			["test", []],
		],
		run: (command) => {
			calls.push(command);
			return { status: 1, stdout: "type error", stderr: "" };
		},
		...captured,
	});

	assert.equal(passed, false);
	assert.deepEqual(calls, ["lint"]);
	assert.deepEqual(captured.standard, ["false\n"]);
	assert.deepEqual(captured.error, ["lint  failed\ntype error\n"]);
});
