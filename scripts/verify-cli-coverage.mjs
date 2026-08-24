import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const tests = [];
const cliProduction = [];
async function collect(dir, production = false) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) await collect(file, production);
		else if (entry.name.endsWith(".test.ts")) tests.push(file);
		else if (production && entry.name.endsWith(".ts")) cliProduction.push(path.relative(root, file));
	}
}
await collect(path.join(root, "src", "cli"), true);
await collect(path.join(root, "src", "infra"));

tests.sort();
cliProduction.sort();
const include = [...cliProduction, "src/infra/rpc-client.ts", "src/infra/rpc-server.ts"];
const args = [
	"--test",
	"--experimental-test-coverage",
	"--test-coverage-lines=95",
	"--test-coverage-branches=90",
	"--test-coverage-functions=0",
	...include.flatMap((file) => ["--test-coverage-include", file]),
	"--import",
	"tsx",
	...tests,
];
const result = spawnSync(process.execPath, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
