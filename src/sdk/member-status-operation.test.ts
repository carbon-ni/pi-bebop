import test from "node:test";
import assert from "node:assert/strict";
import {
	BebopClientError,
	createInProcessMemberStatusOperation,
	type InProcessMemberStatusOperationDependencies,
	type InProcessMemberStatusSurface,
} from "./index.ts";
import { createOnlineMemberStatus, type MemberStatus } from "../domain/index.ts";

const OBSERVED_AT = "2026-09-27T10:00:00.000Z";
const members = [
	{ name: "Mary", role: "po", socketPath: "/crew/mary.sock" },
	{ name: "Kelly", role: "qa", socketPath: "/crew/kelly.sock" },
];
const membership = {
	member: members[0]!,
	socketPath: members[0]!.socketPath,
	manifest: { members },
};

function surface(overrides: Partial<InProcessMemberStatusSurface> = {}): {
	dependencies: InProcessMemberStatusOperationDependencies;
	probes: string[];
	requests: string[];
} {
	const probes: string[] = [];
	const requests: string[] = [];
	const base: InProcessMemberStatusSurface = {
		getMembership: () => membership,
		isTrusted: () => true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		probeEndpoint: async (socketPath) => {
			probes.push(socketPath);
			return true;
		},
		requestStatus: async (socketPath) => {
			requests.push(socketPath);
			return {
				ok: true,
				status: createOnlineMemberStatus({
					member: { name: "Kelly", role: "qa" },
					isIdle: true,
					hasPendingMessages: false,
					observedAt: OBSERVED_AT,
				}),
			};
		},
		now: () => OBSERVED_AT,
	};
	return { dependencies: { surface: { ...base, ...overrides } }, probes, requests };
}

function assertCode(code: BebopClientError["code"]) {
	return (error: unknown) => error instanceof BebopClientError && error.code === code;
}

test("in-process status operation reuses flow policy and returns typed status", async () => {
	const deps = surface();
	const operation = createInProcessMemberStatusOperation(deps.dependencies);

	const result = await operation.getMemberStatus("qa");

	assert.deepEqual(result, {
		member: { name: "Kelly", role: "qa" },
		presence: "online",
		activity: "idle",
		hasPendingMessages: false,
		observedAt: OBSERVED_AT,
	} satisfies MemberStatus);
	assert.deepEqual(deps.probes, ["/crew/kelly.sock"]);
	assert.deepEqual(deps.requests, ["/crew/kelly.sock"]);
});

test("in-process status operation validates input before any socket-capable adapter call", async () => {
	const deps = surface();
	const operation = createInProcessMemberStatusOperation(deps.dependencies);

	await assert.rejects(
		Promise.resolve().then(() => operation.getMemberStatus("  ")),
		assertCode("invalid-input"),
	);

	assert.deepEqual(deps.probes, []);
	assert.deepEqual(deps.requests, []);
});

test("in-process status operation preserves compact offline status without a target request", async () => {
	const deps = surface({ probeEndpoint: async () => false });
	const result = await createInProcessMemberStatusOperation(deps.dependencies).getMemberStatus("Kelly");

	assert.equal(result.presence, "offline");
	assert.equal(result.activity, "unavailable");
	assert.deepEqual(deps.requests, []);
});

test("in-process status operation rejects self before any socket-capable adapter call", async () => {
	const deps = surface();
	const operation = createInProcessMemberStatusOperation(deps.dependencies);

	await assert.rejects(() => operation.getMemberStatus("Mary"), assertCode("self-query"));

	assert.deepEqual(deps.probes, []);
	assert.deepEqual(deps.requests, []);
});

test("in-process status operation checks live joined and trusted authority", async () => {
	const unjoined = surface({ getMembership: () => null });
	await assert.rejects(
		() => createInProcessMemberStatusOperation(unjoined.dependencies).getMemberStatus("Kelly"),
		assertCode("not-joined"),
	);
	assert.deepEqual(unjoined.probes, []);

	const untrusted = surface({ isTrusted: () => false });
	await assert.rejects(
		() => createInProcessMemberStatusOperation(untrusted.dependencies).getMemberStatus("Kelly"),
		assertCode("untrusted"),
	);
	assert.deepEqual(untrusted.probes, []);
});

test("in-process status operation maps malformed identity and preserves cancellation", async () => {
	const malformed = surface({
		requestStatus: async () => ({
			ok: true,
			status: {
				member: { name: "Somebody else", role: "qa" },
				presence: "online",
				activity: "idle",
				hasPendingMessages: false,
				observedAt: OBSERVED_AT,
			} as never,
		}),
	});
	await assert.rejects(
		() => createInProcessMemberStatusOperation(malformed.dependencies).getMemberStatus("Kelly"),
		assertCode("malformed-response"),
	);

	const controller = new AbortController();
	const cancelled = surface({
		probeEndpoint: async (_socketPath, signal) =>
			await new Promise<boolean>((resolve) => {
				signal?.addEventListener("abort", () => resolve(false), { once: true });
			}),
	});
	const pending = createInProcessMemberStatusOperation(cancelled.dependencies).getMemberStatus("Kelly", {
		signal: controller.signal,
	});
	controller.abort();
	await assert.rejects(pending, assertCode("aborted"));
	assert.deepEqual(cancelled.requests, []);
});

test("in-process status operation bounds a hanging adapter with the SDK deadline", async () => {
	const deps = surface({
		probeEndpoint: async (_socketPath, signal) =>
			await new Promise<boolean>((resolve) => {
				signal?.addEventListener("abort", () => resolve(false), { once: true });
			}),
	});
	const started = Date.now();
	await assert.rejects(
		() => createInProcessMemberStatusOperation(deps.dependencies).getMemberStatus("Kelly", { timeoutMs: 50 }),
		assertCode("timeout"),
	);
	assert.ok(Date.now() - started < 500);
	assert.deepEqual(deps.requests, []);
});
