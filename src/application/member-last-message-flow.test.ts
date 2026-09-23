import assert from "node:assert/strict";
import test from "node:test";
import {
	createMemberLastMessageFlow,
	MemberLastMessageFlowError,
	type MemberLastMessageSurface,
} from "./member-last-message-flow.ts";

const target = { name: "developer", role: "Developer", socketPath: "/tmp/developer.sock" };
const membership = {
	member: { name: "lead", role: "Lead", socketPath: "/tmp/lead.sock" },
	socketPath: "/tmp/lead.sock",
	manifest: { members: [{ name: "lead", role: "Lead", socketPath: "/tmp/lead.sock" }, target] },
};

function surface(overrides: Partial<MemberLastMessageSurface> = {}): MemberLastMessageSurface {
	return {
		getMembership: () => membership,
		isTrusted: () => true,
		probeEndpoint: async () => true,
		requestLastMessage: async () => ({
			ok: true,
			message: { role: "assistant", content: "latest", timestamp: 10 },
		}),
		...overrides,
	};
}

test("last-message flow returns only the target identity and assistant snapshot", async () => {
	assert.deepEqual(await createMemberLastMessageFlow(surface()).queryLastMessage("developer"), {
		member: { name: "developer", role: "Developer" },
		message: { role: "assistant", content: "latest", timestamp: 10 },
	});
});

test("last-message flow returns null for empty online history", async () => {
	const flow = createMemberLastMessageFlow(
		surface({ requestLastMessage: async () => ({ ok: true, message: null }) }),
	);
	assert.deepEqual((await flow.queryLastMessage("Developer")).message, null);
});

test("last-message flow distinguishes offline, authorization, resolution, timeout, and cancellation", async () => {
	for (const [name, override, code] of [
		["offline", { probeEndpoint: async () => false }, "offline-member"],
		["timeout", { requestLastMessage: async () => ({ ok: false as const, code: "timeout" as const }) }, "timeout"],
		["aborted", { requestLastMessage: async () => ({ ok: false as const, code: "aborted" as const }) }, "aborted"],
	] as const) {
		await assert.rejects(
			createMemberLastMessageFlow(surface(override)).queryLastMessage("developer"),
			(error: unknown) => error instanceof MemberLastMessageFlowError && error.code === code,
			name,
		);
	}
	await assert.rejects(
		createMemberLastMessageFlow(surface({ getMembership: () => null })).queryLastMessage("developer"),
		(error: unknown) => error instanceof MemberLastMessageFlowError && error.code === "not-joined",
	);
	await assert.rejects(
		createMemberLastMessageFlow(surface({ isTrusted: () => false })).queryLastMessage("developer"),
		(error: unknown) => error instanceof MemberLastMessageFlowError && error.code === "untrusted",
	);
	await assert.rejects(
		createMemberLastMessageFlow(surface()).queryLastMessage("missing"),
		(error: unknown) => error instanceof MemberLastMessageFlowError && error.code === "unknown-member",
	);
	await assert.rejects(
		createMemberLastMessageFlow(
			surface({
				getMembership: () => ({
					...membership,
					manifest: {
						members: [
							membership.member,
							{ ...target, role: "shared" },
							{ ...target, name: "other", role: "shared" },
						],
					},
				}),
			}),
		).queryLastMessage("shared"),
		(error: unknown) => error instanceof MemberLastMessageFlowError && error.code === "ambiguous-member",
	);
	await assert.rejects(
		createMemberLastMessageFlow(surface()).queryLastMessage("lead"),
		(error: unknown) => error instanceof MemberLastMessageFlowError && error.code === "self-query",
	);
});
