import test from "node:test";
import assert from "node:assert/strict";

import { createBranchAlias, createSequentialBranchAlias } from "./index.ts";
import { getCurrentGitBranch } from "../infra/git-branch.ts";

test("createBranchAlias turns git branch names into safe aliases", () => {
	assert.equal(createBranchAlias("main"), "branch-main");
	assert.equal(createBranchAlias("feature/pi intray"), "branch-feature-pi-intray");
	assert.equal(createBranchAlias("release/2026.05"), "branch-release-2026.05");
});

test("createSequentialBranchAlias appends the first available sequential id", () => {
	assert.equal(createSequentialBranchAlias("main", []), "branch-main-1");
	assert.equal(createSequentialBranchAlias("main", ["branch-main-1"]), "branch-main-2");
	assert.equal(createSequentialBranchAlias("main", ["branch-main-1", "branch-main-3"]), "branch-main-2");
});

test("createSequentialBranchAlias keeps the current branch alias stable", () => {
	assert.equal(createSequentialBranchAlias("main", ["branch-main-1"], "branch-main-1"), "branch-main-1");
});

test("createBranchAlias returns null for empty branch names", () => {
	assert.equal(createBranchAlias(""), null);
	assert.equal(createBranchAlias("   "), null);
});

test("getCurrentGitBranch returns current branch from git", async () => {
	const branch = await getCurrentGitBranch("/repo", async (_file, args, options) => {
		assert.deepEqual(args, ["rev-parse", "--abbrev-ref", "HEAD"]);
		assert.deepEqual(options, { cwd: "/repo" });
		return { stdout: "feature/intray\n" };
	});

	assert.equal(branch, "feature/intray");
});

test("getCurrentGitBranch returns null outside a git repository", async () => {
	const branch = await getCurrentGitBranch("/repo", async () => {
		throw new Error("not a git repository");
	});

	assert.equal(branch, null);
});
