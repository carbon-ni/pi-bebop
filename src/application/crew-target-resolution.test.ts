import assert from "node:assert/strict";
import test from "node:test";
import type { CrewManifest } from "../domain/index.ts";
import {
	CrewRouteResolutionError,
	publicCrewRoute,
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

test("cancellation stops before discovery and reports the phase", async () => {
	const controller = new AbortController();
	controller.abort();
	const error = await rejectsCode(
		resolveCrewTarget(request("alpha/Mony", { signal: controller.signal }), dependencies()),
		"cancelled",
	);
	assert.equal(error.stage, "discovery");
});
