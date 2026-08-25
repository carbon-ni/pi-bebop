import test from "node:test";
import assert from "node:assert/strict";
import { createMemberIdleWaitResult, type MemberIdleWaitResult } from "../domain/index.ts";
import {
	createMemberIdleWaitFlow,
	MemberIdleWaitFlowError,
	type MemberIdleWaitSurface,
	type MemberIdleWaitTransportResult,
} from "./member-idle-wait-flow.ts";

const OBSERVED_AT = "2026-08-23T12:03:00.000Z";

const members = [
	{ name: "Bob", role: "developer", socketPath: "/project/.pi/bebop/sockets/Bob.sock" },
	{ name: "Kelly", role: "qa", socketPath: "/project/.pi/bebop/sockets/Kelly.sock" },
	{ name: "Dave", role: "developer", socketPath: "/project/.pi/bebop/sockets/Dave.sock" },
];
const membership = {
	member: members[0]!,
	socketPath: members[0]!.socketPath,
	manifest: { members },
};

const kellyResult: MemberIdleWaitResult = {
	member: { name: "Kelly", role: "qa" },
	outcome: "idle",
	disposition: "became-idle",
	observedAt: OBSERVED_AT,
};

function surface(overrides: Partial<MemberIdleWaitSurface> = {}): MemberIdleWaitSurface & {
	probes: string[];
	requests: string[];
} {
	const probes: string[] = [];
	const requests: string[] = [];
	return {
		getMembership: () => membership,
		isTrusted: () => true,
		probeEndpoint: async (socketPath) => {
			probes.push(socketPath);
			return true;
		},
		requestIdleWait: async (endpoint, memberLabel) => {
			requests.push(endpoint);
			return { ok: true, result: kellyResult };
		},
		now: () => OBSERVED_AT,
		probes,
		requests,
		...overrides,
	} as never;
}

test("TASK-0077: prepareMemberIdleWait validates and probes without ever blocking", async () => {
	const ready = await createMemberIdleWaitFlow(surface()).prepareMemberIdleWait({
		member: "Kelly",
		timeoutSeconds: 61,
	});
	assert.deepEqual(ready, { kind: "ready", target: members[1], timeoutSeconds: 61 });

	const offlineSurface = surface({ probeEndpoint: async () => false });
	const offline = await createMemberIdleWaitFlow(offlineSurface).prepareMemberIdleWait({ member: "Kelly" });
	assert.deepEqual(offline, { kind: "offline", target: members[1] });
	assert.equal(offlineSurface.requests.length, 0, "offline probe must never open a subscription");

	// Validation still rejects before any IO.
	await assert.rejects(
		() =>
			createMemberIdleWaitFlow(surface({ getMembership: () => null })).prepareMemberIdleWait({ member: "Kelly" }),
		(error: unknown) => error instanceof MemberIdleWaitFlowError && error.code === "not-joined",
	);
	await assert.rejects(
		() => createMemberIdleWaitFlow(surface({ isTrusted: () => false })).prepareMemberIdleWait({ member: "Kelly" }),
		(error: unknown) => error instanceof MemberIdleWaitFlowError && error.code === "untrusted",
	);
	await assert.rejects(
		() => createMemberIdleWaitFlow(surface()).prepareMemberIdleWait({ member: "Kelly", timeoutSeconds: 0 }),
		(error: unknown) => error instanceof MemberIdleWaitFlowError && error.code === "invalid-timeout",
	);
	await assert.rejects(
		() => createMemberIdleWaitFlow(surface()).prepareMemberIdleWait({ member: "Missing" }),
		(error: unknown) => error instanceof MemberIdleWaitFlowError && error.code === "unknown-member",
	);
});

test("waitForMemberIdle requires joined and trusted membership before any IO", async () => {
	const notJoined = createMemberIdleWaitFlow(surface({ getMembership: () => null }));
	await assert.rejects(
		() => notJoined.waitForMemberIdle({ member: "Kelly", timeoutSeconds: 300 }),
		(error: unknown) => error instanceof MemberIdleWaitFlowError && error.code === "not-joined",
	);
	const untrusted = createMemberIdleWaitFlow(surface({ isTrusted: () => false }));
	await assert.rejects(
		() => untrusted.waitForMemberIdle({ member: "Kelly", timeoutSeconds: 300 }),
		(error: unknown) => error instanceof MemberIdleWaitFlowError && error.code === "untrusted",
	);
});

test("waitForMemberIdle rejects unknown, ambiguous, and self targets before any IO", async () => {
	for (const [label, code] of [
		["Zoe", "unknown-member"],
		["developer", "ambiguous-member"],
		["Bob", "self-wait"],
	] as const) {
		const deps = surface();
		const flow = createMemberIdleWaitFlow(deps);
		await assert.rejects(
			() => flow.waitForMemberIdle({ member: label, timeoutSeconds: 300 }),
			(error: unknown) => error instanceof MemberIdleWaitFlowError && error.code === code,
		);
		assert.equal(deps.probes.length, 0, `${label} must not probe`);
		assert.equal(deps.requests.length, 0, `${label} must not request`);
	}
});

