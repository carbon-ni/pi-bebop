import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
	createCrewIntakeDropbox,
	createCrewIntakeIdempotencyKey,
	isSafeCrewIntakeFilename,
	MAX_CREW_INTAKE_ENUMERATION_ENTRIES,
	MAX_CREW_INTAKE_FILE_BYTES,
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
	await fs.symlink(
		path.join(harness.dropbox.paths.newDir, "a.md"),
		path.join(harness.dropbox.paths.newDir, "link.md"),
	);
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

test("quiescence rejects a file mutated during the publication window", async (t) => {
	const harness = await fixture();
	t.after(harness.cleanup);
	const dropbox = createCrewIntakeDropbox({
		manifestPath: harness.manifestPath,
		projectRoot: harness.root,
		isProjectTrusted: () => true,
		quiescenceMs: 25,
	});
	await dropbox.prepare();
	const source = path.join(dropbox.paths.newDir, "changing.md");
	await fs.writeFile(source, "before");
	const work = (await dropbox.listWork())[0]!;
	setTimeout(() => void fs.appendFile(source, " after"), 5);
	await assert.rejects(
		dropbox.claim(work),
		(error: unknown) => (error as { code?: string }).code === "changed-while-reading",
	);
	assert.equal(await fs.readFile(source, "utf8"), "before after");
});

test("bounds directory enumeration and retains overflow for later scans", async (t) => {
	const harness = await fixture();
	t.after(harness.cleanup);
	await harness.dropbox.prepare();
	await Promise.all(
		Array.from({ length: MAX_CREW_INTAKE_ENUMERATION_ENTRIES + 1 }, (_, index) =>
			fs.writeFile(path.join(harness.dropbox.paths.newDir, `item-${String(index).padStart(3, "0")}.txt`), "x"),
		),
	);
	const work = await harness.dropbox.listWork();
	assert.equal(work.length, MAX_CREW_INTAKE_ENUMERATION_ENTRIES);
	assert.equal(work.truncated, true);
});

test("rejects oversized content and refuses processed-name collisions", async (t) => {
	const harness = await fixture();
	t.after(harness.cleanup);
	await harness.dropbox.prepare();
	const source = path.join(harness.dropbox.paths.newDir, "collision.md");
	await fs.writeFile(source, Buffer.alloc(MAX_CREW_INTAKE_FILE_BYTES + 1, 65));
	const oversizedWork = (await harness.dropbox.listWork())[0]!;
	const oversizedClaim = await harness.dropbox.claim(oversizedWork);
	await assert.rejects(
		harness.dropbox.read(oversizedClaim!),
		(error: unknown) => (error as { code?: string }).code === "oversized",
	);
	await harness.dropbox.release(oversizedClaim!);
	await fs.writeFile(source, "first");
	const firstClaim = await harness.dropbox.claim((await harness.dropbox.listWork())[0]!);
	await harness.dropbox.moveProcessed(firstClaim!);
	await fs.writeFile(source, "second");
	const secondClaim = await harness.dropbox.claim((await harness.dropbox.listWork())[0]!);
	await assert.rejects(
		harness.dropbox.moveProcessed(secondClaim!),
		(error: unknown) => (error as { code?: string }).code === "move-conflict",
	);
	await harness.dropbox.release(secondClaim!);
});

test("rejects symlinked and unsafe canonical ancestors before creating intake directories", async (t) => {
	const harness = await fixture();
	t.after(harness.cleanup);
	const realPi = path.join(harness.root, ".pi-real");
	await fs.rename(path.join(harness.root, ".pi"), realPi);
	await fs.symlink(".pi-real", path.join(harness.root, ".pi"));
	await assert.rejects(
		harness.dropbox.prepare(),
		(error: unknown) => (error as { code?: string }).code === "unsafe-directory",
	);

	const permissions = await fixture();
	t.after(permissions.cleanup);
	if (process.platform !== "win32") {
		await fs.chmod(path.join(permissions.root, ".pi"), 0o777);
		await assert.rejects(
			permissions.dropbox.prepare(),
			(error: unknown) => (error as { code?: string }).code === "permission-denied",
		);
	}
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
