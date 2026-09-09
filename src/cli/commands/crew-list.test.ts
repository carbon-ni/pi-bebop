import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { CrewManifestError, type CrewManifest } from "../../domain/index.ts";
import type { CliContext } from "../support/context.ts";
import { renderCliResult, writeOutcome, type CliOutcome } from "../support/output.ts";
import { UsageError } from "../support/arguments.ts";
import {
	buildCrewListCommand,
	crewListHelp,
	defaultCrewListDependencies,
	parseCrewListCommand,
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

test("crew list parser and builder expose deterministic product vocabulary", () => {
	assert.deepEqual(parseCrewListCommand([]), { command: "crew-list", format: "toon", full: false });
	assert.deepEqual(parseCrewListCommand(["--format=json", "--full"]), {
		command: "crew-list",
		format: "json",
		full: true,
	});
	assert.equal(parseCrewListCommand(["--help"]).help, true);
	assert.throws(() => parseCrewListCommand(["--format", "toon", "--format", "json"]), /Duplicate flag/);
	assert.throws(() => parseCrewListCommand(["--bogus"]), UsageError);
	assert.deepEqual(
		buildCrewListCommand().options.map((option) => option.flags),
		["--format <format>", "--full"],
	);
	assert.match(crewListHelp(), /stable selector/);
	assert.match(crewListHelp(), /never scans arbitrary/);
	assert.match(crewListHelp(), /pi-bebop crew list --format text/);
});

test("default manifest existence fails closed before untrusted filesystem access", async () => {
	assert.equal(await defaultCrewListDependencies.manifestExists("/tmp/crew.json", "/project"), false);
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
	assert.equal(writeOutcome(output, outcome), 0);
	assert.match(text, /No Crews found/);
});
