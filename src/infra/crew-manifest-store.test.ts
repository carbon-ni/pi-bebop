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
	selectCrewSocketPath,
	CrewManifestReadError,
	MAX_CREW_INSTRUCTIONS_FILE_BYTES,
} from "./crew-manifest-store.ts";

let projectDir: string;

before(async () => {
	projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "intray-crew-"));
	await fs.mkdir(path.join(projectDir, ".pi", "bebop"), { recursive: true });
	await fs.writeFile(
		getDefaultCrewManifestPath(projectDir),
		JSON.stringify({
			version: 1,
			members: [{ name: "dev", role: "developer", socket: "sockets/dev.sock" }],
		}),
	);
});

after(async () => fs.rm(projectDir, { recursive: true, force: true }));

describe("trusted crew manifest store", { concurrency: false }, () => {
	test("selects an absolute external-root endpoint without cwd fallback", () => {
		const rootA = path.join(projectDir, "worktree-A");
		const rootB = path.join(projectDir, "worktree-B");
		assert.deepEqual(selectCrewSocketPath(`${rootB}/.pi/bebop/sockets/dev1.sock`, rootA), {
			socketPath: `${rootB}/.pi/bebop/sockets/dev1.sock`,
			manifestPath: `${rootB}/.pi/bebop/crew.json`,
		});
		assert.equal(selectCrewSocketPath(`${rootB}/.pi/other/sockets/dev1.sock`, rootA), null);
		assert.equal(selectCrewSocketPath(`${rootB}/.pi/bebop/sockets/../dev1.sock`, rootA), null);
	});

	test("uses Pi CONFIG_DIR_NAME for the project-local default", () => {
		assert.equal(getDefaultCrewManifestPath(projectDir), path.join(projectDir, ".pi", "bebop", "crew.json"));
		assert.equal(isTrustedCrewManifestPath(getDefaultCrewManifestPath(projectDir), projectDir), true);
		assert.equal(isTrustedCrewManifestPath(path.join(projectDir, "crew.json"), projectDir), false);
	});

	test("accepts the exact compatibility layout and selects by socket path", async () => {
		const legacyManifest = path.join(projectDir, ".pi", "crew", "crew.json");
		await fs.mkdir(path.dirname(legacyManifest), { recursive: true });
		await fs.writeFile(
			legacyManifest,
			JSON.stringify({
				version: 1,
				members: [{ name: "legacy", role: "developer", socket: "sockets/legacy.sock" }],
			}),
		);
		assert.equal(
			getCrewManifestPathFromSocketPath(path.join(projectDir, ".pi", "bebop", "sockets", "dev.sock")),
			getDefaultCrewManifestPath(projectDir),
		);
		assert.equal(
			getCrewManifestPathFromSocketPath(path.join(projectDir, ".pi", "crew", "sockets", "legacy.sock")),
			legacyManifest,
		);
		assert.equal(isTrustedCrewManifestPath(legacyManifest, projectDir), true);
		assert.equal((await readTrustedCrewManifest(legacyManifest, projectDir, () => true)).members[0].name, "legacy");
		await assert.rejects(
			() => readTrustedCrewManifest(path.join(projectDir, ".pi", "other", "crew.json"), projectDir, () => true),
			(error: unknown) => error instanceof CrewManifestReadError && error.code === "untrusted-path",
		);
	});
	test("keeps selected layout failures distinct and never falls back", async () => {
		const legacyManifest = path.join(projectDir, ".pi", "crew", "crew.json");
		await fs.rm(legacyManifest, { force: true });
		await assert.rejects(
			() => readTrustedCrewManifest(legacyManifest, projectDir, () => true),
			(error: unknown) =>
				error instanceof CrewManifestReadError &&
				error.code === "read-failed" &&
				error.message.includes(legacyManifest),
		);
		await fs.writeFile(legacyManifest, "{ nope");
		await assert.rejects(
			() => readTrustedCrewManifest(legacyManifest, projectDir, () => true),
			(error: unknown) => error instanceof CrewManifestReadError && error.code === "invalid-json",
		);
		await fs.writeFile(legacyManifest, JSON.stringify({ version: 1, members: [] }));
		await assert.rejects(
			() => readTrustedCrewManifest(legacyManifest, projectDir, () => true),
			(error: unknown) => error instanceof Error && error.message.includes("members must be a non-empty array"),
		);
	});

	test("loads valid file-backed instructions and preserves markdown", async () => {
		const instructionsDir = path.join(projectDir, ".pi", "bebop", "instructions");
		await fs.mkdir(instructionsDir, { recursive: true });
		await fs.writeFile(path.join(instructionsDir, "dev.md"), "# Role\n\nUnicode: café 🚀\n");
		await fs.writeFile(
			getDefaultCrewManifestPath(projectDir),
			JSON.stringify({
				version: 1,
				members: [
					{
						name: "dev",
						role: "developer",
						socket: "sockets/dev.sock",
						instructionsFile: "instructions/dev.md",
					},
				],
			}),
		);
		const manifest = await readTrustedCrewManifest(getDefaultCrewManifestPath(projectDir), projectDir, () => true);
		assert.equal(manifest.members[0].instructions, "# Role\n\nUnicode: café 🚀\n");
		assert.equal(manifest.members[0].instructionsFile, undefined);
	});

	test("loads one common snapshot for every member, including a member without role instructions", async () => {
		const crewDir = path.join(projectDir, ".pi", "bebop");
		const instructionsDir = path.join(crewDir, "instructions");
		await fs.mkdir(instructionsDir, { recursive: true });
		await fs.writeFile(path.join(instructionsDir, "common.md"), "COMMON-SNAPSHOT\\n");
		await fs.writeFile(path.join(instructionsDir, "dev.md"), "ROLE-SNAPSHOT\\n");
		const manifest = getDefaultCrewManifestPath(projectDir);
		await fs.writeFile(
			manifest,
			JSON.stringify({
				version: 2,
				commonInstructionsFile: "instructions/common.md",
				members: [
					{
						name: "dev",
						role: "developer",
						socket: "sockets/dev.sock",
						instructionsFile: "instructions/dev.md",
					},
					{ name: "qa", role: "quality", socket: "sockets/qa.sock" },
				],
			}),
		);
		const loaded = await readTrustedCrewManifest(manifest, projectDir, () => true);
		assert.equal(loaded.commonInstructions, "COMMON-SNAPSHOT\\n");
		assert.equal(loaded.commonInstructionsFile, undefined);
		assert.equal(loaded.members[0].instructions, "ROLE-SNAPSHOT\\n");
		assert.equal(loaded.members[1].instructions, undefined);
	});

	test("common file failures name commonInstructionsFile and fail closed", async () => {
		const crewDir = path.join(projectDir, ".pi", "bebop");
		const instructionsDir = path.join(crewDir, "instructions");
		await fs.mkdir(instructionsDir, { recursive: true });
		const manifest = getDefaultCrewManifestPath(projectDir);
		await fs.writeFile(
			manifest,
			JSON.stringify({
				version: 2,
				commonInstructionsFile: "instructions/common.md",
				members: [{ name: "dev", role: "developer", socket: "sockets/dev.sock" }],
			}),
		);
		await fs.writeFile(
			path.join(instructionsDir, "common.md"),
			Buffer.alloc(MAX_CREW_INSTRUCTIONS_FILE_BYTES + 1, 97),
		);
		await assert.rejects(
			() => readTrustedCrewManifest(manifest, projectDir, () => true),
			(error: unknown) =>
				error instanceof CrewManifestReadError &&
				error.code === "common-instructions-file-oversized" &&
				error.message.includes("commonInstructionsFile"),
		);
		await fs.writeFile(path.join(instructionsDir, "common.md"), "\0");
		await assert.rejects(
			() => readTrustedCrewManifest(manifest, projectDir, () => true),
			(error: unknown) =>
				error instanceof CrewManifestReadError &&
				error.code === "common-instructions-file-nul" &&
				error.message.includes("commonInstructionsFile"),
		);
		await fs.rm(path.join(instructionsDir, "common.md"));
		await assert.rejects(
			() => readTrustedCrewManifest(manifest, projectDir, () => true),
			(error: unknown) =>
				error instanceof CrewManifestReadError &&
				error.code === "common-instructions-file-missing" &&
				error.message.includes("commonInstructionsFile"),
		);
		await fs.writeFile(
			manifest,
			JSON.stringify({ version: 1, members: [{ name: "dev", role: "developer", socket: "sockets/dev.sock" }] }),
		);
	});

	test("rejects escaping and invalid instruction files without exposing content", async () => {
		const crewDir = path.join(projectDir, ".pi", "bebop");
		await fs.rm(path.join(crewDir, "instructions"), { recursive: true, force: true });
		await fs.symlink(path.join(projectDir, "outside"), path.join(crewDir, "instructions"));
		await fs.mkdir(path.join(projectDir, "outside"), { recursive: true });
		await fs.writeFile(path.join(projectDir, "outside", "dev.md"), "secret");
		await fs.writeFile(
			getDefaultCrewManifestPath(projectDir),
			JSON.stringify({
				version: 1,
				members: [
					{
						name: "dev",
						role: "developer",
						socket: "sockets/dev.sock",
						instructionsFile: "instructions/dev.md",
					},
				],
			}),
		);
		await assert.rejects(
			() => readTrustedCrewManifest(getDefaultCrewManifestPath(projectDir), projectDir, () => true),
			(error: unknown) =>
				error instanceof CrewManifestReadError &&
				error.code === "instructions-file-unsafe" &&
				!error.message.includes("secret"),
		);
		await fs.rm(path.join(crewDir, "instructions"), { recursive: true, force: true });
		await fs.mkdir(path.join(crewDir, "instructions"), { recursive: true });
		await fs.writeFile(
			getDefaultCrewManifestPath(projectDir),
			JSON.stringify({ version: 1, members: [{ name: "dev", role: "developer", socket: "sockets/dev.sock" }] }),
		);
	});

	test("reports safe distinct instruction-file failures and enforces the byte boundary", async () => {
		const crewDir = path.join(projectDir, ".pi", "bebop");
		const instructionsDir = path.join(crewDir, "instructions");
		await fs.mkdir(instructionsDir, { recursive: true });
		const manifest = getDefaultCrewManifestPath(projectDir);
		const writeManifest = async () =>
			fs.writeFile(
				manifest,
				JSON.stringify({
					version: 1,
					members: [
						{
							name: "dev",
							role: "developer",
							socket: "sockets/dev.sock",
							instructionsFile: "instructions/dev.md",
						},
					],
				}),
			);
		await writeManifest();
		await fs.writeFile(path.join(instructionsDir, "dev.md"), Buffer.alloc(MAX_CREW_INSTRUCTIONS_FILE_BYTES, 97));
		assert.equal(
			(await readTrustedCrewManifest(manifest, projectDir, () => true)).members[0].instructions?.length,
			MAX_CREW_INSTRUCTIONS_FILE_BYTES,
		);
		await fs.writeFile(
			path.join(instructionsDir, "dev.md"),
			Buffer.alloc(MAX_CREW_INSTRUCTIONS_FILE_BYTES + 1, 97),
		);
		await assert.rejects(
			() => readTrustedCrewManifest(manifest, projectDir, () => true),
			(error: unknown) => error instanceof CrewManifestReadError && error.code === "instructions-file-oversized",
		);
		await fs.writeFile(path.join(instructionsDir, "dev.md"), Buffer.from([0xc3]));
		await assert.rejects(
			() => readTrustedCrewManifest(manifest, projectDir, () => true),
			(error: unknown) =>
				error instanceof CrewManifestReadError &&
				error.code === "instructions-file-invalid-encoding" &&
				!error.message.includes("\uFFFD"),
		);
		await fs.writeFile(path.join(instructionsDir, "dev.md"), "   \n");
		await assert.rejects(
			() => readTrustedCrewManifest(manifest, projectDir, () => true),
			(error: unknown) => error instanceof CrewManifestReadError && error.code === "instructions-file-empty",
		);
		await fs.writeFile(path.join(instructionsDir, "dev.md"), "ok\0bad");
		await assert.rejects(
			() => readTrustedCrewManifest(manifest, projectDir, () => true),
			(error: unknown) => error instanceof CrewManifestReadError && error.code === "instructions-file-nul",
		);
		await fs.writeFile(path.join(instructionsDir, "dev.md"), "restored\n");
		await fs.writeFile(
			manifest,
			JSON.stringify({ version: 1, members: [{ name: "dev", role: "developer", socket: "sockets/dev.sock" }] }),
		);
	});

	test("reports directories distinctly from unreadable files", async () => {
		const instructionsDir = path.join(projectDir, ".pi", "bebop", "instructions");
		await fs.mkdir(path.join(instructionsDir, "dir"), { recursive: true });
		await fs.writeFile(
			getDefaultCrewManifestPath(projectDir),
			JSON.stringify({
				version: 1,
				members: [
					{
						name: "dev",
						role: "developer",
						socket: "sockets/dev.sock",
						instructionsFile: "instructions/dir",
					},
				],
			}),
		);
		await assert.rejects(
			() => readTrustedCrewManifest(getDefaultCrewManifestPath(projectDir), projectDir, () => true),
			(error: unknown) => error instanceof CrewManifestReadError && error.code === "instructions-file-directory",
		);
		await fs.writeFile(
			getDefaultCrewManifestPath(projectDir),
			JSON.stringify({ version: 1, members: [{ name: "dev", role: "developer", socket: "sockets/dev.sock" }] }),
		);
	});

	test("reports a missing referenced instruction file", async () => {
		await fs.writeFile(
			getDefaultCrewManifestPath(projectDir),
			JSON.stringify({
				version: 1,
				members: [
					{
						name: "dev",
						role: "developer",
						socket: "sockets/dev.sock",
						instructionsFile: "instructions/missing.md",
					},
				],
			}),
		);
		await assert.rejects(
			() => readTrustedCrewManifest(getDefaultCrewManifestPath(projectDir), projectDir, () => true),
			(error: unknown) =>
				error instanceof CrewManifestReadError &&
				error.code === "instructions-file-missing" &&
				!error.message.includes("ENOENT"),
		);
		await fs.writeFile(
			getDefaultCrewManifestPath(projectDir),
			JSON.stringify({ version: 1, members: [{ name: "dev", role: "developer", socket: "sockets/dev.sock" }] }),
		);
	});

	test("reports an injected instruction read failure without permission-dependent setup", async () => {
		const instructionsDir = path.join(projectDir, ".pi", "bebop", "instructions");
		await fs.mkdir(instructionsDir, { recursive: true });
		await fs.writeFile(path.join(instructionsDir, "dev.md"), "valid\n");
		await fs.writeFile(
			getDefaultCrewManifestPath(projectDir),
			JSON.stringify({
				version: 1,
				members: [
					{
						name: "dev",
						role: "developer",
						socket: "sockets/dev.sock",
						instructionsFile: "instructions/dev.md",
					},
				],
			}),
		);
		await assert.rejects(
			() =>
				readTrustedCrewManifest(
					getDefaultCrewManifestPath(projectDir),
					projectDir,
					() => true,
					undefined,
					async () => {
						throw new Error("simulated read failure");
					},
				),
			(error: unknown) =>
				error instanceof CrewManifestReadError &&
				error.code === "instructions-file-unreadable" &&
				!error.message.includes("simulated"),
		);
		await fs.writeFile(
			getDefaultCrewManifestPath(projectDir),
			JSON.stringify({ version: 1, members: [{ name: "dev", role: "developer", socket: "sockets/dev.sock" }] }),
		);
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
			() =>
				readTrustedCrewManifest(
					getDefaultCrewManifestPath(projectDir),
					projectDir,
					() => false,
					async () => {
						reads += 1;
						return "{}";
					},
				),
			(error: unknown) => error instanceof CrewManifestReadError && error.code === "untrusted-project",
		);
		assert.equal(reads, 0);
	});
});
