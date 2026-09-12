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

test("crew list exposes duplicate trusted selectors with recovery locators", async () => {
	const projectRoot = await mkdtemp(path.join(tmpdir(), "bebop-crew-list-duplicates-"));
	try {
		const manifest = JSON.stringify({
			version: 1,
			crew: { id: "alpha", displayName: "Alpha" },
			members: [{ name: "Alice", role: "developer", socket: "sockets/alice.sock" }],
			presence: { notifications: true },
		});
		for (const directory of [".pi/bebop", ".pi/crew"]) {
			const file = path.join(projectRoot, directory, "crew.json");
			await mkdir(path.dirname(file), { recursive: true });
			await writeFile(file, manifest);
		}
		const outcome = await runCrewListCommand(options, context(projectRoot), {
			...defaultCrewListDependencies,
			readLiveRuntimes: async () => [],
			readObservedLocators: async () => [],
			probeMember: async () => true,
		});
		assert.equal(outcome.kind, "result");
		if (outcome.kind === "result") {
			const crews = (outcome.result.data as { crews: Array<Record<string, unknown>> }).crews;
			assert.equal(outcome.result.status, "listed");
			assert.equal(crews.length, 2);
			assert.deepEqual(
				crews.map((crew) => crew.selector),
				["alpha", "alpha"],
			);
			assert.ok(crews.every((crew) => crew.availability === "online" && typeof crew.locator === "string"));
		}
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
});

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

test("crew list merges live and observed records with bounded availability", async () => {
	const projectRoot = "/project";
	const canonical = "/project/.pi/bebop/crew.json";
	const live = "/project/.pi/runtime/live.json";
	const observed = "/project/.pi/runtime/observed.json";
	const manifest = {
		version: 1 as const,
		crew: { id: "alpha", displayName: "Alpha" },
		members: [
			{ name: "Alice", role: "developer", socket: "/sockets/alice.sock", socketPath: "/sockets/alice.sock" },
			{ name: "Bob", role: "reviewer", socket: "/sockets/bob.sock", socketPath: "/sockets/bob.sock" },
		],
		presence: { notifications: true },
	};
	const emptyCrew = { ...manifest, crew: undefined, members: [] };
	const outcome = await runCrewListCommand(options, context(projectRoot), {
		...defaultCrewListDependencies,
		manifestExists: async (file) => file === canonical,
		readManifest: async (file) => (file === observed ? emptyCrew : manifest),
		readLiveRuntimes: async () => [
			{ manifestPath: canonical, observedAt: "2026-09-12T00:00:00.000Z", availability: "online" },
			{ manifestPath: live, observedAt: "2026-09-12T00:00:01.000Z", availability: "online" },
		],
		readObservedLocators: async () => [
			{ manifestPath: observed, lastSeenAt: "2026-09-11T00:00:00.000Z", availability: "offline" },
		],
		probeMember: async (socket) => socket.endsWith("alice.sock"),
	});
	assert.equal(outcome.kind, "result");
	if (outcome.kind === "result") {
		const data = outcome.result.data as { crews: Array<Record<string, unknown>>; total: number };
		assert.equal(data.total, 2);
		assert.deepEqual(
			data.crews.map((crew) => crew.selector),
			["alpha", "alpha"],
		);
		assert.ok(data.crews.some((crew) => crew.availability === "partial"));
		assert.equal(
			data.crews.find((crew) => crew.lastSeenAt !== undefined),
			undefined,
		);
	}
});

test("crew list keeps manifests without a Crew identity unaddressable", async () => {
	const projectRoot = await mkdtemp(path.join(tmpdir(), "bebop-crew-list-unaddressable-"));
	const manifestPath = path.join(projectRoot, ".pi", "bebop", "crew.json");
	try {
		await mkdir(path.dirname(manifestPath), { recursive: true });
		await writeFile(
			manifestPath,
			JSON.stringify({
				version: 1,
				members: [{ name: "Alice", role: "developer", socket: "sockets/alice.sock" }],
				presence: { notifications: true },
			}),
		);
		const outcome = await runCrewListCommand(options, context(projectRoot), {
			...defaultCrewListDependencies,
			readLiveRuntimes: async () => [],
			readObservedLocators: async () => [],
		});
		assert.equal(outcome.kind, "result");
		if (outcome.kind === "result") {
			const crew = (outcome.result.data as { crews: Array<Record<string, unknown>> }).crews[0];
			assert.equal(outcome.result.status, "listed");
			assert.deepEqual(crew, {
				availability: "unaddressable",
				memberCount: 1,
				onlineMembers: 0,
				observedAt: crew?.observedAt,
				addressable: false,
				reason: "missing-crew-id",
			});
		}
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
});
