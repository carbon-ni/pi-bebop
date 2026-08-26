import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("quality artifact upload includes hidden release files and only intended outputs", async () => {
	const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
	assert.match(workflow, /name: release-artifact[\s\S]*?include-hidden-files: true/);
	assert.match(workflow, /path: \|\n\s+\.release\/\*\.tgz\n\s+\.release\/SHA256SUMS/);
	assert.doesNotMatch(workflow, /path: \.release\/\s*$/m);
});
