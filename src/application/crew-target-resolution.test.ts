import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import type { CrewManifest } from "../domain/index.ts";
import { closeRpcServer, createRpcServer, writeResponse } from "../infra/rpc-server.ts";
import {
	CrewRouteResolutionError,
	compareStable,
	createCrewTargetResolver,
	publicCrewRoute,
	publicCrewRouteError,
	resolveCrewTarget,
	type CanonicalOwnerObservation,
	type CrewRouteResolutionDependencies,
} from "./crew-target-resolution.ts";

const ROOT = "/project";
const LOCATOR = "/project/.pi/bebop/crew.json";
const ENDPOINT = "/project/.pi/bebop/sockets/Mony.sock";

function manifest(overrides: Partial<CrewManifest> = {}): CrewManifest {
	return {
		version: 2,
		crew: { id: "alpha", displayName: "Alpha Crew" },
		members: [
			{ name: "Mony", role: "lead", socket: "sockets/Mony.sock", socketPath: ENDPOINT },
			{
				name: "Kelly",
				role: "qa",
				socket: "sockets/Kelly.sock",
				socketPath: "/project/.pi/bebop/sockets/Kelly.sock",
			},
		],
		presence: { notifications: true },
		intake: { contact: "Mony" },
		...overrides,
	};
}

function caller(
	overrides: Partial<Extract<import("./crew-target-resolution.ts").CrewRouteCaller, { kind: "member" }>> = {},
) {
	return {
		kind: "member" as const,
		crewSelector: "alpha",
		crewLocator: LOCATOR,
		memberName: "Kelly",
		role: "qa",
		trusted: true,
		...overrides,
	};
}

function dependencies(
	overrides: Partial<CrewRouteResolutionDependencies> = {},
): CrewRouteResolutionDependencies & { readonly probes: string[] } {
	const probes: string[] = [];
	const probe =
		overrides.probeCanonicalOwner ??
		(async (
			_endpoint: string,
			expected: { readonly selector: string; readonly member: string; readonly locator: string },
		) => ({
			state: "online" as const,
			owner: expected,
		}));
	return {
		probes,
		isProjectTrusted: () => true,
		discoverLocators: async () => [{ locator: LOCATOR }],
		realpath: async (locator) => locator,
		readManifest: async () => manifest(),
		...overrides,
		probeCanonicalOwner: async (endpoint: string, expected, signal) => {
			probes.push(endpoint);
			return probe(endpoint, expected, signal);
		},
	};
}

async function rejectsCode(
	operation: Promise<unknown>,
	code: CrewRouteResolutionError["code"],
): Promise<CrewRouteResolutionError> {
	let caught: unknown;
	try {
		await operation;
	} catch (error) {
		caught = error;
	}
	assert.ok(caught instanceof CrewRouteResolutionError);
	assert.equal(caught.code, code);
	return caught;
}

function request(target: string, overrides: Partial<Parameters<typeof resolveCrewTarget>[0]> = {}) {
	return {
		target,
		projectRoot: ROOT,
		caller: caller(),
		...overrides,
	};
}

test("resolves an exact Member target through the canonical endpoint and keeps public output product-only", async () => {
	const deps = dependencies();
	const route = await resolveCrewTarget(request("alpha/Mony"), deps);
	assert.deepEqual(route.target, {
		crew: { selector: "alpha", displayName: "Alpha Crew" },
		member: { name: "Mony", role: "lead" },
	});
	assert.deepEqual(publicCrewRoute(route), {
		target: route.target,
		caller: { kind: "member", identity: "Kelly" },
	});
	assert.equal(JSON.stringify(publicCrewRoute(route)).includes("socket"), false);
	assert.deepEqual(deps.probes, [ENDPOINT]);
});

