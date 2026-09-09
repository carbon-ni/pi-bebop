import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readCurrentPiSessionEvidence } from "./session-capture.ts";

const codingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const codingAgentPackage = JSON.parse(
	readFileSync(path.resolve(path.dirname(codingAgentEntry), "..", "package.json"), "utf8"),
) as {
	version: string;
};

/**
 * Compatibility gate for TASK-0201. Capture must use this public API surface,
 * not private JSONL parsing. Update the pinned dev dependency and this test
 * together when the supported Pi package changes.
 */
test("pinned Pi SessionManager exposes capture metadata through ExtensionContext", async () => {
	assert.equal(codingAgentPackage.version, "0.84.2");
	const cwd = await mkdtemp(path.join("/tmp", "bebop-session-compat-cwd-"));
	const sessionRoot = await mkdtemp(path.join("/tmp", "bebop-session-compat-root-"));
	try {
		const manager = SessionManager.create(cwd, sessionRoot, { id: "session-0201-compatibility" });
		const sessionFile = manager.getSessionFile();
		assert.equal(manager.isPersisted(), true);
		assert.ok(sessionFile);
		const header = manager.getHeader();
		assert.ok(header);
		await writeFile(sessionFile, `${JSON.stringify(header)}\n`, { mode: 0o600 });

		const context = { sessionManager: manager } as unknown as Pick<ExtensionContext, "sessionManager">;
		assert.deepEqual(readCurrentPiSessionEvidence(context), {
			persisted: true,
			id: "session-0201-compatibility",
			file: sessionFile,
			cwd,
			root: sessionRoot,
		});

		const reopened = SessionManager.open(sessionFile);
		assert.equal(reopened.getHeader()?.id, "session-0201-compatibility");
		assert.equal(reopened.getHeader()?.cwd, cwd);
		assert.equal(reopened.getSessionFile(), sessionFile);
		assert.equal(reopened.getSessionDir(), sessionRoot);
	} finally {
		await Promise.all([
			rm(cwd, { recursive: true, force: true }),
			rm(sessionRoot, { recursive: true, force: true }),
		]);
	}
});
