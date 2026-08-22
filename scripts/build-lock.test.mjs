import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { acquireBuildLock } from "./build-lock.mjs";
import { atomicSwapDirectory } from "./build-swap.mjs";

const temp = () => mkdtemp(join("/tmp", "bebop-build-test-"));

test("recovers stale ownerless locks and cleans ownership", async () => {
	const root = await temp();
	const lock = join(root, "lock");
	await mkdir(lock);
	const stale = new Date(Date.now() - 10_000);
	await utimes(lock, stale, stale);
	const release = await acquireBuildLock(lock, { staleMs: 1, timeoutMs: 100 });
	assert.equal((await readFile(join(lock, "owner"), "utf8")).split("\n")[0], String(process.pid));
	await release();
	await assert.rejects(() => readFile(lock), { code: "ENOENT" });
	await rm(root, { recursive: true, force: true });
});

test("recovers malformed partial owner locks after grace", async () => {
	const root = await temp();
	const lock = join(root, "lock");
	await mkdir(lock);
	await writeFile(join(lock, "owner"), "123\nbad\n");
	const stale = new Date(Date.now() - 10_000);
	await utimes(lock, stale, stale);
	const release = await acquireBuildLock(lock, { staleMs: 1, timeoutMs: 100 });
	await release();
	await rm(root, { recursive: true, force: true });
});

test("waits for fresh ownerless locks instead of stealing initialization", async () => {
	const root = await temp();
	const lock = join(root, "lock");
	await mkdir(lock);
	await assert.rejects(() => acquireBuildLock(lock, { timeoutMs: 10, staleMs: 100_000, pollMs: 1 }), /Timed out/);
	await rm(root, { recursive: true, force: true });
});

test("times out a live lock and surfaces non-lock errors", async () => {
	const root = await temp();
	const lock = join(root, "lock");
	await mkdir(lock);
	await writeFile(join(lock, "owner"), `${process.pid}\n${Date.now()}\n`);
	await assert.rejects(() => acquireBuildLock(lock, { timeoutMs: 10, pollMs: 1 }), /Timed out/);
	await assert.rejects(() => acquireBuildLock(join(root, "missing", "lock"), { timeoutMs: 10 }), { code: "ENOENT" });
	await rm(root, { recursive: true, force: true });
});

test("restores the previous dist when atomic swap cannot install staging", async () => {
	const root = await temp();
	const dist = join(root, "dist");
	const staging = join(root, "staging");
	const backup = join(root, "backup");
	await mkdir(dist);
	await mkdir(staging);
	await writeFile(join(dist, "sentinel"), "old");
	await rm(staging, { recursive: true, force: true });
	await assert.rejects(() => atomicSwapDirectory(staging, dist, backup));
	assert.equal(await readFile(join(dist, "sentinel"), "utf8"), "old");
	await rm(root, { recursive: true, force: true });
});

test("does not claim a recovery backup when no previous dist existed", async () => {
	const root = await temp();
	const dist = join(root, "dist");
	const staging = join(root, "staging");
	const backup = join(root, "backup");
	await mkdir(staging);
	let renameCount = 0;
	const failingRename = async () => {
		renameCount += 1;
		if (renameCount === 1) throw Object.assign(new Error("missing dist"), { code: "ENOENT" });
		throw Object.assign(new Error("install failed"), { code: "EIO" });
	};
	await assert.rejects(() => atomicSwapDirectory(staging, dist, backup, { rename: failingRename }), /install failed/);
	await assert.rejects(() => readFile(backup), { code: "ENOENT" });
	await rm(root, { recursive: true, force: true });
});

test("retains a recovery backup when rollback itself fails", async () => {
	const root = await temp();
	const dist = join(root, "dist");
	const staging = join(root, "staging");
	const backup = join(root, "backup");
	await mkdir(dist);
	await mkdir(staging);
	await writeFile(join(dist, "sentinel"), "old");
	let renameCount = 0;
	const failingRename = async (from, to) => {
		renameCount += 1;
		if (renameCount === 1) return rename(from, to);
		throw Object.assign(new Error("rename failed"), { code: "EIO" });
	};
	await assert.rejects(
		() => atomicSwapDirectory(staging, dist, backup, { rename: failingRename }),
		/recovery backup retained/,
	);
	assert.equal(renameCount, 3);
	assert.equal(await readFile(join(backup, "sentinel"), "utf8"), "old");
	await assert.rejects(() => readFile(staging), { code: "ENOENT" });
	await rm(root, { recursive: true, force: true });
});