test("production composition resolves joined Member and approved Guest through a real endpoint owner", async () => {
	const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "crew-target-resolution-"));
	const manifestPath = path.join(projectRoot, ".pi", "bebop", "crew.json");
	const endpoint = path.join(projectRoot, ".pi", "bebop", "sockets", "Mony.sock");
	await fs.mkdir(path.dirname(endpoint), { recursive: true });
	await fs.writeFile(
		manifestPath,
		JSON.stringify({
			version: 2,
			crew: { id: "alpha", displayName: "Alpha Crew" },
			members: [
				{ name: "Mony", role: "lead", socket: "sockets/Mony.sock" },
				{ name: "Kelly", role: "qa", socket: "sockets/Kelly.sock" },
			],
			presence: { notifications: true },
			intake: { contact: "Mony" },
		}),
	);
	const server = await createRpcServer(endpoint, (command, socket) => {
		if (command.type !== "status") return;
		writeResponse(socket, {
			type: "response",
			command: "status",
			success: true,
			id: command.id,
			data: { status: "joined", crewLocator: manifestPath, projectTrusted: true },
		});
	});
	try {
		const resolve = createCrewTargetResolver({ isProjectTrusted: () => true });
		const memberRoute = await resolve({
			target: "alpha/Mony",
			projectRoot,
			caller: {
				kind: "member",
				crewSelector: "alpha",
				crewLocator: manifestPath,
				memberName: "Kelly",
				role: "qa",
				trusted: true,
			},
		});
		assert.deepEqual(publicCrewRoute(memberRoute), {
			target: { crew: { selector: "alpha", displayName: "Alpha Crew" }, member: { name: "Mony", role: "lead" } },
			caller: { kind: "member", identity: "Kelly" },
		});
		const guestRoute = await resolve({
			target: "alpha/Mony",
			projectRoot,
			caller: {
				kind: "guest",
				crewSelector: "alpha",
				crewLocator: manifestPath,
				guestIdentity: "guest-1",
				guestName: "Ada",
				approved: true,
				capabilities: ["member-request"],
			},
		});
		assert.deepEqual(publicCrewRoute(guestRoute).caller, { kind: "guest", identity: "Ada" });
	} finally {
		await closeRpcServer(server);
		await fs.rm(projectRoot, { recursive: true, force: true });
	}
});

test("Crew target uses only manifest-authored contact and never role or first-member fallback", async () => {
	const deps = dependencies({
		readManifest: async () => manifest({ intake: { contact: "Mony" } }),
	});
	const route = await resolveCrewTarget(request("alpha"), deps);
	assert.equal(route.target.member.name, "Mony");

	await rejectsCode(
		resolveCrewTarget(
			request("alpha"),
			dependencies({ readManifest: async () => manifest({ intake: undefined }) }),
		),
		"unknown-member",
	);
});

test("unknown and ambiguous selectors do not probe transport", async () => {
	const unknown = dependencies({
		readManifest: async () => manifest({ crew: { id: "other", displayName: "Other" } }),
	});
	await rejectsCode(resolveCrewTarget(request("alpha"), unknown), "unknown-crew");
	assert.deepEqual(unknown.probes, []);

	const ambiguous = dependencies({
		discoverLocators: async () => [{ locator: LOCATOR }, { locator: "/project/.pi/crew/crew.json" }],
		realpath: async (locator) => locator,
		readManifest: async (locator) =>
			manifest({ crew: { id: "alpha", displayName: locator.includes(".pi/crew") ? "Second" : "First" } }),
	});
	const error = await rejectsCode(resolveCrewTarget(request("alpha/Mony"), ambiguous), "ambiguous-crew");
	assert.deepEqual(error.candidateLocators, ["/project/.pi/bebop/crew.json", "/project/.pi/crew/crew.json"]);
	assert.deepEqual(ambiguous.probes, []);
});

