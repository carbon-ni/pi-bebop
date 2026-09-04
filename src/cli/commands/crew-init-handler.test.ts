import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCrewInitCommand } from "./crew-init-handler.ts";
import { crewInitHelp } from "../../domain/index.ts";

test("crew init --help returns deterministic local help with zero IO", async () => {
	const outcome = await runCrewInitCommand({ command: "crew-init", format: "toon", help: true }, "/project");
	assert.equal(outcome.kind, "help");
	if (outcome.kind !== "help") return;
	assert.equal(outcome.text, crewInitHelp());
});

test("crew init creates a fresh canonical scaffold with created status", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "bebop-init-handler-"));
	try {
		const outcome = await runCrewInitCommand({ command: "crew-init", format: "json" }, dir);
		assert.equal(outcome.kind, "result");
		if (outcome.kind !== "result") return;
		assert.equal(outcome.result.ok, true);
		assert.equal(outcome.result.status, "created");
		assert.equal(outcome.format, "json");
		const data = outcome.result.data as Record<string, unknown>;
		assert.equal(data.manifestPath, ".pi/bebop/crew.json");
		assert.ok((data.createdPaths as string[]).includes(".pi/bebop/crew.json"));
		const manifest = JSON.parse(await readFileText(path.join(dir, ".pi/bebop/crew.json")));
		assert.equal(manifest.version, 2);
		assert.equal(manifest.commonInstructionsFile, "instructions/common.md");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("crew init exact rerun is unchanged with zero writes", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "bebop-init-handler-"));
	try {
		await runCrewInitCommand({ command: "crew-init", format: "json" }, dir);
		const outcome = await runCrewInitCommand({ command: "crew-init", format: "json" }, dir);
		assert.equal(outcome.kind, "result");
		if (outcome.kind !== "result") return;
		assert.equal(outcome.result.status, "unchanged");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("crew init conflict leaves user content untouched and reports managed-file-differs", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "bebop-init-handler-"));
	try {
		await mkdir(path.join(dir, ".pi/bebop"), { recursive: true });
		const userManifest = '{"version":999}';
		await writeFile(path.join(dir, ".pi/bebop/crew.json"), userManifest);
		const outcome = await runCrewInitCommand({ command: "crew-init", format: "json" }, dir);
		assert.equal(outcome.kind, "result");
		if (outcome.kind !== "result") return;
		assert.equal(outcome.result.ok, false);
		assert.equal(outcome.result.error?.code, "managed-file-differs");
		assert.equal(await readFileText(path.join(dir, ".pi/bebop/crew.json")), userManifest);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("crew init operational failure reports a stable operational code", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "bebop-init-handler-"));
	try {
		// A file where a project root is expected forces a filesystem failure.
		const file = path.join(dir, "not-a-directory");
		await writeFile(file, "x");
		const outcome = await runCrewInitCommand({ command: "crew-init", format: "json" }, file);
		assert.equal(outcome.kind, "result");
		if (outcome.kind !== "result") return;
		assert.equal(outcome.result.ok, false);
		assert.equal(outcome.result.status, "error");
		assert.equal(outcome.result.error?.code, "operational");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

async function readFileText(filePath: string): Promise<string> {
	return (await import("node:fs/promises")).readFile(filePath, "utf8");
}
