import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireBuildLock } from "./build-lock.mjs";
import { atomicSwapDirectory } from "./build-swap.mjs";

const temp = () => mkdtemp(join("/tmp", "bebop-build-test-"));

test("recovers stale dead-owner locks and cleans ownership", async () => {
	const root = await temp();
	const lock = join(root, "lock");
	await import("node:fs/promises").then(({ mkdir }) => mkdir(lock));
	await writeFile(join(lock, "owner"), "999999\n1\n");
	const release = await acquireBuildLock(lock, { staleMs: 1, timeoutMs: 100 });
	assert.equal((await readFile(join(lock, "owner"), "utf8")).split("\n")[0], String(process.pid));
	await release();
	await assert.rejects(() => readFile(lock), { code: "ENOENT" });
	await rm(root, { recursive: true, force: true });
});

test("times out a live lock and surfaces non-lock errors", async () => {
	const root = await temp();
	const lock = join(root, "lock");
	await import("node:fs/promises").then(({ mkdir }) => mkdir(lock));
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
	await import("node:fs/promises").then(async ({ mkdir }) => {
		await mkdir(dist);
		await mkdir(staging);
	});
	await writeFile(join(dist, "sentinel"), "old");
	await rm(staging, { recursive: true, force: true });
	await assert.rejects(() => atomicSwapDirectory(staging, dist, backup));
	assert.equal(await readFile(join(dist, "sentinel"), "utf8"), "old");
	await rm(root, { recursive: true, force: true });
});
