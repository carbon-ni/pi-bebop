import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	createGuestMembershipRuntime,
	type GuestMembershipRuntime,
	type GuestMembershipRecordInput,
} from "./guest-membership-runtime.ts";

const alpha = { id: "alpha", displayName: "Alpha" } as const;
const beta = { id: "beta", displayName: "Beta" } as const;

function createRuntime(overrides: Partial<Parameters<typeof createGuestMembershipRuntime>[0]> = {}) {
	let nextRequest = 0;
	let nextCapability = 0;
	const submitted: unknown[] = [];
	const persisted: unknown[] = [];
	const runtime = createGuestMembershipRuntime({
		guestIdentity: "guest-session",
		callbackEndpoint: "callback.sock",
		createRequestId: () => `request-${++nextRequest}`,
		createCapability: () => `capability-${++nextCapability}`,
		submitJoinRequest: async (request) => {
			submitted.push(request);
		},
		persist: (records) => persisted.push(records),
		...overrides,
	});
	return { runtime, submitted, persisted };
}

function input(crew = alpha, guestName = "Taylor"): GuestMembershipRecordInput {
	return { crew, guestName, memberSocket: `${crew.id}.sock`, submittedByMember: "lead" };
}

describe("Guest membership runtime", () => {
	test("submits one pending request per Crew and makes retries idempotent", async () => {
		const { runtime, submitted } = createRuntime();
		const first = await runtime.join(input());
		const second = await runtime.join(input());
		assert.deepEqual(first, { ok: true, status: "pending", requestId: "request-1", idempotent: false });
		assert.deepEqual(second, { ok: true, status: "pending", requestId: "request-1", idempotent: true });
		assert.equal(submitted.length, 1);
		assert.deepEqual(runtime.list(), [
			{
				status: "pending",
				requestId: "request-1",
				crew: alpha,
				guestIdentity: "guest-session",
				guestName: "Taylor",
			},
		]);
	});

	test("keeps independent memberships and leave scoped to one Crew", async () => {
		const { runtime } = createRuntime();
		await runtime.join(input(alpha));
		await runtime.join(input(beta, "T"));
		const approval = await runtime.approve({
			requestId: "request-1",
			crew: alpha,
			guestIdentity: "guest-session",
			guestName: "Taylor",
			callbackEndpoint: "callback.sock",
			approver: "lead",
		});
		assert.deepEqual(approval, { ok: true, status: "approved", idempotent: false });
		assert.deepEqual(await runtime.leave(alpha.id), { ok: true, left: true });
		assert.deepEqual(
			runtime.list().map(({ crew, status }) => ({ id: crew.id, status })),
			[{ id: "beta", status: "pending" }],
		);
	});

	test("rejects changed pending identity and mismatched or replayed approvals", async () => {
		const { runtime } = createRuntime();
		await runtime.join(input());
		const changed = await runtime.join(input(alpha, "Other"));
		assert.deepEqual(changed, { ok: false, code: "conflicting-pending" });
		const mismatch = await runtime.approve(
			{
				requestId: "request-1",
				crew: beta,
				guestIdentity: "guest-session",
				guestName: "Taylor",
				callbackEndpoint: "callback.sock",
				approver: "lead",
			},
			"runtime-capability",
		);
		assert.deepEqual(mismatch, { ok: false, code: "approval-mismatch" });
		const approved = await runtime.approve(
			{
				requestId: "request-1",
				crew: alpha,
				guestIdentity: "guest-session",
				guestName: "Taylor",
				callbackEndpoint: "callback.sock",
				approver: "lead",
			},
			"runtime-capability",
		);
		assert.deepEqual(approved, { ok: true, status: "approved", idempotent: false });
		assert.deepEqual(
			await runtime.approve(
				{
					requestId: "request-1",
					crew: alpha,
					guestIdentity: "guest-session",
					guestName: "Taylor",
					callbackEndpoint: "callback.sock",
					approver: "lead",
				},
				"runtime-capability",
			),
			{ ok: true, status: "approved", idempotent: true },
		);
	});

	test("persists only approved bindings and updates records after scoped leave", async () => {
		const { runtime, persisted } = createRuntime();
		await runtime.join(input(alpha));
		await runtime.approve({
			requestId: "request-1",
			crew: alpha,
			guestIdentity: "guest-session",
			guestName: "Taylor",
			callbackEndpoint: "callback.sock",
			approver: "lead",
		});
		assert.equal(persisted.length, 1);
		await runtime.leave(alpha.id);
		assert.deepEqual(persisted.at(-1), []);
	});

	test("restores only matching approved records and issues fresh runtime capabilities", async () => {
		const { runtime } = createRuntime({ callbackEndpoint: "new-callback.sock" });
		const records = [
			{
				crew: alpha,
				guestIdentity: "guest-session",
				guestName: "Taylor",
				callbackEndpoint: "old-callback.sock",
				approvedBy: "lead",
			},
			{
				crew: beta,
				guestIdentity: "other-guest",
				guestName: "Other",
				callbackEndpoint: "other.sock",
				approvedBy: "lead",
			},
		] as const;
		const result = runtime.restore(records);
		assert.deepEqual(result, { restored: [alpha.id], rejected: [beta.id] });
		assert.deepEqual(runtime.list(), [
			{
				status: "approved",
				crew: alpha,
				guestIdentity: "guest-session",
				guestName: "Taylor",
				approvedBy: "lead",
			},
		]);
	});
});