test("waitForMemberIdle resolves by unique role and waits for another member", async () => {
	const deps = surface();
	const flow = createMemberIdleWaitFlow(deps);
	const result = await flow.waitForMemberIdle({ member: "qa", timeoutSeconds: 300 });
	assert.deepEqual(result, kellyResult);
	assert.deepEqual(deps.probes, ["/project/.pi/bebop/sockets/Kelly.sock"]);
	assert.deepEqual(deps.requests, ["/project/.pi/bebop/sockets/Kelly.sock"]);
});

test("offline target returns an immediate offline result without any RPC", async () => {
	const deps = surface({
		probeEndpoint: async () => false,
		requestIdleWait: async () => {
			throw new Error("must not request when probe fails");
		},
	});
	const flow = createMemberIdleWaitFlow(deps);
	const result = await flow.waitForMemberIdle({ member: "Kelly", timeoutSeconds: 300 });
	assert.deepEqual(result, {
		member: { name: "Kelly", role: "qa" },
		outcome: "offline",
		observedAt: OBSERVED_AT,
	});
	assert.equal(deps.requests.length, 0);
});

test("timeout transport outcome maps to the deterministic timeout result", async () => {
	const deps = surface({ requestIdleWait: async () => ({ ok: false as const, code: "timeout" as const }) });
	const flow = createMemberIdleWaitFlow(deps);
	const result = await flow.waitForMemberIdle({ member: "Kelly", timeoutSeconds: 60 });
	assert.deepEqual(result, {
		member: { name: "Kelly", role: "qa" },
		outcome: "timeout",
		observedAt: OBSERVED_AT,
	});
});

test("offline transport outcome maps to the deterministic offline result", async () => {
	const deps = surface({ requestIdleWait: async () => ({ ok: false as const, code: "offline" as const }) });
	const flow = createMemberIdleWaitFlow(deps);
	const result = await flow.waitForMemberIdle({ member: "Kelly", timeoutSeconds: 60 });
	assert.deepEqual(result, {
		member: { name: "Kelly", role: "qa" },
		outcome: "offline",
		observedAt: OBSERVED_AT,
	});
});

test("aborted transport outcome rejects with aborted and no partial result", async () => {
	const deps = surface({ requestIdleWait: async () => ({ ok: false as const, code: "aborted" as const }) });
	const flow = createMemberIdleWaitFlow(deps);
	await assert.rejects(
		() => flow.waitForMemberIdle({ member: "Kelly", timeoutSeconds: 60 }),
		(error: unknown) => error instanceof MemberIdleWaitFlowError && error.code === "aborted",
	);
});

test("malformed and remote-rejected transport outcomes are protocol errors", async () => {
	for (const code of ["malformed-response", "remote-rejected"] as const) {
		const flow = createMemberIdleWaitFlow(surface({ requestIdleWait: async () => ({ ok: false as const, code }) }));
		await assert.rejects(
			() => flow.waitForMemberIdle({ member: "Kelly", timeoutSeconds: 60 }),
			(error: unknown) => error instanceof MemberIdleWaitFlowError && error.code === code,
		);
	}
});

test("transport result identity mismatch is a malformed-response protocol error", async () => {
	const deps = surface({
		requestIdleWait: async () => ({
			ok: true as const,
			result: createMemberIdleWaitResult(
				{ name: "Dave", role: "developer" },
				{ outcome: "idle", disposition: "became-idle" },
				OBSERVED_AT,
			),
		}),
	});
	const flow = createMemberIdleWaitFlow(deps);
	await assert.rejects(
		() => flow.waitForMemberIdle({ member: "Kelly", timeoutSeconds: 60 }),
		(error: unknown) => error instanceof MemberIdleWaitFlowError && error.code === "malformed-response",
	);
});

test("invalid timeout is rejected before any IO", async () => {
	const deps = surface();
	const flow = createMemberIdleWaitFlow(deps);
	await assert.rejects(
		() => flow.waitForMemberIdle({ member: "Kelly", timeoutSeconds: 7201 }),
		(error: unknown) => error instanceof MemberIdleWaitFlowError && error.code === "invalid-timeout",
	);
	assert.equal(deps.probes.length, 0);
});

test("default timeout of 1,800 seconds applies when omitted", async () => {
	const deps = surface();
	let receivedTimeout = 0;
	const flow = createMemberIdleWaitFlow({
		...deps,
		requestIdleWait: async (_endpoint, _label, options) => {
			receivedTimeout = options.timeoutSeconds;
			return { ok: true as const, result: kellyResult };
		},
	} as never);
	await flow.waitForMemberIdle({ member: "Kelly" });
	assert.equal(receivedTimeout, 1800);
});
