import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { CliContext } from "../support/context.ts";
import { defaultCrewListDependencies, runCrewListCommand, type CrewListCliOptions } from "./crew-list.ts";

function context(cwd: string): CliContext {
	return {
		cwd,
		input: process.stdin,
		output: process.stdout,
		signal: new AbortController().signal,
		environment: {},
	};
}

const options: CrewListCliOptions = { command: "crew-list", format: "json", full: true };

test("crew list reads supported manifests through the trusted filesystem boundary", async () => {
	const projectRoot = await mkdtemp(path.join(tmpdir(), "bebop-crew-list-"));
	const manifestPath = path.join(projectRoot, ".pi", "bebop", "crew.json");
	try {
		await mkdir(path.dirname(manifestPath), { recursive: true });
		await writeFile(
			manifestPath,
			JSON.stringify({
				version: 1,
				crew: { id: "alpha", displayName: "Alpha" },
				members: [{ name: "Alice", role: "developer", socket: "sockets/alice.sock" }],
				presence: { notifications: true },
			}),
		);
		const deps = {
			...defaultCrewListDependencies,
			readLiveRuntimes: async () => [],
			readObservedLocators: async () => [],
			probeMember: async () => false,
		};
		const listed = await runCrewListCommand(options, context(projectRoot), deps);
		assert.equal(listed.kind, "result");
		if (listed.kind === "result") {
			assert.equal(listed.result.status, "listed");
			const crews = (listed.result.data as { crews: Array<Record<string, unknown>> }).crews;
			assert.equal(crews.length, 1);
			assert.deepEqual(
				{ ...crews[0], observedAt: undefined },
				{
					selector: "alpha",
					displayName: "Alpha",
					availability: "offline",
					memberCount: 1,
					onlineMembers: 0,
					observedAt: undefined,
					addressable: true,
				},
			);
			assert.equal(typeof crews[0]?.observedAt, "string");
		}

		await writeFile(manifestPath, "{not-json");
		const invalid = await runCrewListCommand(options, context(projectRoot), deps);
		assert.equal(invalid.kind, "result");
		if (invalid.kind === "result") {
			assert.equal(invalid.result.status, "empty");
			assert.equal((invalid.result.data as { invalidCandidates: number }).invalidCandidates, 1);
		}

		const outsideManifest = path.join(projectRoot, "outside-crew.json");
		await writeFile(outsideManifest, JSON.stringify({ version: 1, members: [] }));
		await rm(manifestPath);
		await symlink(outsideManifest, manifestPath);
		const untrusted = await runCrewListCommand(options, context(projectRoot), deps);
		assert.equal(untrusted.kind, "result");
		if (untrusted.kind === "result")
			assert.equal((untrusted.result.data as { invalidCandidates: number }).invalidCandidates, 1);
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
});
