import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
	createCrewIntakeDropbox,
	createCrewIntakeIdempotencyKey,
	isSafeCrewIntakeFilename,
} from "./crew-intake-dropbox.ts";

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "crew-intake-dropbox-"));
	const layout = path.join(root, ".pi", "bebop");
	await fs.mkdir(layout, { recursive: true, mode: 0o700 });
	const manifestPath = path.join(layout, "crew.json");
	await fs.writeFile(manifestPath, "{}", { mode: 0o600 });
	const dropbox = createCrewIntakeDropbox({
		manifestPath,
		projectRoot: root,
		isProjectTrusted: () => true,
		quiescenceMs: 0,
	});
	return { root, manifestPath, dropbox, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test("creates private intake directories and lists only deterministic ready files", async (t) => {
	const harness = await fixture();
	t.after(harness.cleanup);
	await harness.dropbox.prepare();
	await fs.writeFile(path.join(harness.dropbox.paths.newDir, "b.txt"), "B");
	await fs.writeFile(path.join(harness.dropbox.paths.newDir, "a.md"), "A");
	await fs.writeFile(path.join(harness.dropbox.paths.newDir, "draft.draft"), "draft");
	await fs.writeFile(path.join(harness.dropbox.paths.newDir, ".editor.md"), "hidden");
	await fs.mkdir(path.join(harness.dropbox.paths.newDir, "nested.md"));
	const work = await harness.dropbox.listWork();
	assert.deepEqual(
		work.map((entry) => entry.name),
		["a.md", "b.txt"],
	);
	if (process.platform !== "win32") {
		const stat = await fs.stat(harness.dropbox.paths.newDir);
		assert.equal(stat.mode & 0o077, 0);
	}
});

test("claims, reads, records, and moves one file without overwriting destinations", async (t) => {
	const harness = await fixture();
	t.after(harness.cleanup);
	await harness.dropbox.prepare();
	await fs.writeFile(path.join(harness.dropbox.paths.newDir, "message.md"), "opaque UTF-8\ntext");
	const work = (await harness.dropbox.listWork())[0]!;
	const claim = await harness.dropbox.claim(work);
	assert.ok(claim);
	const content = await harness.dropbox.read(claim!);
	assert.equal(content.content, "opaque UTF-8\ntext");
	const key = createCrewIntakeIdempotencyKey(harness.manifestPath, claim!.name, content.digest);
	await harness.dropbox.writeReceipt({
		version: 1,
		idempotencyKey: key,
		filename: claim!.name,
		digest: content.digest,
		itemId: "inbox-1-abc",
		recordedAt: 1,
	});
	assert.equal((await harness.dropbox.readReceipt(key))?.itemId, "inbox-1-abc");
	await harness.dropbox.moveProcessed(claim!);
	assert.equal(
		await fs.readFile(path.join(harness.dropbox.paths.processedDir, "message.md"), "utf8"),
		"opaque UTF-8\ntext",
	);
});

test("rejects malformed filenames and distinguishes safe names", () => {
	assert.equal(isSafeCrewIntakeFilename("message.md"), true);
	assert.equal(isSafeCrewIntakeFilename(" message.md"), false);
	assert.equal(isSafeCrewIntakeFilename("message.md\n"), false);
	assert.equal(isSafeCrewIntakeFilename("../message.md"), false);
	assert.equal(isSafeCrewIntakeFilename("message.exe"), true);
});

test("atomic claim is idempotent across concurrent claimers", async (t) => {
	const harness = await fixture();
	t.after(harness.cleanup);
	await harness.dropbox.prepare();
	await fs.writeFile(path.join(harness.dropbox.paths.newDir, "one.txt"), "one");
	const work = (await harness.dropbox.listWork())[0]!;
	const claims = await Promise.all([harness.dropbox.claim(work), harness.dropbox.claim(work)]);
	assert.equal(claims.filter(Boolean).length, 1);
});