test("trusted layout rejects traversal and symlink escapes before manifest IO", async () => {
	let reads = 0;
	const deps = dependencies({
		readManifest: async () => {
			reads += 1;
			return manifest();
		},
	});
	await rejectsCode(
		resolveCrewTarget(request("alpha/Mony", { locator: "/project/.pi/bebop/../crew.json" }), deps),
		"authorization-required",
	);
	await rejectsCode(
		resolveCrewTarget(
			request("alpha/Mony", { locator: LOCATOR }),
			dependencies({ realpath: async () => "/outside/crew.json", readManifest: async () => manifest() }),
		),
		"authorization-required",
	);
	assert.equal(reads, 0);
});

test("Locator-only and cross-Crew callers cannot gain routing authority", async () => {
	const external = dependencies({
		discoverLocators: async () => {
			throw new Error("must not discover");
		},
	});
	await rejectsCode(
		resolveCrewTarget(request("alpha/Mony", { caller: { kind: "external" }, locator: LOCATOR }), external),
		"authorization-required",
	);

	await rejectsCode(
		resolveCrewTarget(request("other/Mony", { caller: caller() }), dependencies()),
		"authorization-required",
	);
});

test("self-target is rejected while an approved Guest preserves Guest identity", async () => {
	await rejectsCode(resolveCrewTarget(request("alpha/Kelly"), dependencies()), "self-target");
	const route = await resolveCrewTarget(
		request("alpha/Mony", {
			caller: {
				kind: "guest",
				crewSelector: "alpha",
				crewLocator: LOCATOR,
				guestIdentity: "guest-1",
				guestName: "Ada",
				approved: true,
				capabilities: ["member-request"],
			},
		}),
		dependencies(),
	);
	assert.deepEqual(route.caller, { kind: "guest", identity: "Ada" });
});

test("invalid manifest, unknown Member, and missing contact are distinct before probing", async () => {
	const duplicate = manifest({
		members: [
			{ name: "Mony", role: "lead", socket: "sockets/Mony.sock", socketPath: ENDPOINT },
			{
				name: "Mony",
				role: "qa",
				socket: "sockets/other.sock",
				socketPath: "/project/.pi/bebop/sockets/other.sock",
			},
		],
	});
	const duplicateDeps = dependencies({ readManifest: async () => duplicate });
	await rejectsCode(resolveCrewTarget(request("alpha/Mony"), duplicateDeps), "invalid-manifest");
	assert.deepEqual(duplicateDeps.probes, []);

	const unknownDeps = dependencies();
	await rejectsCode(resolveCrewTarget(request("alpha/Ghost"), unknownDeps), "unknown-member");
	assert.deepEqual(unknownDeps.probes, []);
});

test("canonical owner conflicts, malformed state, offline state, and stale route are typed", async () => {
	for (const observation of [{ state: "conflict" }, { state: "malformed" }, { state: "offline" }] as const) {
		const deps = dependencies({ probeCanonicalOwner: async () => observation as CanonicalOwnerObservation });
		await rejectsCode(
			resolveCrewTarget(request("alpha/Mony"), deps),
			observation.state === "offline"
				? "offline-member"
				: observation.state === "conflict"
					? "route-conflict"
					: "malformed-response",
		);
		assert.deepEqual(deps.probes, [ENDPOINT]);
	}
	const stale = dependencies({ revalidateRoute: async () => false });
	await rejectsCode(resolveCrewTarget(request("alpha/Mony"), stale), "route-lost");
});

test("owner identity mismatch is route-conflict and no fallback runtime is selected", async () => {
	const deps = dependencies({
		probeCanonicalOwner: async () => ({
			state: "online",
			owner: { selector: "alpha", member: "Kelly", locator: LOCATOR },
		}),
	});
	await rejectsCode(resolveCrewTarget(request("alpha/Mony"), deps), "route-conflict");
	assert.deepEqual(deps.probes, [ENDPOINT]);
});

