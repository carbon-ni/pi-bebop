import assert from "node:assert/strict";
import test from "node:test";
import { REQUIRED_RUNTIME_CAPABILITIES, type CrewManifest } from "../domain/index.ts";
import {
	diagnoseRuntimeCompatibility,
	type RuntimeDoctorDependencies,
	type RuntimeDoctorRequest,
} from "./runtime-doctor.ts";

const request = (overrides: Partial<RuntimeDoctorRequest> = {}): RuntimeDoctorRequest => ({
	projectRoot: "/project",
	timeoutSeconds: 1,
	diagnostic: false,
	signal: new AbortController().signal,
	...overrides,
});

function manifest(): CrewManifest {
	return {
		version: 2,
		crew: { id: "alpha", displayName: "Alpha" },
		members: [
			{ name: "Alice", role: "developer", socket: "sockets/alice.sock", socketPath: "/alice" },
			{ name: "Bob", role: "qa", socket: "sockets/bob.sock", socketPath: "/bob" },
		],
		presence: { notifications: true },
	};
}

const valid = (overrides: Record<string, unknown> = {}) => ({
	product: "pi-bebop",
	protocol: { name: "pi-bebop", major: 1, minor: 0 },
	packageVersion: "0.2.0",
	buildCommit: "a".repeat(40),
	capabilities: [...REQUIRED_RUNTIME_CAPABILITIES],
	...overrides,
});

function dependencies(probeRuntime: RuntimeDoctorDependencies["probeRuntime"]): RuntimeDoctorDependencies {
	return {
		discoverManifestPaths: () => ["/project/.pi/bebop/crew.json"],
		readManifest: async () => manifest(),
		probeRuntime,
		cli: { packageVersion: "0.2.0", buildCommit: "b".repeat(40), protocol: { major: 1, minor: 0 } },
	};
}

async function diagnose(probeRuntime: RuntimeDoctorDependencies["probeRuntime"], overrides = {}) {
	return diagnoseRuntimeCompatibility(request(overrides), dependencies(probeRuntime));
}

test("doctor reports current runtimes as compatible and hides protocol capabilities by default", async () => {
	const result = await diagnose(async () => ({ kind: "response", value: valid() }));
	assert.equal(result.status, "healthy");
	assert.equal(result.crews[0]?.status, "healthy");
	assert.deepEqual(result.crews[0]?.members[0], {
		name: "Alice",
		role: "developer",
		status: "compatible",
		packageVersion: "0.2.0",
		protocol: { major: 1, minor: 0 },
	});
});

test("doctor distinguishes older, newer, missing, and malformed versions", async () => {
	const variants = [
		["stale-runtime", valid({ protocol: { name: "pi-bebop", major: 0, minor: 9 } })],
		["newer-runtime", valid({ protocol: { name: "pi-bebop", major: 2, minor: 0 } })],
		["missing-version", { product: "pi-bebop", capabilities: [] }],
		["malformed-version", valid({ packageVersion: "dev", buildCommit: "not-a-sha" })],
	] as const;
	for (const [expected, value] of variants) {
		const result = await diagnose(async () => ({ kind: "response", value }));
		assert.equal(result.crews[0]?.members[0]?.status, expected);
	}
});

test("doctor identifies missing capabilities without downgrading Member Request semantics", async () => {
	const result = await diagnose(
		async () => ({ kind: "response", value: valid({ capabilities: ["member.follow_up"] }) }),
		{
			diagnostic: true,
		},
	);
	const member = result.crews[0]?.members[0];
	assert.equal(member?.status, "unsupported-action");
	assert.ok(member?.missingCapabilities?.includes("member.request_start"));
	assert.match(member?.next ?? "", /Update pi-bebop/);
	assert.equal(member?.capabilities?.includes("member.follow_up"), true);
});

test("doctor maps method-not-found, malformed peer, offline, timeout, and cancellation distinctly", async () => {
	const variants = [
		["incompatible-runtime", { kind: "error", code: "method-not-found" }],
		["malformed-peer", { kind: "error", code: "malformed-response" }],
		["offline", { kind: "error", code: "ENOENT" }],
		["timeout", { kind: "error", code: "timeout" }],
		["cancelled", { kind: "error", code: "aborted" }],
	] as const;
	for (const [expected, probe] of variants) {
		const result = await diagnose(async () => probe);
		assert.equal(result.crews[0]?.members[0]?.status, expected);
	}
});

test("doctor retains deterministic partial rows when one Member is incompatible", async () => {
	const result = await diagnose(async (socketPath) =>
		socketPath === "/alice" ? { kind: "response", value: valid() } : { kind: "error", code: "method-not-found" },
	);
	assert.equal(result.status, "issues");
	assert.deepEqual(
		result.crews[0]?.members.map((member) => [member.name, member.status]),
		[
			["Alice", "compatible"],
			["Bob", "incompatible-runtime"],
		],
	);
});

test("doctor reports invalid configuration without probing or mutating it", async () => {
	let probes = 0;
	const deps = dependencies(async () => {
		probes += 1;
		return { kind: "response", value: valid() };
	});
	const invalidDeps: RuntimeDoctorDependencies = {
		...deps,
		readManifest: async () => {
			throw new Error("invalid manifest");
		},
	};
	const result = await diagnoseRuntimeCompatibility(request(), invalidDeps);
	assert.equal(probes, 0);
	assert.equal(result.configuration, "issues");
	assert.equal(result.crews[0]?.status, "configuration-error");
});

test("doctor cancellation is terminal and does not probe later Members", async () => {
	const controller = new AbortController();
	controller.abort(new Error("cancelled by caller"));
	let probes = 0;
	const result = await diagnoseRuntimeCompatibility(
		request({ signal: controller.signal }),
		dependencies(async () => {
			probes += 1;
			return { kind: "response", value: valid() };
		}),
	);
	assert.equal(result.status, "cancelled");
	assert.equal(probes, 0);
});

test("doctor returns no rows for an empty trusted discovery", async () => {
	const deps = dependencies(async () => ({ kind: "response", value: valid() }));
	deps.discoverManifestPaths = () => [];
	const result = await diagnoseRuntimeCompatibility(request(), deps);
	assert.equal(result.status, "empty");
	assert.deepEqual(result.crews, []);
});
