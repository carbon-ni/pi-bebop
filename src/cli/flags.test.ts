import test from "node:test";
import assert from "node:assert/strict";
import { UsageError } from "./arguments.ts";
import { parseFlagTokens } from "./flags.ts";

const valueFlags = new Set(["--format", "--session"]);

function parse(args: string[]) {
	return parseFlagTokens(args, {
		valueFlags,
		booleanFlags: new Set(["--full"]),
		repeatableFlags: new Set(["--instruction"]),
		escapedValueFlags: new Set(["--format", "--session", "--instruction"]),
		rejectFlagLikeValues: true,
	});
}

test("flag tokenizer preserves equals and separated value forms for Commander", () => {
	assert.deepEqual(parse(["--format=json"]).tokens, ["--format=json"]);
	assert.deepEqual(parse(["--format", "json"]).tokens, ["--format", "json"]);
	assert.deepEqual(parse(["--session=s-1"]).tokens, ["--session=s-1"]);
});

test("flag tokenizer rejects repeated single and boolean flags with exact errors", () => {
	assert.throws(
		() => parse(["--format=json", "--format", "text"]),
		(error: unknown) => {
			assert.ok(error instanceof UsageError);
			assert.equal(error.message, "Duplicate flag: --format");
			return true;
		},
	);
	assert.throws(() => parse(["--full", "--full"]), /Duplicate flag: --full/);
});

test("flag tokenizer rejects duplicate help independently of command validation", () => {
	assert.throws(
		() => parse(["--help", "--help"]),
		(error: unknown) => {
			assert.ok(error instanceof UsageError);
			assert.equal(error.message, "Duplicate flag: --help");
			return true;
		},
	);
	const result = parse(["--help", "--format", "yaml"]);
	assert.equal(result.help, true);
	assert.deepEqual(result.tokens, ["--format", "yaml"]);
});

test("flag tokenizer extracts repeatable values in order without deduplication", () => {
	const result = parse(["--instruction", "one", "--instruction=two", "--instruction", "three"]);
	assert.deepEqual(result.tokens, []);
	assert.deepEqual(result.repeatableValues.get("--instruction"), ["one", "two", "three"]);
});

test("flag tokenizer supports the explicit sentinel escape for single and repeatable values", () => {
	const result = parse(["--format", "--", "-json", "--instruction", "--", "--looks-like-a-flag"]);
	assert.deepEqual(result.tokens, ["--format=-json"]);
	assert.deepEqual(result.repeatableValues.get("--instruction"), ["--looks-like-a-flag"]);
});

test("flag tokenizer allows or rejects equals flag-like repeatable values by explicit spec", () => {
	assert.deepEqual(parse(["--instruction=--allowed"]).repeatableValues.get("--instruction"), ["--allowed"]);
	assert.throws(
		() =>
			parseFlagTokens(["--instruction=--rejected"], {
				valueFlags,
				repeatableFlags: new Set(["--instruction"]),
				rejectFlagLikeEquals: true,
			}),
		/Missing value for --instruction/,
	);
});

test("flag tokenizer keeps missing single values for Commander and rejects missing repeatable values", () => {
	assert.deepEqual(parse(["--format"]).tokens, ["--format"]);
	assert.throws(() => parse(["--instruction"]), /Missing value for --instruction/);
	assert.throws(() => parse(["--instruction", "--format"]), /Missing value for --instruction/);
});

test("flag tokenizer leaves unknown flags and positional tokens unchanged", () => {
	const result = parse(["member", "--unknown", "value", "--", "tail"]);
	assert.deepEqual(result.tokens, ["member", "--unknown", "value", "--", "tail"]);
});

test("flag tokenizer preserves boolean argument behavior for Commander", () => {
	assert.deepEqual(parse(["--full"]).tokens, ["--full"]);
	assert.deepEqual(parse(["--full=value"]).tokens, ["--full=value"]);
});