test("trust is checked before manifest IO and Guest capability is action-specific", async () => {
	let reads = 0;
	const untrusted = dependencies({
		isProjectTrusted: () => false,
		readManifest: async () => {
			reads += 1;
			return manifest();
		},
	});
	await rejectsCode(resolveCrewTarget(request("alpha/Mony"), untrusted), "authorization-required");
	assert.equal(reads, 0);

	await rejectsCode(
		resolveCrewTarget(
			request("alpha/Mony", {
				action: "member-request",
				caller: {
					kind: "guest",
					crewSelector: "alpha",
					crewLocator: LOCATOR,
					guestIdentity: "guest-1",
					guestName: "Ada",
					approved: true,
					capabilities: ["follow-up"],
				},
			}),
			dependencies(),
		),
		"authorization-required",
	);
});

test("explicit locator is required to recover a duplicate and is canonicalized within the trusted layout", async () => {
	const deps = dependencies({
		discoverLocators: async () => [{ locator: "/project/.pi/crew/crew.json" }],
		realpath: async (locator) => locator,
		readManifest: async (locator) =>
			manifest({ crew: { id: "alpha", displayName: locator.includes(".pi/crew") ? "Second" : "First" } }),
	});
	const route = await resolveCrewTarget(
		request("alpha/Mony", {
			locator: "/project/.pi/crew/crew.json",
			caller: caller({ crewLocator: "/project/.pi/crew/crew.json" }),
		}),
		deps,
	);
	assert.equal(route.target.crew.displayName, "Second");
});

test("offline Crew is distinct from an offline Member", async () => {
	const deps = dependencies({
		discoverLocators: async () => [{ locator: LOCATOR, availability: "offline" }],
	});
	await rejectsCode(resolveCrewTarget(request("alpha/Mony"), deps), "offline-crew");
	assert.deepEqual(deps.probes, []);
});

test("canonical route probing has a bounded deadline and does not hang resolution", async () => {
	const deps = dependencies({ probeCanonicalOwner: async () => await new Promise<never>(() => undefined) });
	await rejectsCode(resolveCrewTarget(request("alpha/Mony"), deps), "offline-member");
});

test("discovery has a separate bounded deadline and never probes after timeout", async () => {
	const deps = dependencies({ discoverLocators: async () => await new Promise<never>(() => undefined) });
	const error = await rejectsCode(resolveCrewTarget(request("alpha/Mony"), deps), "discovery-timeout");
	assert.equal(error.stage, "discovery");
	assert.deepEqual(deps.probes, []);
});

test("discovery deadline covers manifest IO and cancels downstream work", async () => {
	let reads = 0;
	let observedSignal: AbortSignal | undefined;
	const deps = dependencies({
		// Node's realpath syscall cannot be interrupted, but the resolver settles at
		// the deadline and does not start any subsequent manifest or probe work.
		realpath: async (_locator, signal) => {
			observedSignal = signal;
			return await new Promise<never>(() => undefined);
		},
		readManifest: async () => {
			reads += 1;
			return manifest();
		},
	});
	await rejectsCode(resolveCrewTarget(request("alpha/Mony"), deps), "discovery-timeout");
	assert.equal(reads, 0);
	assert.deepEqual(deps.probes, []);
	assert.equal(observedSignal?.aborted, true);
});

test("cancellation during candidate IO stops before manifest and probe work", async () => {
	const controller = new AbortController();
	let reads = 0;
	const deps = dependencies({
		realpath: async (_locator, signal) => {
			signal?.addEventListener("abort", () => undefined);
			controller.abort();
			return LOCATOR;
		},
		readManifest: async () => {
			reads += 1;
			return manifest();
		},
	});
	await rejectsCode(resolveCrewTarget(request("alpha/Mony", { signal: controller.signal }), deps), "cancelled");
	assert.equal(reads, 0);
	assert.deepEqual(deps.probes, []);
});

