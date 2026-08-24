import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const tests = [];
async function collect(dir) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) await collect(file);
		else if (entry.name.endsWith(".test.ts")) tests.push(file);
	}
}
await collect(path.join(root, "src", "cli"));

tests.sort();
const include = [
	"src/cli/arguments.ts",
	"src/cli/errors.ts",
	"src/cli/message-input.ts",
	"src/cli/output.ts",
	"src/cli/source-session.ts",
	"src/cli/run.ts",
	"src/cli/parser.ts",
	"src/cli/registry.ts",
	"src/cli/commands/send-handler.ts",
	"src/cli/commands/direct-send-adapter.ts",
	"src/cli/commands/crew-init-handler.ts",
	"src/cli/commands/crew-intake-adapter.ts",
	"src/cli/commands/member-status.ts",
	"src/cli/commands/member-message.ts",
	"src/cli/commands/member-focus.ts",
	"src/cli/commands/member-idle-wait.ts",
	"src/cli/commands/member-interrupt.ts",
	"src/cli/commands/durable-message.ts",
	"src/cli/commands/session-list.ts",
	"src/infra/rpc-client.ts",
	"src/infra/rpc-server.ts",
];
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
