import * as path from "node:path";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseCrewManifest, type CrewManifest } from "../domain/index.ts";
import {
	createMembershipRuntime,
	type Membership,
} from "./membership-runtime.ts";

const manifestPath = "/project/.pi/intray/crew.json";
const manifest = parseCrewManifest({
	version: 1,
	members: [
		{ name: "dev", role: "developer", socket: "sockets/dev.sock", instructions: "Implement" },
		{ name: "qa", role: "reviewer", socket: "sockets/qa.sock" },
	],
}, manifestPath);

function dependencies(overrides: Partial<Parameters<typeof createMembershipRuntime>[0]> = {}) {
	return {
		loadManifest: async (_path: string): Promise<CrewManifest> => manifest,
		claimEndpoint: async (_endpoint: string, _global: string) => ({ claimed: true, idempotent: false }),
		releaseEndpoint: async (_endpoint: string, _global: string) => ({ released: true }),
		...overrides,
	};
}

function joinArgs(member = "dev", globalSocket = "/tmp/global.sock") {
	return {
		manifestPath,
		socketPath: path.join("/project/.pi/intray", "sockets", `${member}.sock`),
		globalSocketPath: globalSocket,
	};
}

describe("membership runtime", () => {
	test("surfaces the actionable manifest load cause", async () => {
		const runtime = createMembershipRuntime(dependencies({ loadManifest: async () => { throw new Error("untrusted-path: compatibility layout rejected"); } }));
		const result = await runtime.join(joinArgs());
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.error.code, "manifest-load-failed");
			assert.match(result.error.message, /untrusted-path: compatibility layout rejected/);
		}
	});
	test("joins by authoritative socket lookup and stores normalized membership", async () => {
		const runtime = createMembershipRuntime(dependencies());
		const result = await runtime.join({ ...joinArgs(), socketPath: "/project/.pi/intray/sockets/../sockets/dev.sock" });
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.membership.member.name, "dev");
			assert.equal(result.membership.member.role, "developer");
			assert.equal(result.membership.socketPath, "/project/.pi/intray/sockets/dev.sock");
		}
	});

	test("same owner retry revalidates and remains idempotent", async () => {
		let claims = 0;
		const runtime = createMembershipRuntime(dependencies({
			claimEndpoint: async () => ({ claimed: true, idempotent: ++claims > 1 }),
		}));
		const args = joinArgs();
		assert.equal((await runtime.join(args)).ok, true);
		const second = await runtime.join(args);
		assert.deepEqual(second.ok && second.idempotent, true);
		assert.equal(claims, 2);
	});

	test("same owner retry recreates a missing endpoint through claim", async () => {
	let claims = 0;
	const runtime = createMembershipRuntime(dependencies({
		claimEndpoint: async () => { claims += 1; return { claimed: true, idempotent: false }; },
	}));
	const args = joinArgs();
	await runtime.join(args);
	const retry = await runtime.join(args);
	assert.equal(retry.ok, true);
	assert.equal(retry.ok && retry.idempotent, false);
	assert.equal(claims, 2);
	});

	test("same endpoint with a live foreign replacement fails and preserves membership", async () => {
	let claims = 0;
	const runtime = createMembershipRuntime(dependencies({
		claimEndpoint: async () => {
			claims += 1;
			if (claims === 2) throw new Error("live foreign endpoint");
			return { claimed: true, idempotent: false };
		},
	}));
	const args = joinArgs();
	await runtime.join(args);
	const failed = await runtime.join(args);
	assert.equal(failed.ok, false);
	if (!failed.ok) assert.equal(failed.error.code, "claim-failed");
	assert.equal(runtime.getMembership()?.globalSocketPath, "/tmp/global.sock");
	});

	test("same socket with a different global socket is not falsely idempotent", async () => {
	let claims = 0;
	const runtime = createMembershipRuntime(dependencies({
		claimEndpoint: async () => ({ claimed: true, idempotent: false }),
	}));
	await runtime.join(joinArgs("dev", "/tmp/old.sock"));
	const switched = await runtime.join(joinArgs("dev", "/tmp/new.sock"));
	assert.equal(switched.ok, true);
	assert.equal(switched.ok && switched.idempotent, false);
	assert.equal(runtime.getMembership()?.globalSocketPath, "/tmp/new.sock");
	});

	test("extensionless configured endpoint joins without suffix guessing", async () => {
	let claims = 0;
	const extensionless = parseCrewManifest({ version: 1, members: [{ name: "dev1", role: "developer", socket: "sockets/dev1" }] }, "/root-B/.pi/bebop/crew.json");
	const runtime = createMembershipRuntime({ loadManifest: async () => extensionless, claimEndpoint: (async () => { claims += 1; return { idempotent: false }; }) as never, releaseEndpoint: (async () => ({ released: true })) as never });
	const result = await runtime.join({ manifestPath: "/root-B/.pi/bebop/crew.json", socketPath: "/root-B/.pi/bebop/sockets/dev1", globalSocketPath: "/tmp/global.sock" });
	assert.equal(result.ok, true);
	assert.equal(claims, 1);
});

