import test from "node:test";
import assert from "node:assert/strict";
import { UsageError } from "./arguments.ts";
import { scanCliFlags } from "./flag-scanner.ts";

test("scanCliFlags collects repeatable values in order and preserves unknown tokens", () => {
	const result = scanCliFlags(
		["--instruction=one", "--unknown", "value", "--instruction", "two"],
		[{ name: "--instruction", kind: "repeatable" }],
	);
	assert.deepEqual(result.repeatedValues["--instruction"], ["one", "two"]);
	assert.deepEqual(result.tokens, ["--unknown", "value"]);
});

test("scanCliFlags supports sentinel values and strips help", () => {
	const result = scanCliFlags(
		["--help", "--session", "--", "--looks-like-a-value", "member"],
		[{ name: "--session", kind: "value", allowSentinelValue: true }],
	);
	assert.equal(result.help, true);
	assert.deepEqual(result.tokens, ["--session=--looks-like-a-value", "member"]);
});

test("scanCliFlags handles sentinel repeatables and default limit errors", () => {
	const result = scanCliFlags(
		["--instruction", "--", "--dash"],
		[{ name: "--instruction", kind: "repeatable", allowSentinelValue: true }],
	);
	assert.deepEqual(result.repeatedValues["--instruction"], ["--dash"]);
	assert.throws(
		() =>
			scanCliFlags(
				["--instruction", "one", "--instruction", "two"],
				[{ name: "--instruction", kind: "repeatable", maxValues: 1 }],
			),
		(error: unknown) => error instanceof UsageError && error.message === "Too many values for --instruction",
	);
	assert.throws(
		() =>
			scanCliFlags(
				["--instruction", "--"],
				[{ name: "--instruction", kind: "repeatable", allowSentinelValue: true }],
			),
		(error: unknown) => error instanceof UsageError && error.message === "Missing value for --instruction",
	);
});

test("scanCliFlags enforces repeatable limits and boolean duplicates", () => {
	assert.throws(
		() =>
			scanCliFlags(
				["--instruction", "one", "--instruction", "two"],
				[{ name: "--instruction", kind: "repeatable", maxValues: 1, tooManyValuesMessage: "too many" }],
			),
		(error: unknown) => error instanceof UsageError && error.message === "too many",
	);
	assert.throws(
		() => scanCliFlags(["--stdin", "--stdin"], [{ name: "--stdin", kind: "boolean" }]),
		(error: unknown) => error instanceof UsageError && error.message === "Duplicate flag: --stdin",
	);
});

test("scanCliFlags rejects duplicate flags and missing repeatable values", () => {
	assert.throws(
		() => scanCliFlags(["--format", "toon", "--format", "json"], [{ name: "--format", kind: "value" }]),
		(error: unknown) => error instanceof UsageError && error.message === "Duplicate flag: --format",
	);
	assert.throws(
		() => scanCliFlags(["--instruction", "--other"], [{ name: "--instruction", kind: "repeatable" }]),
		(error: unknown) => error instanceof UsageError && error.message === "Missing value for --instruction",
	);
});
