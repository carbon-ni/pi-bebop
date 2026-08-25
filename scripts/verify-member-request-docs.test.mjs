import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("Member Request workflow docs expose the approved terminal union and no stale public outcomes (TASK-0080)", () => {
	let output = "";
	try {
		output = execFileSync(process.execPath, ["scripts/verify-member-request-docs.mjs"], {
			cwd: root,
			encoding: "utf8",
		});
	} catch (error) {
		output = String(error.stdout ?? "") + String(error.stderr ?? "");
		assert.fail(output || String(error.message));
	}
	assert.match(output, /Member Request docs contract OK/);
});

test("docs regression catches the removed 'Idle without Response' outcome (negative guard)", () => {
	// The verification script must FAIL when the stale public outcome returns.
	const original = join(root, "docs/MEMBER-REQUEST-WORKFLOW.md");
	const content = readFileSync(original, "utf8");
	try {
		// Simulate the Kelly-BLOCK state by inserting the stale phrase.
		writeFileSync(original, `${content}\n### Idle without Response\n`);
		let failed = false;
		try {
			execFileSync(process.execPath, ["scripts/verify-member-request-docs.mjs"], {
				cwd: root,
				encoding: "utf8",
			});
		} catch {
			failed = true;
		}
		assert.equal(failed, true, "verify-member-request-docs.mjs must reject a stale outcome");
	} finally {
		writeFileSync(original, content);
	}
});
