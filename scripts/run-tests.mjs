import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";

// Enumerate test files recursively instead of relying on shell globbing:
// sh has no globstar, so `src/**/*.test.ts` silently collapsed to depth 2
// and skipped every src/cli/commands/*.test.ts suite in plain `npm test`.
const roots = ["src", "scripts"];
const extensions = [".test.ts", ".test.mjs"];
const tests = [];
async function collect(dir) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) await collect(`${dir}/${entry.name}`);
		else if (extensions.some((extension) => entry.name.endsWith(extension))) tests.push(`${dir}/${entry.name}`);
	}
}
for (const root of roots) await collect(root);
tests.sort();

const result = spawnSync("node_modules/.bin/tsx", ["--test", ...tests], { stdio: "inherit" });
process.exit(result.status ?? 1);