test("pre-probe cancellation never starts the canonical probe", async () => {
	const controller = new AbortController();
	const deps = dependencies({
		readManifest: async () => {
			controller.abort();
			return manifest();
		},
	});
	await rejectsCode(resolveCrewTarget(request("alpha/Mony", { signal: controller.signal }), deps), "cancelled");
	assert.deepEqual(deps.probes, []);
});

test("cancellation during canonical probing stops before revalidation", async () => {
	const controller = new AbortController();
	const deps = dependencies({
		probeCanonicalOwner: async () => {
			controller.abort();
			return { state: "online", owner: { selector: "alpha", member: "Mony", locator: LOCATOR } };
		},
		revalidateRoute: async () => {
			throw new Error("must not revalidate");
		},
	});
	await rejectsCode(resolveCrewTarget(request("alpha/Mony", { signal: controller.signal }), deps), "cancelled");
	assert.deepEqual(deps.probes, [ENDPOINT]);
});

test("revalidation is bounded and cancellable", async () => {
	const timeout = dependencies({ revalidateRoute: async () => await new Promise<never>(() => undefined) });
	await rejectsCode(resolveCrewTarget(request("alpha/Mony"), timeout), "route-lost");

	const controller = new AbortController();
	const cancelled = dependencies({
		revalidateRoute: async (_endpoint, _expected, signal) => {
			controller.abort();
			await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
			return false;
		},
	});
	await rejectsCode(resolveCrewTarget(request("alpha/Mony", { signal: controller.signal }), cancelled), "cancelled");
});

test("canonical aliases are deduplicated and ambiguous candidates expose bounded metadata", async () => {
	let reads = 0;
	const aliases = dependencies({
		discoverLocators: async () => [{ locator: LOCATOR }, { locator: "/project/.pi/crew/crew.json" }],
		realpath: async () => LOCATOR,
		readManifest: async () => {
			reads += 1;
			return manifest();
		},
	});
	await resolveCrewTarget(request("alpha/Mony"), aliases);
	assert.equal(reads, 1);

	const locators = Array.from({ length: 25 }, (_, index) => `/project/.pi/bebop/crew-${index}.json`);
	const many = dependencies({
		isTrustedManifestPath: () => true,
		discoverLocators: async () => locators.map((locator) => ({ locator })),
		realpath: async (locator) => locator,
	});
	const error = await rejectsCode(resolveCrewTarget(request("alpha/Mony"), many), "ambiguous-crew");
	assert.equal(error.totalCandidates, 26);
	assert.equal(error.shownCandidates, 20);
	assert.equal(error.truncatedCandidates, true);
});

test("public projections redact transport, capability, request, and private error details", async () => {
	const route = await resolveCrewTarget(request("alpha/Mony"), dependencies());
	const routeJson = JSON.stringify(publicCrewRoute(route));
	assert.equal(/socket|endpoint|locator|capabilit|request|session|path/i.test(routeJson), false);

	const error = await rejectsCode(
		resolveCrewTarget(
			request("alpha/Mony", { locator: LOCATOR }),
			dependencies({ realpath: async () => "/private/session/socket.sock" }),
		),
		"authorization-required",
	);
	const errorJson = JSON.stringify(publicCrewRouteError(error));
	assert.equal(errorJson.includes("/private/session/socket.sock"), false);
	assert.equal(errorJson.includes("raw transport"), false);
	assert.equal(Object.hasOwn(JSON.parse(errorJson), "message"), false);
});

test("stable candidate ordering is locale-independent", () => {
	assert.equal(compareStable("z", "ä"), -1);
	assert.equal(compareStable("ä", "z"), 1);
	assert.equal(compareStable("same", "same"), 0);
});

test("cancellation stops before discovery and reports the phase", async () => {
	const controller = new AbortController();
	controller.abort();
	const error = await rejectsCode(
		resolveCrewTarget(request("alpha/Mony", { signal: controller.signal }), dependencies()),
		"cancelled",
	);
	assert.equal(error.stage, "discovery");
});
