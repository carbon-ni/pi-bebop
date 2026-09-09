import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const execFile = promisify(execFileCallback);

test("live session discovery is read-only when the control directory is absent", async () => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bebop-control-store-"));
	try {
		const moduleUrl = pathToFileURL(path.resolve("src/infra/control-store.ts")).href;
		await execFile(
			process.execPath,
			[
				"--import",
				"tsx",
				"--input-type=module",
				"--eval",
				`const { getLiveSessions } = await import(${JSON.stringify(moduleUrl)}); await getLiveSessions();`,
			],
			{ env: { ...process.env, HOME: home } },
		);
		assert.equal(
			await fs.stat(path.join(home, ".pi")).then(
				() => true,
				() => false,
			),
			false,
		);
	} finally {
		await fs.rm(home, { recursive: true, force: true });
	}
});
