import assert from "node:assert/strict";
import test from "node:test";
import { publicationDecision } from "./release-publish.mjs";

test("missing publication is publishable", () => {
	assert.equal(publicationDecision("abc", null), "publish");
});

test("duplicate identical bytes are resumable", () => {
	assert.equal(publicationDecision("abc", "abc"), "identical");
});

test("duplicate mismatched bytes fail closed", () => {
	assert.equal(publicationDecision("abc", "def"), "mismatch");
});

test("npm-first partial publication skips npm and permits missing GitHub upload", () => {
	assert.equal(publicationDecision("release-sha", "release-sha"), "identical");
	assert.equal(publicationDecision("release-sha", null), "publish");
});
