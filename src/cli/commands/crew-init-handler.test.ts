import assert from "node:assert/strict";
import test from "node:test";
import { decode } from "@toon-format/toon";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCrewInitCommand } from "./crew-init-handler.ts";
import { crewInitHelp } from "../../domain/index.ts";
import { renderCliResult } from "../output.ts";

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
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("crew init --from adopts a local template and redacts absolute provenance", async () => {
	const target = await mkdtemp(path.join(tmpdir(), "bebop-init-target-"));
	const source = path.join(target, "vendored", "team.git");
	try {
		await mkdir(path.join(source, "instructions"), { recursive: true });
		await writeFile(
			path.join(source, "crew.json"),
			JSON.stringify({
				version: 1,
				members: [
					{
						name: "captain",
						role: "lead",
						socket: "sockets/captain.sock",
						instructionsFile: "instructions/captain.md",
					},
				],
			}),
		);
		await writeFile(path.join(source, "instructions/captain.md"), "# Captain\n");
		const outcome = await runCrewInitCommand(
			{ command: "crew-init", project: target, from: "vendored/team.git", format: "json" },
			target,
		);
		assert.equal(outcome.kind, "result");
		if (outcome.kind !== "result") return;
		assert.equal(outcome.result.ok, true);
		const data = outcome.result.data as { source?: { type: string; location: string } };
		assert.deepEqual(data.source, { type: "local", location: "vendored/team.git" });
		assert.ok(!path.isAbsolute(data.source?.location ?? ""));
		assert.equal(await readFileText(path.join(target, ".pi/bebop/instructions/captain.md")), "# Captain\n");
	} finally {
		await rm(target, { recursive: true, force: true });
		await rm(source, { recursive: true, force: true });
	}
});

test("crew init --from text output includes provenance for created and unchanged", async () => {
	const target = await mkdtemp(path.join(tmpdir(), "bebop-init-text-target-"));
	const source = path.join(target, "template");
	try {
		await mkdir(path.join(source, "instructions"), { recursive: true });
		await writeFile(
			path.join(source, "crew.json"),
			JSON.stringify({
				version: 1,
				members: [
					{
						name: "captain",
						role: "lead",
						socket: "sockets/captain.sock",
						instructionsFile: "instructions/captain.md",
					},
				],
			}),
		);
		await writeFile(path.join(source, "instructions/captain.md"), "# Captain\n");
		const options = { command: "crew-init" as const, project: target, from: "template", format: "text" as const };
		const created = await runCrewInitCommand(options, target);
		const unchanged = await runCrewInitCommand(options, target);
		assert.equal(created.kind, "result");
		assert.equal(unchanged.kind, "result");
		if (created.kind === "result" && unchanged.kind === "result") {
			assert.match(renderCliResult(created.result, "text", false), /Scaffolded[\s\S]*Source: local template$/);
			assert.match(
				renderCliResult(unchanged.result, "text", false),
				/byte-identical[\s\S]*Source: local template$/,
			);
		}
	} finally {
		await rm(target, { recursive: true, force: true });
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
		assert.equal(outcome.result.error?.code, "unexpected-failure");
		assert.equal(outcome.result.target, "");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("crew init unknown filesystem failures are safe in text, JSON, and TOON", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "bebop-init-handler-"));
	try {
		const file = path.join(dir, "not-a-directory");
		await writeFile(file, "x");
		for (const format of ["text", "json", "toon"] as const) {
			const outcome = await runCrewInitCommand({ command: "crew-init", format }, file);
			assert.equal(outcome.kind, "result");
			if (outcome.kind !== "result") continue;
			const rendered = renderCliResult(outcome.result, format, false);
			assert.equal(rendered.includes("ENOTDIR"), false);
			assert.equal(rendered.includes("not-a-directory"), false);
			assert.equal(rendered.includes("bebop-init-handler-"), false);
			if (format === "json") assert.equal(JSON.parse(rendered).target, "");
			if (format === "toon") assert.equal((decode(rendered) as { target: string }).target, "");
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

async function readFileText(filePath: string): Promise<string> {
	return (await import("node:fs/promises")).readFile(filePath, "utf8");
}