describe("Guest membership concurrency and crash recovery", () => {
	function deferred<T>() {
		let resolve!: (value: T) => void;
		const promise = new Promise<T>((resolvePromise) => {
			resolve = resolvePromise;
		});
		return { promise, resolve };
	}

	test("concurrent join, approve, and leave resolve deterministically per crew", async () => {
		const gates = new Map<string, ReturnType<deferred<void>>>();
		const { runtime } = createRuntime({
			submitJoinRequest: async (request) => {
				const gate = deferred<void>();
				gates.set(request.crew.id, gate);
				await gate.promise;
			},
		});
		const firstJoin = runtime.join(input(alpha));
		const betaJoin = runtime.join(input(beta, "Rowan"));
		gates.get("alpha")!.resolve();
		gates.get("beta")!.resolve();
		const first = await firstJoin;
		const betaPending = await betaJoin;
		assert.deepEqual(first, { ok: true, status: "pending", requestId: "request-1", idempotent: false });
		assert.deepEqual(betaPending, { ok: true, status: "pending", requestId: "request-2", idempotent: false });
		const secondJoin = await runtime.join(input(beta, "Rowan"));
		assert.deepEqual(secondJoin, { ok: true, status: "pending", requestId: "request-2", idempotent: true });

		// Approve alpha while a leave for beta is in flight: crews stay isolated.
		const approval = runtime.approve({
			requestId: "request-1",
			crew: alpha,
			guestIdentity: "guest-session",
			guestName: "Taylor",
			callbackEndpoint: "callback.sock",
			approver: "lead",
		});
		const leave = runtime.leave("beta");
		assert.deepEqual(await approval, { ok: true, status: "approved", idempotent: false });
		assert.deepEqual(await leave, { ok: true, left: true });
		assert.deepEqual(
			runtime.list().map((row) => [row.crew.id, row.status]),
			[["alpha", "approved"]],
		);
	});

	test("leaving one crew never mutates the persisted snapshot of another", async () => {
		const { runtime, persisted } = createRuntime();
		await runtime.join(input(alpha));
		await runtime.join(input(beta, "Rowan"));
		const approved = runtime.approve({
			requestId: "request-1",
			crew: alpha,
			guestIdentity: "guest-session",
			guestName: "Taylor",
			callbackEndpoint: "callback.sock",
			approver: "lead",
		});
		assert.deepEqual(await approved, { ok: true, status: "approved", idempotent: false });
		const snapshotWithAlpha = persisted.at(-1) as Array<{ crew: { id: string } }>;
		assert.deepEqual(
			snapshotWithAlpha.map((record) => record.crew.id),
			["alpha"],
		);

		await runtime.join(input(beta, "Rowan"));
		await runtime.leave("beta");
		const snapshotAfterLeave = persisted.at(-1) as Array<{ crew: { id: string } }>;
		assert.deepEqual(
			snapshotAfterLeave.map((record) => record.crew.id),
			["alpha"],
		);
	});

	test("restore retains the member-issued capability; foreign capabilities fail closed", async () => {
		const { runtime, persisted } = createRuntime();
		await runtime.join(input(alpha));
		const approval = {
			requestId: "request-1",
			crew: alpha,
			guestIdentity: "guest-session",
			guestName: "Taylor",
			callbackEndpoint: "callback.sock",
			approver: "lead",
		};
		const firstApproval = await runtime.approve(approval, "capability-lead-1");
		assert.ok(firstApproval.ok);

		// Crash: rebuild from the last persisted snapshot only; the retained
		// member-issued capability survives with the approved binding.
		const snapshot = persisted.at(-1);
		const rebuilt = createRuntime();
		const result = rebuilt.runtime.restore(snapshot);
		assert.deepEqual(result.restored, ["alpha"]);
		assert.deepEqual(result.rejected, []);

		// The retained credential still authorizes idempotent replays; a
		// capability that was never issued for this binding fails closed.
		const replayWithForeign = await rebuilt.runtime.approve(approval, "capability-crash");
		assert.deepEqual(replayWithForeign, { ok: false, code: "approval-mismatch" });
		const idempotentReplay = await rebuilt.runtime.approve(approval, "capability-lead-1");
		assert.deepEqual(idempotentReplay, { ok: true, status: "approved", idempotent: true });
	});

	test("restore rejects tampered and foreign records without losing valid crews", async () => {
		const { runtime } = createRuntime();
		const validRecord = {
			crew: alpha,
			guestIdentity: "guest-session",
			guestName: "Taylor",
			callbackEndpoint: "other-endpoint.sock",
			approvedBy: "lead",
		};
		const result = runtime.restore([
			validRecord,
			{ ...validRecord, crew: beta, guestIdentity: "someone-else" },
			{ ...validRecord, guestName: "Taylor\n" },
			{ crew: { id: "gamma" } },
			null,
		]);
		assert.deepEqual(result.restored, ["alpha"]);
		assert.equal(runtime.list().length, 1);
		assert.equal(runtime.getMemberSocket("alpha"), null);
		assert.deepEqual(await runtime.leave("beta"), { ok: true, left: false });
	});
});
