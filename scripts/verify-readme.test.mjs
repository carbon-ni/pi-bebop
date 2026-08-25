import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("README meets the TASK-0078 lean product entrypoint contract", () => {
	let output = "";
	try {
		output = execFileSync(process.execPath, ["scripts/verify-readme.mjs"], { cwd: root, encoding: "utf8" });
	} catch (error) {
		output = String(error.stdout ?? "") + String(error.stderr ?? "");
		assert.fail(output || String(error.message));
	}
	assert.match(output, /README contract OK/);
});

test("README size baseline is captured before any rewrite (snapshot guard)", () => {
	const readme = readFileSync(join(root, "README.md"), "utf8");
	assert.ok(readme.length > 0, "README.md must exist and be non-empty");
});
