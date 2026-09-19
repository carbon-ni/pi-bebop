import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { CrewManifestError, type CrewManifest } from "../../domain/index.ts";
import type { CliContext } from "../support/context.ts";
import { renderCliResult, writeOutcome, type CliOutcome } from "../support/output.ts";
import { UsageError } from "../support/arguments.ts";
import {
	buildCrewListCommand,
	defaultCrewListDependencies,
	readCrewListCommand,
	runCrewListCommand,
	type CrewListDependencies,
} from "./crew-list.ts";

const context = (cwd = "/project"): CliContext => ({
	cwd,
	input: new PassThrough(),
	signal: new AbortController().signal,
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

function deps(overrides: Partial<CrewListDependencies> = {}): CrewListDependencies {
	return {
		manifestExists: async (manifestPath) => manifestPath.endsWith("/bebop/crew.json"),
		readManifest: async () => manifest("alpha", "Alpha Crew"),
		probeMember: async (socketPath) => socketPath.endsWith("mony.sock"),
		readObservedLocators: async () => [],
		readLiveRuntimes: async () => [],
		now: () => new Date("2026-09-09T12:00:00.000Z"),
		...overrides,
	};
}

function result(outcome: CliOutcome) {
	assert.equal(outcome.kind, "result");
	if (outcome.kind !== "result") throw new Error("expected result");
	return outcome.result;
}

test("crew list reader preserves full and rejects invalid formats", () => {
	const command = buildCrewListCommand()
		.exitOverride()
		.configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} });
	command.parse(["node", "list", "--full", "--format", "text"], { from: "node" });
	assert.deepEqual(readCrewListCommand(command), { command: "crew-list", format: "text", full: true });
	const defaults = buildCrewListCommand().exitOverride();
	defaults.parse(["node", "list"], { from: "node" });
	assert.deepEqual(readCrewListCommand(defaults), { command: "crew-list", format: "toon", full: false });
	const invalid = buildCrewListCommand().exitOverride();
	invalid.parse(["node", "list", "--format", "yaml"], { from: "node" });
	assert.throws(() => readCrewListCommand(invalid), UsageError);
});

test("default manifest existence fails closed before untrusted filesystem access", async () => {
	assert.equal(await defaultCrewListDependencies.manifestExists("/tmp/crew.json", "/project"), false);
	assert.equal(await defaultCrewListDependencies.manifestExists("/project/.pi/bebop/crew.json", "/project"), false);
});

