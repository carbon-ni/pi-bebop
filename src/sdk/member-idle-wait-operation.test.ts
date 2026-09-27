import assert from "node:assert/strict";
import test from "node:test";
import {
	BebopClientError,
	createInProcessMemberIdleWaitOperation,
	type InProcessMemberIdleWaitOperationDependencies,
} from "./index.ts";

const target = { name: "Kelly", role: "qa", socketPath: "/project/.pi/bebop/sockets/Kelly.sock" };
const self = { name: "Dave", role: "developer", socketPath: "/project/.pi/bebop/sockets/Dave.sock" };
const membership = {
	member: self,
	socketPath: self.socketPath,
	manifest: { members: [self, target] },
};
const idleResult = {
	member: { name: target.name, role: target.role },
	outcome: "idle" as const,
	disposition: "became-idle" as const,
	observedAt: "2026-09-27T12:00:00.000Z",
};

function dependencies(
	overrides: Partial<InProcessMemberIdleWaitOperationDependencies["surface"]> = {},
): InProcessMemberIdleWaitOperationDependencies {
	return {
		surface: {
			getMembership: () => membership,
			isTrusted: () => true,
			probeEndpoint: async () => true,
			requestIdleWait: async () => ({ ok: true, result: idleResult }),
			now: () => idleResult.observedAt,
			...overrides,
		},
	};
}

test("in-process idle operation shares target resolution and subscription flow", async () => {
	let probes = 0;
	let requests = 0;
	const operation = createInProcessMemberIdleWaitOperation(
		dependencies({
			probeEndpoint: async () => {
				probes += 1;
				return true;
			},
			requestIdleWait: async () => {
				requests += 1;
				return { ok: true, result: idleResult };
			},
		}),
	);

	assert.deepEqual(operation.resolveMemberIdleWait({ member: "qa", timeoutSeconds: 60 }), {
		kind: "ready",
		target,
		timeoutSeconds: 60,
	});
	assert.deepEqual(await operation.waitForMemberIdle("qa", { timeoutSeconds: 60 }), idleResult);
	assert.equal(probes, 1);
	assert.equal(requests, 1);
});

test("in-process idle operation returns offline without opening a subscription", async () => {
	let requests = 0;
	const operation = createInProcessMemberIdleWaitOperation(
		dependencies({
			probeEndpoint: async () => false,
			requestIdleWait: async () => {
				requests += 1;
				return { ok: true, result: idleResult };
			},
		}),
	);

	const result = await operation.waitForMemberIdle("Kelly", { timeoutSeconds: 60 });
	assert.equal(result.outcome, "offline");
	assert.equal(requests, 0);
});

test("in-process idle operation preserves caller cancellation and identity failures", async () => {
	const controller = new AbortController();
	let aborted = false;
	const operation = createInProcessMemberIdleWaitOperation(
		dependencies({
			requestIdleWait: async (_endpoint, _member, options) => {
				if (options.signal?.aborted) {
					aborted = true;
					return { ok: false, code: "aborted" };
				}
				return new Promise((resolve) => {
					const onAbort = () => {
						aborted = true;
						resolve({ ok: false as const, code: "aborted" as const });
					};
					options.signal?.addEventListener("abort", onAbort, { once: true });
					if (options.signal?.aborted) onAbort();
				});
			},
		}),
	);
	const pending = operation.waitForMemberIdle("Kelly", { timeoutSeconds: 60, signal: controller.signal });
	controller.abort();
	await assert.rejects(pending, (error: unknown) => error instanceof BebopClientError && error.code === "aborted");
	assert.equal(aborted, true);

	const mismatched = createInProcessMemberIdleWaitOperation(
		dependencies({
			requestIdleWait: async () => ({
				ok: true,
				result: { ...idleResult, member: { name: "Mony", role: "lead" } },
			}),
		}),
	);
	await assert.rejects(
		mismatched.waitForMemberIdle("Kelly", { timeoutSeconds: 60 }),
		(error: unknown) => error instanceof BebopClientError && error.code === "identity-mismatch",
	);
});
