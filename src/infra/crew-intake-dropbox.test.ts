import { createHash } from "node:crypto";
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
	assert.equal(isSafeCrewIntakeFilename(`${"a".repeat(160)}.md`), false);
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

test("watch debounce resets after a near-deadline update", async (t) => {
	const harness = await fixture();
	t.after(harness.cleanup);
	const dropbox = createCrewIntakeDropbox({
		manifestPath: harness.manifestPath,
		projectRoot: harness.root,
		isProjectTrusted: () => true,
		quiescenceMs: 80,
	});
	await dropbox.prepare();
	const events: number[] = [];
	const watcher = dropbox.watch(
		() => events.push(Date.now()),
		() => assert.fail("watch failed"),
	);
	t.after(() => watcher.close());
	const source = path.join(dropbox.paths.newDir, "near-deadline.md");
	await fs.writeFile(source, "before");
	await new Promise((resolve) => setTimeout(resolve, 30));
	const updatedAt = Date.now();
	await fs.appendFile(source, " after");
	for (let attempt = 0; attempt < 30 && events.length === 0; attempt += 1)
		await new Promise((resolve) => setTimeout(resolve, 10));
	watcher.close();
	assert.equal(events.length, 1);
	assert.ok(events[0]! - updatedAt >= 45, `debounce fired too early: ${events[0]! - updatedAt}ms`);
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

test("publishes atomically, leaves no draft, and is idempotent after processing", async (t) => {
	const harness = await fixture();
	t.after(harness.cleanup);
	await assert.rejects(
		harness.dropbox.publish("feedback.md", ""),
		(error: unknown) => (error as { code?: string }).code === "empty-file",
	);
	await assert.rejects(
		harness.dropbox.publish("feedback.md", "\0"),
		(error: unknown) => (error as { code?: string }).code === "nul-byte",
	);
	await assert.rejects(
		harness.dropbox.publish("feedback.md", "x".repeat(MAX_CREW_INTAKE_FILE_BYTES + 1)),
		(error: unknown) => (error as { code?: string }).code === "oversized",
	);
	const published = await harness.dropbox.publish("feedback.md", "durable feedback ✅");
	assert.equal(published.state, "published");
	assert.deepEqual(
		(await harness.dropbox.listWork()).map((entry) => entry.name),
		["feedback.md"],
	);
	assert.deepEqual(
		(await fs.readdir(harness.dropbox.paths.newDir)).filter((name) => name.startsWith(".draft-")),
		[],
	);
	assert.deepEqual(
		(await fs.readdir(harness.dropbox.paths.root)).filter((name) => name.startsWith(".draft-")),
		[],
	);
	const claim = (await harness.dropbox.listWork())[0]!;
	const claimed = await harness.dropbox.claim(claim);
	assert.ok(claimed);
	await harness.dropbox.moveProcessed(claimed!);
	const repeated = await harness.dropbox.publish("feedback.md", "durable feedback ✅");
	assert.equal(repeated.state, "already-published");
});

test("reclaims stale publication locks after a killed publisher", async (t) => {
	const harness = await fixture();
	t.after(harness.cleanup);
	await harness.dropbox.prepare();
	const lockPath = path.join(harness.dropbox.paths.root, ".scan.lock");
	await fs.writeFile(lockPath, "", { mode: 0o600 });
	const staleAt = new Date(Date.now() - 11 * 60 * 1000);
	await fs.utimes(lockPath, staleAt, staleAt);
	const result = await harness.dropbox.publish("stale.md", "recoverable feedback");
	assert.equal(result.state, "published");
	await assert.rejects(fs.access(lockPath));
});

test("serializes retries with an in-progress claim instead of duplicating Intake", async (t) => {
	const harness = await fixture();
	t.after(harness.cleanup);
	await harness.dropbox.publish("retry.md", "same feedback");
	const release = await harness.dropbox.lock();
	const work = (await harness.dropbox.listWork())[0]!;
	const claim = await harness.dropbox.claim(work);
	assert.ok(claim);
	const retry = harness.dropbox.publish("retry.md", "same feedback");
	setTimeout(() => void release(), 10);
	const result = await retry;
	assert.equal(result.state, "already-published");
	assert.deepEqual(
		(await harness.dropbox.listWork()).map((entry) => ({ name: entry.name, claimed: entry.claimed })),
		[{ name: "retry.md", claimed: true }],
	);
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

test("moves a crafted decoded traversal claim to failed without escaping evidence", async (t) => {
	const harness = await fixture();
	t.after(harness.cleanup);
	const unsafeName = "../../../escape.txt";
	const claimName = `.processing-${createHash("sha256").update(unsafeName).digest("hex").slice(0, 16)}-${Buffer.from(unsafeName, "utf8").toString("base64url")}`;
	await harness.dropbox.prepare();
	await fs.writeFile(path.join(harness.dropbox.paths.newDir, claimName), "unsafe claim");
	const work = (await harness.dropbox.listWork())[0]!;
	assert.equal(work.name, unsafeName);
	const claim = await harness.dropbox.claim(work);
	assert.ok(claim);
	await harness.dropbox.moveFailed(claim!, "invalid-filename");
	assert.equal(await fs.readFile(path.join(harness.dropbox.paths.failedDir, claimName), "utf8"), "unsafe claim");
	await assert.rejects(fs.access(path.join(harness.root, ".pi", "bebop", "escape.txt")));
	await assert.rejects(fs.access(path.join(harness.root, "escape.txt")));
});

async function replaceDirectoryWithSymlink(directory: string, outside: string): Promise<() => Promise<void>> {
	const realDirectory = `${directory}-real`;
	await fs.rename(directory, realDirectory);
	await fs.symlink(outside, directory);
	return async () => {
		await fs.unlink(directory);
		await fs.rename(realDirectory, directory);
	};
}

test("rejects replaced failed and processed directories without losing recoverable claims", async (t) => {
	const harness = await fixture();
	t.after(harness.cleanup);
	await harness.dropbox.prepare();
	const outside = path.join(harness.root, "outside");
	await fs.mkdir(outside);

	const failedName = "failed.md";
	await fs.writeFile(path.join(harness.dropbox.paths.newDir, failedName), "failed");
	const failedClaim = await harness.dropbox.claim((await harness.dropbox.listWork())[0]!);
	const restoreFailed = await replaceDirectoryWithSymlink(harness.dropbox.paths.failedDir, outside);
	await assert.rejects(
		harness.dropbox.moveFailed(failedClaim!, "invalid-content"),
		(error: unknown) => (error as { code?: string }).code === "unsafe-directory",
	);
	assert.deepEqual(await fs.readdir(outside), []);
	assert.equal(
		await fs.readFile(path.join(harness.dropbox.paths.newDir, path.basename(failedClaim!.path)), "utf8"),
		"failed",
	);
	await restoreFailed();
	await harness.dropbox.moveFailed(failedClaim!, "invalid-content");
	assert.equal(await fs.readFile(path.join(harness.dropbox.paths.failedDir, failedName), "utf8"), "failed");

	const processedName = "processed.md";
	await fs.writeFile(path.join(harness.dropbox.paths.newDir, processedName), "processed");
	const processedClaim = await harness.dropbox.claim((await harness.dropbox.listWork())[0]!);
	const restoreProcessed = await replaceDirectoryWithSymlink(harness.dropbox.paths.processedDir, outside);
	await assert.rejects(
		harness.dropbox.moveProcessed(processedClaim!),
		(error: unknown) => (error as { code?: string }).code === "unsafe-directory",
	);
	assert.deepEqual(await fs.readdir(outside), []);
	await restoreProcessed();
	await harness.dropbox.moveProcessed(processedClaim!);
	assert.equal(await fs.readFile(path.join(harness.dropbox.paths.processedDir, processedName), "utf8"), "processed");
});

test("rejects a replaced new directory during release and recovers the claim", async (t) => {
	const harness = await fixture();
	t.after(harness.cleanup);
	await harness.dropbox.prepare();
	const outside = path.join(harness.root, "outside");
	await fs.mkdir(outside);
	const name = "release.md";
	await fs.writeFile(path.join(harness.dropbox.paths.newDir, name), "release");
	const claim = await harness.dropbox.claim((await harness.dropbox.listWork())[0]!);
	const restore = await replaceDirectoryWithSymlink(harness.dropbox.paths.newDir, outside);
	await assert.rejects(
		harness.dropbox.release(claim!),
		(error: unknown) => (error as { code?: string }).code === "unsafe-directory",
	);
	assert.deepEqual(await fs.readdir(outside), []);
	await restore();
	await harness.dropbox.release(claim!);
	assert.equal(await fs.readFile(path.join(harness.dropbox.paths.newDir, name), "utf8"), "release");
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
