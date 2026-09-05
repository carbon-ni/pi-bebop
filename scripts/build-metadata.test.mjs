import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBuildCommit, resolveBuildCommit } from "./build-metadata.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";

test("normalizes a full uppercase hexadecimal commit override", () => {
	assert.equal(normalizeBuildCommit(SHA.toUpperCase()), SHA);
});

test("rejects missing, short, malformed, and padded commit metadata", () => {
	for (const value of [undefined, "", "  ", "abc", `${SHA}0`, `${SHA.slice(0, 39)}z`, ` ${SHA}`]) {
		assert.throws(() => normalizeBuildCommit(value), /full 40-character hexadecimal commit SHA/);
	}
});

test("fails explicitly when Git metadata is unavailable without an override", () => {
	assert.throws(
		() => resolveBuildCommit({ gitCommit: undefined, override: undefined }),
		/Missing Git metadata.*PI_BEBOP_BUILD_COMMIT/,
	);
});

test("uses and normalizes a validated override without querying Git", () => {
	assert.equal(resolveBuildCommit({ gitCommit: undefined, override: SHA.toUpperCase() }), SHA);
});

test("uses Git metadata when no override is supplied", () => {
	assert.equal(resolveBuildCommit({ gitCommit: ` ${SHA.toUpperCase()}\n` }), SHA);
});
