import { strict as assert } from "node:assert";
import { mkdtemp, readFile, readdir, stat, symlink, rm } from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { createCrewSessionStore } from "./crew-session-store.ts";
import type { CrewSessionRecord } from "../domain/index.ts";

function record(id = "cs_0123456789abcdef"): CrewSessionRecord {
	return {
		schemaVersion: 1,
		id,
		name: "auth regression",
		crew: {
			selector: "alpha",
			displayName: "Alpha",
			locator: "/project/.pi/bebop/crew.json",
			manifestFingerprint: "mfv1-sha256-test",
		},
		createdAt: "2026-09-09T12:00:00.000Z",
		state: "partial",
		members: [{ name: "Alice", role: "developer", status: "missing", reason: "offline" }],
	};
}

test("Crew Session listing is read-only when storage does not exist", async () => {
	const root = await mkdtemp(path.join("/tmp", "bebop-session-store-test-"));
	const storage = path.join(root, "crew-sessions");
	try {
		assert.deepEqual(await createCrewSessionStore({ rootDir: storage }).list(), []);
		await assert.rejects(stat(storage), { code: "ENOENT" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Crew Session records are private and atomically published", async () => {
	const root = await mkdtemp(path.join("/tmp", "bebop-session-store-test-"));
	try {
		const storage = createCrewSessionStore({ rootDir: path.join(root, "crew-sessions") });
		const value = record();
		await storage.write(value);
		const rootStat = await stat(storage.rootDir);
		const recordStat = await stat(path.join(storage.rootDir, `${value.id}.json`));
		assert.equal(rootStat.mode & 0o777, 0o700);
		assert.equal(recordStat.mode & 0o777, 0o600);
		assert.deepEqual(await storage.read(value.id), value);
		assert.deepEqual(
			(await storage.list()).map((item) => item.id),
			[value.id],
		);
		assert.equal(await readFile(path.join(storage.rootDir, ".capture.lock"), "utf8").catch(() => null), null);
		assert.deepEqual(
			(await readdir(storage.rootDir)).filter((name) => name.startsWith(".record-")),
			[],
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Crew Session storage rejects a symlink root", async () => {
	const root = await mkdtemp(path.join("/tmp", "bebop-session-store-test-"));
	const target = path.join(root, "target");
	const link = path.join(root, "crew-sessions");
	try {
		await symlink(target, link);
		await assert.rejects(
			createCrewSessionStore({ rootDir: link }).write(record()),
			(error: unknown) => error instanceof Error && error.message.includes("symlink"),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
