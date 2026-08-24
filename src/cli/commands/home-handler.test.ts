import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runHomeCommand } from "./home-handler.ts";

test("home reports missing scaffold with crew init next command", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "bebop-home-"));
	try {
		const outcome = await runHomeCommand(dir, ["send", "crew init"], { HOME: "/fake" }, "/fake/pi-bebop");
		assert.equal(outcome.kind, "result");
		if (outcome.kind !== "result") return;
		assert.equal(outcome.result.status, "home");
		assert.equal(outcome.result.ok, true);
		assert.equal(outcome.format, "toon");
		const data = outcome.result.data as Record<string, unknown>;
		assert.equal(data.executable, "~/pi-bebop");
		assert.equal(data.project, dir);
		assert.equal(data.scaffold, "missing");
		assert.equal(data.next, "pi-bebop crew init");
		assert.deepEqual(data.commands, ["send", "crew init"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("home falls back to executable name and preserves paths without HOME", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "bebop-home-"));
	try {
		const outcome = await runHomeCommand(dir, [], {}, "");
		if (outcome.kind !== "result") return;
		const data = outcome.result.data as Record<string, unknown>;
		assert.equal(data.executable, "pi-bebop");
		assert.equal(data.project, dir);
		assert.equal(data.scaffold, "missing");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("home reports present scaffold with socket next command", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "bebop-home-"));
	try {
		await mkdir(path.join(dir, ".pi/bebop"), { recursive: true });
		await writeFile(path.join(dir, ".pi/bebop/crew.json"), "{}");
		const outcome = await runHomeCommand(dir, ["send", "crew init"], { HOME: "/fake" }, "/fake/pi-bebop");
		assert.equal(outcome.kind, "result");
		if (outcome.kind !== "result") return;
		const data = outcome.result.data as Record<string, unknown>;
		assert.equal(data.scaffold, "present");
		assert.equal(data.next, "pi --crew-role lead");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
