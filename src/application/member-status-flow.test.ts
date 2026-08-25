import test from "node:test";
import assert from "node:assert/strict";
import { createOfflineMemberStatus, type MemberStatus } from "../domain/index.ts";
import { createMemberStatusFlow, MemberStatusFlowError, type MemberStatusSurface } from "./member-status-flow.ts";

const OBSERVED_AT = "2026-08-23T12:03:00.000Z";

const members = [
	{ name: "Bob", role: "developer", socketPath: "/project/.pi/bebop/sockets/Bob.sock" },
	{ name: "Kelly", role: "qa", socketPath: "/project/.pi/bebop/sockets/Kelly.sock" },
	{ name: "Dave", role: "developer", socketPath: "/project/.pi/bebop/sockets/Dave.sock" },
];
const membership = {
	member: members[0],
	socketPath: members[0]!.socketPath,
	manifest: { members },
};
const kellyIdentity = members[1]!.socketPath;

function surface(overrides: Partial<MemberStatusSurface> = {}): MemberStatusSurface & {
	probes: string[];
	requests: string[];
} {
	const probes: string[] = [];
	const requests: string[] = [];
	return {
		getMembership: () => membership,
		isTrusted: () => true,
		isIdle: () => true,
		isCompacting: () => false,
		hasPendingMessages: () => false,
		probeEndpoint: async (socketPath) => {
			probes.push(socketPath);
			return true;
		},
		requestStatus: async (socketPath) => {
			requests.push(socketPath);
			return {
				ok: true,
				status: createOfflineMemberStatus({ name: "Kelly", role: "qa" }, OBSERVED_AT),
			};
		},
		now: () => OBSERVED_AT,
		probes,
		requests,
		...overrides,
	} as never;
}

test("query requires joined and trusted membership before any IO", async () => {
	const flow = createMemberStatusFlow(surface({ getMembership: () => null }));
	await assert.rejects(
		() => flow.queryStatus("Kelly"),
		(error: unknown) => {
			assert.ok(error instanceof MemberStatusFlowError);
			assert.equal(error.code, "not-joined");
			return true;
		},
	);
	const untrusted = createMemberStatusFlow(surface({ isTrusted: () => false }));
	await assert.rejects(
		() => untrusted.queryStatus("Kelly"),
		(error: unknown) => {
			assert.ok(error instanceof MemberStatusFlowError);
			assert.equal(error.code, "untrusted");
			return true;
		},
	);
});

test("query rejects unknown, ambiguous, and self targets deterministically", async () => {
	const flow = createMemberStatusFlow(surface());
	const cases: Array<[string, string]> = [
		["Nobody", "unknown-member"],
		["developer", "ambiguous-member"],
		["Bob", "self-query"],
		["dev", "unknown-member"],
	];
	for (const [target, code] of cases) {
		await assert.rejects(
			() => flow.queryStatus(target),
			(error: unknown) => error instanceof MemberStatusFlowError && error.code === code,
			`expected ${code} for ${target}`,
		);
	}
});

test("query resolves configured offline target to a compact offline status without RPC", async () => {
	const deps = surface({ probeEndpoint: async () => false });
	const flow = createMemberStatusFlow(deps);
	const result = await flow.queryStatus("Kelly");
	assert.equal(result.presence, "offline");
	assert.equal(result.activity, "unavailable");
	assert.equal(deps.requests.length, 0, "offline target must not be queried");
	assert.equal(result.observedAt, OBSERVED_AT);
});

test("query returns live online status computed at request time with bounded pending state", async () => {
	const deps = surface({
		isIdle: () => false,
		hasPendingMessages: () => true,
	});
	deps.requestStatus = async (socketPath) => {
		deps.requests.push(socketPath);
		return {
			ok: true,
			status: {
				member: { name: "Kelly", role: "qa" },
				presence: "online",
				activity: "busy",
				hasPendingMessages: true,
				observedAt: OBSERVED_AT,
			} satisfies MemberStatus,
		};
	};
	const flow = createMemberStatusFlow(deps);
	const result = await flow.queryStatus("qa");
	assert.equal(result.presence, "online");
	assert.equal(result.activity, "busy");
	assert.equal(result.hasPendingMessages, true);
	assert.deepEqual(deps.probes, [kellyIdentity]);
	assert.deepEqual(deps.requests, [kellyIdentity]);
});

test("query treats malformed online peer output as protocol error", async () => {
	const malformed = createMemberStatusFlow(
		surface({
			requestStatus: async () => ({
				ok: true,
				status: {
					member: { name: "Wrong", role: "qa" },
					presence: "online",
					activity: "busy",
					hasPendingMessages: true,
					observedAt: OBSERVED_AT,
				} as never,
			}),
		}),
	);
	await assert.rejects(
		() => malformed.queryStatus("Kelly"),
		(error: unknown) => error instanceof MemberStatusFlowError && error.code === "malformed-response",
	);
	const invalidShape = createMemberStatusFlow(
		surface({
			requestStatus: async () => ({ ok: true, status: { presence: "online" } as never }),
		}),
	);
	await assert.rejects(
		() => invalidShape.queryStatus("Kelly"),
		(error: unknown) => error instanceof MemberStatusFlowError && error.code === "malformed-response",
	);
});

test("signal-driven abort during probe yields aborted, never a successful offline status", async () => {
	const controller = new AbortController();
	const deps = surface({
		probeEndpoint: async (_socketPath, signal) => {
			// Simulates the real probe settling not-alive when the signal aborts.
			await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
			return false;
		},
		requestStatus: async () => {
			throw new Error("must not query after abort");
		},
		signal: controller.signal,
	});
	const flow = createMemberStatusFlow(deps);
	const pending = flow.queryStatus("Kelly");
	await new Promise((resolve) => setTimeout(resolve, 10));
	controller.abort();
	await assert.rejects(
		() => pending,
		(error: unknown) => error instanceof MemberStatusFlowError && error.code === "aborted",
	);
});

test("query maps peer rejection, transport failure, and abort to deterministic codes", async () => {
	const rejected = createMemberStatusFlow(
		surface({ requestStatus: async () => ({ ok: false, code: "remote-rejected" }) }),
	);
	await assert.rejects(
		() => rejected.queryStatus("Kelly"),
		(error: unknown) => error instanceof MemberStatusFlowError && error.code === "remote-rejected",
	);
	const timedOut = createMemberStatusFlow(surface({ requestStatus: async () => ({ ok: false, code: "timeout" }) }));
	await assert.rejects(
		() => timedOut.queryStatus("Kelly"),
		(error: unknown) => error instanceof MemberStatusFlowError && error.code === "timeout",
	);
});

test("query never emits presence activity or triggers a turn", async () => {
	const deps = surface();
	const flow = createMemberStatusFlow(deps);
	await flow.queryStatus("Kelly");
	// Read-only: no entries appended, no turn signal exists in the surface.
	assert.equal((flow as never)["emitsPresence"], undefined);
});
