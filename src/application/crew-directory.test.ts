import assert from "node:assert/strict";
import test from "node:test";
import { CrewManifestError, type CrewManifest } from "../domain/index.ts";
import { discoverCrewDirectory, type CrewDirectoryDependencies, type CrewDirectoryRequest } from "./crew-directory.ts";

const request = (signal = new AbortController().signal): CrewDirectoryRequest => ({
	projectRoot: "/project",
	signal,
});

function manifest(id?: string, displayName = id ?? "Legacy"): CrewManifest {
	return {
		version: 2,
		crew: id ? { id, displayName } : undefined,
		members: [
			{
				name: "Mony",
				role: "lead",
				socket: "sockets/mony.sock",
				socketPath: "/project/.pi/bebop/sockets/mony.sock",
			},
			{
				name: "Kelly",
				role: "qa",
				socket: "sockets/kelly.sock",
				socketPath: "/project/.pi/bebop/sockets/kelly.sock",
			},
		],
		presence: { notifications: true },
	} as CrewManifest;
}

function dependencies(overrides: Partial<CrewDirectoryDependencies> = {}): CrewDirectoryDependencies {
	return {
		discoverManifestPaths: () => ["/project/.pi/bebop/crew.json", "/project/.pi/crew/crew.json"],
		manifestExists: async () => true,
		readManifest: async (manifestPath) =>
			manifest("alpha", manifestPath.includes("/.pi/crew/") ? "Second" : "First"),
		probeMember: async (socketPath) => socketPath.endsWith("mony.sock"),
		readObservedLocators: async () => [],
		readLiveRuntimes: async () => [],
		now: () => new Date("2026-09-09T12:00:00.000Z"),
		...overrides,
	};
}

test("application operation returns sorted directory entries and duplicate recovery locators", async () => {
	const result = await discoverCrewDirectory(request(), dependencies());
	assert.equal(result.partial, false);
	assert.deepEqual(
		result.entries.map((entry) => [entry.selector, entry.displayName, entry.locator]),
		[
			["alpha", "First", "/project/.pi/bebop/crew.json"],
			["alpha", "Second", "/project/.pi/crew/crew.json"],
		],
	);
	assert.ok(result.entries.every((entry) => entry.availability === "partial"));
});

test("application operation merges live and observed records without probing recovered rows", async () => {
	const observedPath = "/project/.pi/runtime/observed.json";
	const result = await discoverCrewDirectory(
		request(),
		dependencies({
			manifestExists: async (manifestPath) => manifestPath.endsWith("/bebop/crew.json"),
			readManifest: async (manifestPath) => manifest(manifestPath === observedPath ? "beta" : "alpha"),
			readLiveRuntimes: async () => [
				{
					manifestPath: "/project/.pi/bebop/crew.json",
					observedAt: "2026-09-09T12:01:00.000Z",
					availability: "online",
				},
			],
			readObservedLocators: async () => [
				{
					manifestPath: observedPath,
					lastSeenAt: "2026-09-09T12:02:00.000Z",
					availability: "offline",
				},
			],
		}),
	);
	assert.equal(result.entries.length, 2);
	assert.deepEqual(
		result.entries.map((entry) => entry.selector),
		["alpha", "beta"],
	);
	assert.equal(result.entries[1]?.lastSeenAt, "2026-09-09T12:02:00.000Z");
	assert.equal(result.entries[1]?.availability, "offline");
});

test("application operation reports malformed candidates as partial evidence", async () => {
	const result = await discoverCrewDirectory(
		request(),
		dependencies({
			readManifest: async () => {
				throw new CrewManifestError("invalid-manifest", "malformed");
			},
		}),
	);
	assert.deepEqual(result.entries, []);
	assert.equal(result.partial, true);
	assert.equal(result.invalidCandidates, 2);
});

test("application operation cancels dependencies and returns partial results", async () => {
	const controller = new AbortController();
	let aborted = false;
	const resultPromise = discoverCrewDirectory(
		request(controller.signal),
		dependencies({
			probeMember: async (_socketPath, signal) =>
				new Promise<boolean>((resolve) =>
					signal?.addEventListener(
						"abort",
						() => {
							aborted = true;
							resolve(false);
						},
						{ once: true },
					),
				),
		}),
	);
	setTimeout(() => controller.abort(), 10);
	const result = await resultPromise;
	assert.equal(aborted, true);
	assert.equal(result.discovery, "cancelled");
	assert.equal(result.partial, true);
});

test("application operation enforces one global timeout and does not continue later phases", async () => {
	let liveCalls = 0;
	const started = Date.now();
	const result = await discoverCrewDirectory(
		request(),
		dependencies({
			manifestExists: async () => await new Promise<boolean>(() => {}),
			readLiveRuntimes: async () => {
				liveCalls += 1;
				return [];
			},
		}),
	);
	assert.ok(Date.now() - started < 2_500);
	assert.equal(result.discovery, "timeout");
	assert.equal(result.partial, true);
	assert.equal(liveCalls, 0);
});