test("default manifest reader enforces trust and maps filesystem and JSON failures", async () => {
	await assert.rejects(
		() => defaultCrewListDependencies.readManifest("/tmp/crew.json", "/project"),
		(error: unknown) => error instanceof Error && error.message.includes("outside"),
	);
	const missingRoot = await mkdtemp(path.join("/tmp", "bebop-cli-list-missing-"));
	try {
		await assert.rejects(
			() => defaultCrewListDependencies.readManifest(path.join(missingRoot, ".pi/bebop/crew.json"), missingRoot),
			(error: unknown) => error instanceof Error && error.message.includes("could not be resolved"),
		);
	} finally {
		await rm(missingRoot, { recursive: true, force: true });
	}
	const root = await mkdtemp(path.join("/tmp", "bebop-cli-list-reader-"));
	const config = path.join(root, ".pi/bebop");
	await mkdir(config, { recursive: true });
	const manifestPath = path.join(config, "crew.json");
	try {
		await writeFile(manifestPath, "{not-json}\n");
		await assert.rejects(
			() => defaultCrewListDependencies.readManifest(manifestPath, root),
			(error: unknown) => error instanceof Error && error.message.includes("invalid JSON"),
		);
		await writeFile(manifestPath, JSON.stringify({ version: 999, members: [] }));
		await assert.rejects(
			() => defaultCrewListDependencies.readManifest(manifestPath, root),
			(error: unknown) => error instanceof Error && error.message.includes("unsupported manifest version"),
		);
		await writeFile(manifestPath, JSON.stringify(manifest("alpha", "Alpha Crew")));
		const parsed = await defaultCrewListDependencies.readManifest(manifestPath, root);
		assert.equal(parsed.crew?.id, "alpha");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("crew list maps probe failures to offline availability without leaking dependency errors", async () => {
	const outcome = await runCrewListCommand(
		{ command: "crew-list", format: "json", full: false },
		context(),
		deps({ probeMember: async () => Promise.reject(new Error("socket failed")) }),
	);
	const data = result(outcome).data as { crews: Array<{ availability: string; onlineMembers: number }> };
	assert.equal(data.crews[0]?.availability, "offline");
	assert.equal(data.crews[0]?.onlineMembers, 0);
});

test("crew list includes a previously observed trusted runtime when no directory manifest exists", async () => {
	const outcome = await runCrewListCommand(
		{ command: "crew-list", format: "json", full: false },
		context(),
		deps({
			manifestExists: async () => false,
			readObservedLocators: async () => [
				{
					manifestPath: "/project/.pi/bebop/crew.json",
					lastSeenAt: "2026-09-09T12:01:00.000Z",
					availability: "offline",
				},
			],
		}),
	);
	const data = result(outcome).data as { crews: Array<Record<string, unknown>> };
	assert.deepEqual(data.crews[0], {
		selector: "alpha",
		displayName: "Alpha Crew",
		availability: "offline",
		memberCount: 2,
		observedAt: "2026-09-09T12:01:00.000Z",
		lastSeenAt: "2026-09-09T12:01:00.000Z",
		addressable: true,
	});
});

test("default live runtime discovery exits deterministically when already cancelled", async () => {
	const controller = new AbortController();
	controller.abort();
	assert.deepEqual(await defaultCrewListDependencies.readLiveRuntimes("/project", controller.signal), []);
});

test("crew list probes configured Members concurrently and exposes only product fields", async () => {
	const outcome = await runCrewListCommand({ command: "crew-list", format: "json", full: false }, context(), deps());
	const data = result(outcome).data as { crews: Array<Record<string, unknown>>; total: number; partial: boolean };
	assert.equal(data.total, 1);
	assert.equal(data.partial, false);
	assert.deepEqual(data.crews[0], {
		selector: "alpha",
		displayName: "Alpha Crew",
		availability: "partial",
		memberCount: 2,
		onlineMembers: 1,
		observedAt: "2026-09-09T12:00:00.000Z",
		addressable: true,
	});
	assert.equal(JSON.stringify(data), JSON.stringify(data).replace("/project", ""));
});

test("crew availability distinguishes empty, offline, and fully online rosters", async () => {
	const empty = await runCrewListCommand(
		{ command: "crew-list", format: "json", full: false },
		context(),
		deps({ readManifest: async () => ({ ...manifest("empty"), members: [] }) }),
	);
	assert.equal((result(empty).data as { crews: Array<{ availability: string }> }).crews[0]?.availability, "unknown");

	const offline = await runCrewListCommand(
		{ command: "crew-list", format: "json", full: false },
		context(),
		deps({ probeMember: async () => false }),
	);
	assert.equal(
		(result(offline).data as { crews: Array<{ availability: string }> }).crews[0]?.availability,
		"offline",
	);

	const online = await runCrewListCommand(
		{ command: "crew-list", format: "json", full: false },
		context(),
		deps({ probeMember: async () => true }),
	);
	assert.equal((result(online).data as { crews: Array<{ availability: string }> }).crews[0]?.availability, "online");
});

test("duplicate selectors disclose only deterministic Locator recovery values", async () => {
	const paths = ["/project/.pi/bebop/crew.json", "/project/.pi/crew/crew.json"];
	const outcome = await runCrewListCommand(
		{ command: "crew-list", format: "json", full: false },
		context(),
		deps({
			manifestExists: async () => true,
			readManifest: async (manifestPath) =>
				manifest("same", manifestPath.includes("/.pi/crew/") ? "Second" : "First"),
		}),
	);
	const crews = (result(outcome).data as { crews: Array<Record<string, unknown>> }).crews;
	assert.deepEqual(
		crews.map((crew) => [crew.selector, crew.displayName, crew.locator]),
		[
			["same", "First", paths[0]],
			["same", "Second", paths[1]],
		],
	);
	assert.ok(crews.every((crew) => !("sessionId" in crew) && !("socketPath" in crew) && !("requestId" in crew)));
});

test("malformed candidates do not create eligible rows", async () => {
	const outcome = await runCrewListCommand(
		{ command: "crew-list", format: "json", full: false },
		context(),
		deps({
			manifestExists: async () => true,
			readManifest: async () => {
				throw new CrewManifestError("invalid-manifest", "bad manifest");
			},
		}),
	);
	const data = result(outcome).data as {
		crews: Array<Record<string, unknown>>;
		total: number;
		partial: boolean;
		invalidCandidates: number;
	};
	assert.deepEqual(data.crews, []);
	assert.equal(data.total, 0);
	assert.equal(data.partial, true);
	assert.equal(data.invalidCandidates, 2);
});

test("missing identity remains visible as unaddressable and malformed candidates become partial discovery", async () => {
	let index = 0;
	const outcome = await runCrewListCommand(
		{ command: "crew-list", format: "json", full: false },
		context(),
		deps({
			manifestExists: async () => true,
			readManifest: async () => {
				index += 1;
				if (index === 1) return manifest();
				throw new CrewManifestError("invalid-manifest", "bad manifest");
			},
		}),
	);
	const data = result(outcome).data as {
		crews: Array<Record<string, unknown>>;
		partial: boolean;
		invalidCandidates: number;
	};
	assert.equal(data.partial, true);
	assert.equal(data.invalidCandidates, 1);
	assert.equal(data.crews[0]?.availability, "unaddressable");
	assert.equal(data.crews[0]?.reason, "missing-crew-id");
});

test("default output truncates omitted rows while --full returns every bounded row", async () => {
	const runtimes = Array.from({ length: 101 }, (_, index) => ({
		manifestPath: `/observed/${index.toString().padStart(3, "0")}/.pi/bebop/crew.json`,
		observedAt: "2026-09-09T12:00:00.000Z",
		availability: "offline" as const,
	}));
	const dependencies = deps({
		manifestExists: async () => false,
		readLiveRuntimes: async () => runtimes,
		readManifest: async () => manifest("same", "Same Crew"),
	});
	const truncated = result(
		await runCrewListCommand({ command: "crew-list", format: "json", full: false }, context(), dependencies),
	);
	const truncatedData = truncated.data as { crews: unknown[]; total: number; omitted: number; partial: boolean };
	assert.equal(truncatedData.total, 101);
	assert.equal(truncatedData.crews.length, 100);
	assert.equal(truncatedData.omitted, 1);
	assert.equal(truncatedData.partial, true);

	const full = result(
		await runCrewListCommand({ command: "crew-list", format: "json", full: true }, context(), dependencies),
	);
	const fullData = full.data as { crews: unknown[]; total: number; omitted: number; partial: boolean };
	assert.equal(fullData.total, 101);
	assert.equal(fullData.crews.length, 101);
	assert.equal(fullData.omitted, 0);
	assert.equal(fullData.partial, false);
});

test("no eligible or already-cancelled empty discovery is successful", async () => {
	const controller = new AbortController();
	controller.abort();
	const outcome = await runCrewListCommand(
		{ command: "crew-list", format: "text", full: false },
		{ ...context(), signal: controller.signal },
		deps({ manifestExists: async () => false }),
	);
	assert.equal(result(outcome).status, "empty");
	const data = result(outcome).data as { crews: unknown[]; total: number; omitted: number };
	assert.deepEqual(data.crews, []);
	assert.equal(data.total, 0);
	assert.equal(data.omitted, 0);
});

test("cancellation aborts in-flight discovery and reports a partial cancellation", async () => {
	const controller = new AbortController();
	let probeAborted = false;
	const pendingProbe = (_socketPath: string, signal?: AbortSignal): Promise<boolean> =>
		new Promise((resolve) => {
			signal?.addEventListener(
				"abort",
				() => {
					probeAborted = true;
					resolve(false);
				},
				{ once: true },
			);
		});
	setTimeout(() => controller.abort(), 10);
	const outcome = await runCrewListCommand(
		{ command: "crew-list", format: "json", full: false },
		{ ...context(), signal: controller.signal },
		deps({ probeMember: pendingProbe }),
	);
	const data = result(outcome).data as { discovery?: string; partial: boolean };
	assert.equal(data.discovery, "cancelled");
	assert.equal(data.partial, true);
	assert.equal(probeAborted, true);
});

test("cancellation propagates to live discovery dependencies", async () => {
	const controller = new AbortController();
	let dependencyAborted = false;
	const pendingDiscovery = (_projectRoot: string, signal?: AbortSignal): Promise<readonly []> =>
		new Promise((resolve) => {
			signal?.addEventListener(
				"abort",
				() => {
					dependencyAborted = true;
					resolve([]);
				},
				{ once: true },
			);
		});
	setTimeout(() => controller.abort(), 10);
	const outcome = await runCrewListCommand(
		{ command: "crew-list", format: "json", full: false },
		{ ...context(), signal: controller.signal },
		deps({ manifestExists: async () => false, readLiveRuntimes: pendingDiscovery }),
	);
	const data = result(outcome).data as { discovery?: string; partial: boolean };
	assert.equal(data.discovery, "cancelled");
	assert.equal(data.partial, true);
	assert.equal(dependencyAborted, true);
});

test("global discovery budget returns partial timeout instead of waiting on a hung dependency", async () => {
	const started = Date.now();
	let liveCalls = 0;
	const outcome = await runCrewListCommand(
		{ command: "crew-list", format: "json", full: false },
		context(),
		deps({
			manifestExists: async () => await new Promise<boolean>(() => {}),
			readLiveRuntimes: async () => {
				liveCalls += 1;
				return [];
			},
		}),
	);
	assert.ok(Date.now() - started < 2_500, "discovery must stop at the two-second global budget");
	const data = result(outcome).data as { discovery?: string; partial: boolean };
	assert.equal(data.discovery, "timeout");
	assert.equal(data.partial, true);
	assert.equal(liveCalls, 0, "discovery must not start later phases after the global deadline");
});

test("empty discovery is successful and gives a bounded next step", async () => {
	const outcome = await runCrewListCommand(
		{ command: "crew-list", format: "text", full: false },
		context(),
		deps({ manifestExists: async () => false }),
	);
	const rendered = renderCliResult(result(outcome), "text", false);
	assert.match(rendered, /No Crews found/);
	assert.match(rendered, /initialize or join/);
	const output = new PassThrough();
	let text = "";
	output.setEncoding("utf8");
	output.on("data", (chunk) => (text += chunk));
	assert.equal(writeOutcome(output, new PassThrough(), outcome), 0);
	assert.match(text, /No Crews found/);
});
