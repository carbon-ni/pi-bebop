import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	getDefaultCrewManifestPath,
	getCrewManifestPathFromSocketPath,
	isTrustedCrewManifestPath,
	readTrustedCrewManifest,
	CrewManifestReadError,
} from "./crew-manifest-store.ts";

let projectDir: string;

before(async () => {
	projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "intray-crew-"));
	await fs.mkdir(path.join(projectDir, ".pi", "bebop"), { recursive: true });
	await fs.writeFile(getDefaultCrewManifestPath(projectDir), JSON.stringify({
		version: 1,
		members: [{ name: "dev", role: "developer", socket: "sockets/dev.sock" }],
	}));
});

after(async () => fs.rm(projectDir, { recursive: true, force: true }));

describe("trusted crew manifest store", () => {
	test("uses Pi CONFIG_DIR_NAME for the project-local default", () => {
		assert.equal(getDefaultCrewManifestPath(projectDir), path.join(projectDir, ".pi", "bebop", "crew.json"));
		assert.equal(isTrustedCrewManifestPath(getDefaultCrewManifestPath(projectDir), projectDir), true);
		assert.equal(isTrustedCrewManifestPath(path.join(projectDir, "crew.json"), projectDir), false);
	});

	test("accepts the exact compatibility layout and selects by socket path", async () => {
	const legacyManifest = path.join(projectDir, ".pi", "crew", "crew.json");
	await fs.mkdir(path.dirname(legacyManifest), { recursive: true });
	await fs.writeFile(legacyManifest, JSON.stringify({ version: 1, members: [{ name: "legacy", role: "developer", socket: "sockets/legacy.sock" }] }));
	assert.equal(getCrewManifestPathFromSocketPath(path.join(projectDir, ".pi", "bebop", "sockets", "dev.sock")), getDefaultCrewManifestPath(projectDir));
	assert.equal(getCrewManifestPathFromSocketPath(path.join(projectDir, ".pi", "crew", "sockets", "legacy.sock")), legacyManifest);
	assert.equal(isTrustedCrewManifestPath(legacyManifest, projectDir), true);
	assert.equal((await readTrustedCrewManifest(legacyManifest, projectDir, () => true)).members[0].name, "legacy");
	await assert.rejects(() => readTrustedCrewManifest(path.join(projectDir, ".pi", "other", "crew.json"), projectDir, () => true), (error: unknown) => error instanceof CrewManifestReadError && error.code === "untrusted-path");
});
	test("keeps selected layout failures distinct and never falls back", async () => {
	const legacyManifest = path.join(projectDir, ".pi", "crew", "crew.json");
	await fs.rm(legacyManifest, { force: true });
	await assert.rejects(() => readTrustedCrewManifest(legacyManifest, projectDir, () => true), (error: unknown) => error instanceof CrewManifestReadError && error.code === "read-failed" && error.message.includes(legacyManifest));
	await fs.writeFile(legacyManifest, "{ nope");
	await assert.rejects(() => readTrustedCrewManifest(legacyManifest, projectDir, () => true), (error: unknown) => error instanceof CrewManifestReadError && error.code === "invalid-json");
	await fs.writeFile(legacyManifest, JSON.stringify({ version: 1, members: [] }));
	await assert.rejects(() => readTrustedCrewManifest(legacyManifest, projectDir, () => true), (error: unknown) => error instanceof Error && error.message.includes("members must be a non-empty array"));
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
