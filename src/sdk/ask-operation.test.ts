import test from "node:test";
import assert from "node:assert/strict";
import { BebopClientError } from "./errors.ts";
import { createAskOperation, type AskOperationPolicy } from "./ask-operation.ts";
import type { MemberRequestOperation } from "./member-request-operation.ts";

const member = { name: "Kelly", role: "qa" };

function requestStub(
	waits: Array<"pending" | "response" | "timeout" | "offline"> = ["response"],
	start: "accepted" | "timeout" | "reject" = "accepted",
) {
	const calls: Array<{ method: string; requestId?: string; timeoutMs?: number }> = [];
	let waitIndex = 0;
	const request: Pick<MemberRequestOperation, "startMemberRequest" | "waitForRequestOutcome"> = {
		async startMemberRequest(_target, _input, options) {
			calls.push({ method: "start", timeoutMs: options?.timeoutMs });
			if (start === "timeout") throw new BebopClientError("timeout");
			if (start === "reject") throw new BebopClientError("untrusted");
			return { accepted: true, requestId: "request-1", member };
		},
		async waitForRequestOutcome(requestId, options) {
			calls.push({ method: "wait", requestId, timeoutMs: options?.timeoutMs });
			const kind = waits[Math.min(waitIndex++, waits.length - 1)]!;
			if (kind === "response") return { kind, requestId, member, message: "done", instructions: [] };
			if (kind === "pending") return { kind, requestId, member, reason: "pending-after-idle" };
			if (kind === "offline") return { kind, requestId, member };
			return { kind, requestId, member, reason: "max-wait" };
		},
	};
	return { request, calls };
}

function policy(overrides: Partial<AskOperationPolicy> = {}): AskOperationPolicy {
	return { pending: "rewait", acceptedAbort: "outcome-unknown", deliveryTimeoutMs: 5_000, ...overrides };
}

test("Ask re-waits one accepted Request ID while CLI policy stops after pending", async () => {
	const sdk = requestStub(["pending", "response"]);
	const sdkResult = await createAskOperation({ request: sdk.request, policy: policy() }).ask("Kelly", {
		question: "Review",
	});
	assert.equal(sdkResult.status, "answered");
	assert.deepEqual(
		sdk.calls.map((call) => call.requestId),
		[undefined, "request-1", "request-1"],
	);
	assert.equal(sdk.calls[0]?.timeoutMs, 5_000);

	const cli = requestStub(["pending", "response"]);
	const cliResult = await createAskOperation({
		request: cli.request,
		policy: policy({ pending: "timeout-after-idle", acceptedAbort: "aborted" }),
	}).ask("Kelly", { question: "Review" });
	assert.deepEqual(cliResult, {
		status: "timeout",
		code: "timeout-after-idle",
		accepted: true,
		answered: false,
		safeRetry: false,
		member,
	});
	assert.deepEqual(
		cli.calls.map((call) => call.requestId),
		[undefined, "request-1"],
	);
});

test("Ask keeps delivery bounded separately from its total budget", async () => {
	const stub = requestStub();
	await createAskOperation({ request: stub.request, policy: policy({ deliveryTimeoutMs: 5_000 }) }).ask(
		"Kelly",
		{
			question: "Review",
		},
		{ totalWaitSeconds: 120 },
	);
	assert.equal(stub.calls[0]?.timeoutMs, 5_000);
});

test("Ask reports pre-acceptance timeout as uncertain and preserves source rejection", async () => {
	await assert.rejects(
		createAskOperation({ request: requestStub([], "timeout").request, policy: policy() }).ask("Kelly", {
			question: "Review",
		}),
		(error: unknown) => error instanceof BebopClientError && error.code === "outcome-unknown",
	);
	await assert.rejects(
		createAskOperation({ request: requestStub([], "reject").request, policy: policy() }).ask("Kelly", {
			question: "Review",
		}),
		(error: unknown) => error instanceof BebopClientError && error.code === "untrusted",
	);
});