test("dev1 versus dev1.sock fails before claim with bounded exact guidance", async () => {
	let claims = 0;
	const manifest = parseCrewManifest({ version: 1, members: [{ name: "dev1", role: "developer", socket: "sockets/dev1.sock" }] }, "/root-B/.pi/bebop/crew.json");
	const runtime = createMembershipRuntime({ loadManifest: async () => manifest, claimEndpoint: (async () => { claims += 1; return { idempotent: false }; }) as never });
	const result = await runtime.join({ manifestPath: "/root-B/.pi/bebop/crew.json", socketPath: "/root-B/.pi/bebop/sockets/dev1", globalSocketPath: "/tmp/global.sock" });
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.match(result.error.message, /Configured endpoints: dev1=\/root-B\/\.pi\/bebop\/sockets\/dev1\.sock\./);
	assert.ok(result.error.message.length < 220);
	assert.equal(claims, 0);
});

test("unknown member and malformed manifest fail without claiming", async () => {
	let claims = 0;
	const runtime = createMembershipRuntime(dependencies({
		loadManifest: async () => { throw new Error("malformed crew"); },
		claimEndpoint: async () => { claims += 1; return { claimed: true, idempotent: false }; },
	}));
	const result = await runtime.join(joinArgs());
	assert.equal(result.ok, false);
	assert.equal(claims, 0);

	const unknown = createMembershipRuntime(dependencies());
	const missing = await unknown.join({ ...joinArgs(), socketPath: "/project/.pi/intray/sockets/missing.sock" });
	assert.equal(missing.ok, false);
	if (!missing.ok) assert.equal(missing.error.code, "member-not-found");
	});

	test("claim failure preserves the previous membership", async () => {
	let shouldFail = false;
	const runtime = createMembershipRuntime(dependencies({
		claimEndpoint: async () => {
			if (shouldFail) throw new Error("busy");
			return { claimed: true, idempotent: false };
		},
	}));
	const first = await runtime.join(joinArgs());
	assert.equal(first.ok, true);
	shouldFail = true;
	const failed = await runtime.join(joinArgs("qa"));
	assert.equal(failed.ok, false);
	assert.equal(runtime.getMembership()?.member.name, "dev");
	});

	test("role switch claims new endpoint before releasing old", async () => {
	const events: string[] = [];
	const runtime = createMembershipRuntime(dependencies({
		claimEndpoint: async (endpoint) => { events.push(`claim:${endpoint}`); return { claimed: true, idempotent: false }; },
		releaseEndpoint: async (endpoint) => { events.push(`release:${endpoint}`); return { released: true }; },
	}));
	await runtime.join(joinArgs());
	const result = await runtime.join(joinArgs("qa"));
	assert.equal(result.ok, true);
	assert.deepEqual(events.slice(1), [
		"claim:/project/.pi/intray/sockets/qa.sock",
		"release:/project/.pi/intray/sockets/dev.sock",
	]);
	});

	test("failed old release rolls back the newly claimed endpoint and preserves membership", async () => {
	let releaseCount = 0;
	const released: string[] = [];
	const runtime = createMembershipRuntime(dependencies({
		releaseEndpoint: async (endpoint) => {
			releaseCount += 1;
			released.push(endpoint);
			if (releaseCount === 1) throw new Error("old release failed");
			return { released: true };
		},
	}));
	await runtime.join(joinArgs());
	const result = await runtime.join(joinArgs("qa"));
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error.code, "switch-release-failed");
	assert.equal(runtime.getMembership()?.member.name, "dev");
	assert.deepEqual(released, [
		"/project/.pi/intray/sockets/dev.sock",
		"/project/.pi/intray/sockets/qa.sock",
	]);
	});

	test("failed rollback is explicit while previous membership remains active", async () => {
	let releases = 0;
	const runtime = createMembershipRuntime(dependencies({
		releaseEndpoint: async () => {
			releases += 1;
			throw new Error("release failed");
		},
	}));
	await runtime.join(joinArgs());
	const result = await runtime.join(joinArgs("qa"));
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error.code, "rollback-failed");
	assert.equal(releases, 2);
	assert.equal(runtime.getMembership()?.member.name, "dev");
	});

	test("leave is idempotent and preserves membership when release fails", async () => {
	let releases = 0;
	const runtime = createMembershipRuntime(dependencies({
		releaseEndpoint: async () => { releases += 1; throw new Error("cannot release"); },
	}));
	assert.deepEqual(await runtime.leave(), { ok: true, left: false });
	await runtime.join(joinArgs());
	const failed = await runtime.leave();
	assert.equal(failed.ok, false);
	assert.equal(runtime.getMembership()?.member.name, "dev");
	assert.equal(releases, 1);
	});
});
