import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createCallerConsentManifestLoader } from "./crew-intake-reader.ts";
import { CrewManifestReadError } from "./crew-manifest-store.ts";

const writeManifest = async (manifestPath: string, input: unknown) => {
	await fs.mkdir(path.dirname(manifestPath), { recursive: true });
	await fs.writeFile(manifestPath, JSON.stringify(input), "utf8");
};

const manifestInput = {
	version: 1,
	name: "Beta Crew",
	members: [{ name: "Kelly", role: "qa", socket: "sockets/qa.sock" }],
	intake: { contact: "Kelly" },
};

describe("createCallerConsentManifestLoader", () => {
	test("loads readable exact-layout manifests for both supported layouts", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-intake-reader-"));
		try {
			for (const layout of ["bebop", "crew"]) {
				const manifestPath = path.join(root, layout, `.pi/${layout}/crew.json`);
				await writeManifest(manifestPath, manifestInput);
				const loader = createCallerConsentManifestLoader();
				const manifest = await loader(manifestPath);
				assert.equal(manifest.intake?.contact, "Kelly");
				assert.equal(manifest.name, "Beta Crew");
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("rejects paths outside the exact supported layouts before reading", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-intake-reader-"));
		try {
			const manifestPath = path.join(root, "beta/.pi/other/crew.json");
			await writeManifest(manifestPath, manifestInput);
			await assert.rejects(
				() => createCallerConsentManifestLoader()(manifestPath),
				(error: unknown) => {
					assert.ok(error instanceof CrewManifestReadError);
					assert.equal(error.code, "untrusted-path");
					return true;
				},
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("rejects a symlinked layout that escapes to a foreign project layout", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-intake-reader-"));
		try {
			const foreignManifest = path.join(root, "foreign", ".pi/bebop/crew.json");
			await writeManifest(foreignManifest, manifestInput);
			await fs.mkdir(path.join(root, "beta", ".pi"), { recursive: true });
			await fs.symlink(path.join(root, "foreign", ".pi/bebop"), path.join(root, "beta", ".pi/crew"), "dir");
			await assert.rejects(
				() => createCallerConsentManifestLoader()(path.join(root, "beta", ".pi/crew/crew.json")),
				(error: unknown) => {
					assert.ok(error instanceof CrewManifestReadError);
					assert.equal(error.code, "untrusted-path");
					assert.match(error.message, /symlink/);
					return true;
				},
			);
			assert.equal(
				await fs.readFile(foreignManifest, "utf8"),
				JSON.stringify(manifestInput),
				"foreign manifest untouched",
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("accepts a same-project layout symlink alias without escaping the project", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-intake-reader-"));
		try {
			const realManifest = path.join(root, "beta", ".pi/bebop/crew.json");
			await writeManifest(realManifest, manifestInput);
			await fs.symlink(path.join(root, "beta", ".pi/bebop"), path.join(root, "beta", ".pi/crew"), "dir");
			const manifest = await createCallerConsentManifestLoader()(path.join(root, "beta", ".pi/crew/crew.json"));
			assert.equal(manifest.intake?.contact, "Kelly");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("maps unreadable files and invalid JSON to stable codes", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-intake-reader-"));
		try {
			const loader = createCallerConsentManifestLoader();
			await assert.rejects(
				() => loader(path.join(root, "beta/.pi/crew/crew.json")),
				(error: unknown) => {
					assert.ok(error instanceof CrewManifestReadError);
					assert.equal(error.code, "read-failed");
					return true;
				},
			);
			const manifestPath = path.join(root, "beta/.pi/crew/crew.json");
			await fs.mkdir(path.dirname(manifestPath), { recursive: true });
			await fs.writeFile(manifestPath, "not json", "utf8");
			await assert.rejects(
				() => loader(manifestPath),
				(error: unknown) => {
					assert.ok(error instanceof CrewManifestReadError);
					assert.equal(error.code, "invalid-json");
					return true;
				},
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
