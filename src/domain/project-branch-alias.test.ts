import test from "node:test";
import assert from "node:assert/strict";

import { createProjectBranchAlias, createSequentialProjectBranchAlias } from "./index.ts";
import { getGitProjectName } from "../infra/git-branch.ts";

test("createProjectBranchAlias includes project and branch", () => {
	assert.equal(createProjectBranchAlias("pi-intray", "main"), "intra-pi-intray-branch-main");
	assert.equal(createProjectBranchAlias("Other Repo", "feature/foo"), "intra-Other-Repo-branch-feature-foo");
});

test("createProjectBranchAlias returns null for missing project or branch", () => {
	assert.equal(createProjectBranchAlias("", "main"), null);
	assert.equal(createProjectBranchAlias("pi-intray", ""), null);
});

test("createSequentialProjectBranchAlias appends the first available sequential id", () => {
	assert.equal(createSequentialProjectBranchAlias("pi-intray", "main", []), "intra-pi-intray-branch-main-1");
	assert.equal(
		createSequentialProjectBranchAlias("pi-intray", "main", ["intra-pi-intray-branch-main-1"]),
		"intra-pi-intray-branch-main-2",
	);
});

test("createSequentialProjectBranchAlias keeps current alias stable", () => {
	assert.equal(
		createSequentialProjectBranchAlias("pi-intray", "main", ["intra-pi-intray-branch-main-1"], "intra-pi-intray-branch-main-1"),
		"intra-pi-intray-branch-main-1",
	);
});

test("getGitProjectName returns git root basename", async () => {
	const project = await getGitProjectName("/repo/subdir", async (_file, args, options) => {
		assert.deepEqual(args, ["rev-parse", "--show-toplevel"]);
		assert.deepEqual(options, { cwd: "/repo/subdir" });
		return { stdout: "/workspace/pi-intray\n" };
	});

	assert.equal(project, "pi-intray");
});

test("getGitProjectName returns null outside git repository", async () => {
	const project = await getGitProjectName("/repo", async () => {
		throw new Error("not a git repository");
	});

	assert.equal(project, null);
});
