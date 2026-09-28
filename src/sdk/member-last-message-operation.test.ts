import assert from "node:assert/strict";
import test from "node:test";
import {
	BebopClientError,
	createInProcessMemberLastMessageOperation,
	type InProcessMemberLastMessageSurface,
} from "./index.ts";

const OBSERVED_AT = 1790100000000;
const target = { name: "Kelly", role: "qa", socketPath: "/crew/kelly.sock" };
const membership = {
	member: { name: "Mary", role: "po", socketPath: "/crew/mary.sock" },
	socketPath: "/crew/mary.sock",
	manifest: { members: [{ name: "Mary", role: "po", socketPath: "/crew/mary.sock" }, target] },
};

function surface(overrides: Partial<InProcessMemberLastMessageSurface> = {}): {
	surface: InProcessMemberLastMessageSurface;
	requests: { endpoint: string; signal?: AbortSignal }[];
} {
	const requests: { endpoint: string; signal?: AbortSignal }[] = [];
	const base: InProcessMemberLastMessageSurface = {
		getMembership: () => membership,
		isTrusted: () => true,
		requestLastMessage: async (endpoint, signal) => {
			requests.push({ endpoint, signal });
			return {
				ok: true,
				message: { role: "assistant", content: "Olá 🌱", timestamp: OBSERVED_AT },
			};
		},
	};
	return { surface: { ...base, ...overrides }, requests };
}

function assertCode(code: BebopClientError["code"]) {
	return (error: unknown) => error instanceof BebopClientError && error.code === code;
}

test("in-process last-message operation preserves UTF-8 snapshot and resolved identity", async () => {
	const deps = surface();
	const result = await createInProcessMemberLastMessageOperation({ surface: deps.surface }).getMemberLastMessage(
		"qa",
	);

	assert.deepEqual(result, {
		member: { name: "Kelly", role: "qa" },
		message: { role: "assistant", content: "Olá 🌱", timestamp: OBSERVED_AT },
	});
	assert.deepEqual(
		deps.requests.map(({ endpoint }) => endpoint),
		[target.socketPath],
	);
});

test("in-process last-message operation preserves empty history", async () => {
	const deps = surface({ requestLastMessage: async () => ({ ok: true, message: null }) });
	const result = await createInProcessMemberLastMessageOperation({ surface: deps.surface }).getMemberLastMessage(
		"Kelly",
	);

	assert.equal(result.message, null);
});

test("in-process last-message operation rejects invalid selectors and authority before IO", async () => {
	const invalid = surface();
	await assert.rejects(
		Promise.resolve().then(() =>
			createInProcessMemberLastMessageOperation({ surface: invalid.surface }).getMemberLastMessage("  "),
		),
		assertCode("invalid-input"),
	);
	assert.deepEqual(invalid.requests, []);

	const ambiguousMembership = {
		...membership,
		manifest: {
			members: [membership.member, { ...target, role: "shared" }, { ...target, name: "Other", role: "shared" }],
		},
	};
	for (const [override, member, code] of [
		[{ getMembership: () => null }, "qa", "not-joined"],
		[{ isTrusted: () => false }, "qa", "untrusted"],
		[{ getMembership: () => ambiguousMembership }, "shared", "ambiguous-member"],
		[{}, "missing", "unknown-member"],
		[{}, "Mary", "self-query"],
	] as const) {
		const deps = surface(override);
		await assert.rejects(
			createInProcessMemberLastMessageOperation({ surface: deps.surface }).getMemberLastMessage(member),
			assertCode(code),
		);
		assert.deepEqual(deps.requests, []);
	}
});

test("in-process last-message operation preserves offline and size failures and validates result shape", async () => {
	for (const code of ["offline-member", "message-too-large"] as const) {
		const failed = surface({ requestLastMessage: async () => ({ ok: false, code }) });
		await assert.rejects(
			createInProcessMemberLastMessageOperation({ surface: failed.surface }).getMemberLastMessage("Kelly"),
			assertCode(code),
		);
	}

	const malformed = surface({
		requestLastMessage: async () =>
			({
				ok: true,
				message: { role: "user", content: "not assistant text", timestamp: -1 },
			}) as never,
	});
	await assert.rejects(
		createInProcessMemberLastMessageOperation({ surface: malformed.surface }).getMemberLastMessage("Kelly"),
		assertCode("malformed-response"),
	);

	const malformedIdentity = surface({
		getMembership: () => ({
			...membership,
			manifest: { members: [membership.member, { ...target, name: "" }] },
		}),
	});
	await assert.rejects(
		createInProcessMemberLastMessageOperation({ surface: malformedIdentity.surface }).getMemberLastMessage("qa"),
		assertCode("malformed-response"),
	);
});

test("in-process last-message operation forwards cancellation and enforces its deadline", async () => {
	const controller = new AbortController();
	const cancelled = surface({
		requestLastMessage: async (_endpoint, signal) =>
			await new Promise((_resolve, reject) => {
				signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			}),
	});
	const pending = createInProcessMemberLastMessageOperation({ surface: cancelled.surface }).getMemberLastMessage(
		"Kelly",
		{
			signal: controller.signal,
		},
	);
	controller.abort();
	await assert.rejects(pending, assertCode("aborted"));

	const timed = surface({
		requestLastMessage: async (_endpoint, signal) =>
			await new Promise((_resolve, reject) => {
				signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			}),
	});
	const started = Date.now();
	await assert.rejects(
		createInProcessMemberLastMessageOperation({ surface: timed.surface }).getMemberLastMessage("Kelly", {
			timeoutMs: 50,
		}),
		assertCode("timeout"),
	);
	assert.ok(Date.now() - started < 500);
});
