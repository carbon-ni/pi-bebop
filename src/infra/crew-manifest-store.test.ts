import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	getDefaultCrewManifestPath,
	isTrustedCrewManifestPath,
	readTrustedCrewManifest,
	CrewManifestReadError,
} from "./crew-manifest-store.ts";

let projectDir: string;

before(async () => {
	projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "intray-crew-"));
	await fs.mkdir(path.join(projectDir, ".pi", "intray"), { recursive: true });
	await fs.writeFile(getDefaultCrewManifestPath(projectDir), JSON.stringify({
		version: 1,
		members: [{ name: "dev", role: "developer", socket: "sockets/dev.sock" }],
	}));
});

after(async () => fs.rm(projectDir, { recursive: true, force: true }));

describe("trusted crew manifest store", () => {
	test("uses Pi CONFIG_DIR_NAME for the project-local default", () => {
		assert.equal(getDefaultCrewManifestPath(projectDir), path.join(projectDir, ".pi", "intray", "crew.json"));
		assert.equal(isTrustedCrewManifestPath(getDefaultCrewManifestPath(projectDir), projectDir), true);
		assert.equal(isTrustedCrewManifestPath(path.join(projectDir, "crew.json"), projectDir), false);
	});

	test("reads and parses only the trusted project-local manifest", async () => {
		const manifest = await readTrustedCrewManifest(getDefaultCrewManifestPath(projectDir), projectDir, () => true);
		assert.equal(manifest.members[0].role, "developer");
		await assert.rejects(
			() => readTrustedCrewManifest(path.join(projectDir, "crew.json"), projectDir, () => true),
			(error: unknown) => error instanceof CrewManifestReadError && error.code === "untrusted-path",
		);
	});

	test("rejects an untrusted project before attempting manifest IO", async () => {
		let reads = 0;
		await assert.rejects(
			() => readTrustedCrewManifest(getDefaultCrewManifestPath(projectDir), projectDir, () => false, async () => {
				reads += 1;
				return "{}";
			}),
			(error: unknown) => error instanceof CrewManifestReadError && error.code === "untrusted-project",
		);
		assert.equal(reads, 0);
	});
});
