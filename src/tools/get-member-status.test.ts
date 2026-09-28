import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	BebopClientError,
	createInProcessMemberStatusOperation,
	type InProcessMemberStatusSurface,
	type MemberStatusOperation,
} from "../sdk/index.ts";
import { registerGetMemberStatusTool } from "./get-member-status.ts";

type RegisteredTool = {
	name: string;
	parameters: unknown;
	description: string;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<{
		content: Array<{ type: "text"; text: string }>;
		isError?: boolean;
		details: unknown;
	}>;
};

function setup(operation?: MemberStatusOperation) {
	let registeredTool: RegisteredTool | undefined;
	const pi = {
		registerTool(tool: unknown) {
			registeredTool = tool as RegisteredTool;
		},
	} as unknown as ExtensionAPI;
	const statusOperation = operation ?? {
		getMemberStatus: async () => ({
			member: { name: "Bob", role: "dev" },
			presence: "online",
			activity: "idle",
			hasPendingMessages: false,
			observedAt: "2026-08-23T12:03:00.000Z",
		}),
	};
	registerGetMemberStatusTool(pi, statusOperation);
	assert.ok(registeredTool);
	return registeredTool!;
}

const membership = {
	manifestPath: "/project/.pi/bebop/crew.json",
	socketPath: "/project/.pi/bebop/sockets/Tony.sock",
	member: {
		name: "Tony",
		role: "lead",
		socket: "sockets/Tony.sock",
		socketPath: "/project/.pi/bebop/sockets/Tony.sock",
	},
	manifest: {
		version: 1,
		presence: { notifications: true },
		members: [
			{
				name: "Tony",
				role: "lead",
				socket: "sockets/Tony.sock",
				socketPath: "/project/.pi/bebop/sockets/Tony.sock",
			},
			{
				name: "Bob",
				role: "dev",
				socket: "sockets/Bob.sock",
				socketPath: "/project/.pi/bebop/sockets/Bob.sock",
			},
			{
				name: "Dave",
				role: "dev",
				socket: "sockets/Dave.sock",
				socketPath: "/project/.pi/bebop/sockets/Dave.sock",
			},
		],
	},
};

describe("get_member_status tool", () => {
	test("registers with only the member param and an honest mechanical description", () => {
		const tool = setup();
		assert.equal(tool.name, "get_member_status");
		const properties = Object.keys((tool.parameters as { properties: Record<string, unknown> }).properties);
		assert.deepEqual(properties, ["member"]);
		assert.match(tool.description, /mechanical/);
		assert.match(tool.description, /never starts|does not start|no turn|without triggering/);
	});

	test("the tool delegates the trimmed target and active turn cancellation to the SDK operation", async () => {
		let request: { member?: string; signal?: AbortSignal } = {};
		const signal = new AbortController().signal;
		const tool = setup({
			getMemberStatus: async (member, options) => {
				request = { member, signal: options?.signal };
				return {
					member: { name: "Bob", role: "dev" },
					presence: "online",
					activity: "busy",
					hasPendingMessages: true,
					observedAt: "2026-08-23T12:03:00.000Z",
				};
			},
		});
		const result = await tool.execute("id", { member: " Bob " }, signal);
		assert.deepEqual(request, { member: "Bob", signal });
		assert.equal(result.isError, undefined);
		assert.match(result.content[0]!.text, /Bob \(dev\)/);
		assert.match(result.content[0]!.text, /pending messages/);
	});

	test("SDK operation errors retain the compact tool error shape", async () => {
		const tool = setup({
			getMemberStatus: async () => {
				throw new BebopClientError("self-query", "Cannot query your own status");
			},
		});
		const result = await tool.execute("id", { member: "Tony" });
		assert.equal(result.isError, true);
		assert.deepEqual(result.details, { error: "self-query" });
		assert.match(result.content[0]!.text, /^\[Tony\] Cannot query your own status$/);
	});

	test("offline status keeps the compact success result and skips the peer request", async () => {
		let requests = 0;
		const surface: InProcessMemberStatusSurface = {
			getMembership: () => membership,
			isTrusted: () => true,
			isIdle: () => false,
			hasPendingMessages: () => false,
			probeEndpoint: async () => false,
			requestStatus: async () => {
				requests += 1;
				return { ok: false, code: "transport-error" };
			},
			now: () => "2026-08-23T12:03:00.000Z",
		};
		const result = await setup(createInProcessMemberStatusOperation({ surface })).execute("id", { member: "Bob" });
		assert.equal(result.isError, undefined);
		assert.match(result.content[0]!.text, /offline/);
		assert.match(result.content[0]!.text, /activity unavailable/);
		assert.equal(requests, 0);
	});

	test("in-process operation keeps live joined/trusted authority and excludes Guest-only sessions", async () => {
		let currentMembership: typeof membership | null = membership;
		let trusted = true;
		let probes = 0;
		const surface: InProcessMemberStatusSurface = {
			getMembership: () => currentMembership,
			isTrusted: () => trusted,
			isIdle: () => false,
			hasPendingMessages: () => false,
			probeEndpoint: async () => {
				probes += 1;
				return true;
			},
			requestStatus: async () => ({
				ok: true,
				status: {
					member: { name: "Bob", role: "dev" },
					presence: "online",
					activity: "busy",
					hasPendingMessages: true,
					observedAt: "2026-08-23T12:03:00.000Z",
				},
			}),
			now: () => "2026-08-23T12:03:00.000Z",
		};
		const tool = setup(createInProcessMemberStatusOperation({ surface }));

		assert.equal((await tool.execute("id", { member: "Bob" })).isError, undefined);
		currentMembership = null; // Guest-only sessions have no joined Member membership.
		const guestOnly = await tool.execute("id", { member: "Bob" });
		assert.equal((guestOnly.details as { error?: string }).error, "not-joined");
		assert.equal(probes, 1);

		currentMembership = membership; // Rejoin is observed without rebuilding the operation.
		assert.equal((await tool.execute("id", { member: "Bob" })).isError, undefined);
		assert.equal(probes, 2);

		trusted = false;
		const untrusted = await tool.execute("id", { member: "Bob" });
		assert.equal((untrusted.details as { error?: string }).error, "untrusted");
		assert.equal(probes, 2);
	});

	test("in-process operation rejects self and foreign identity before reporting status", async () => {
		const probes: string[] = [];
		const requests: string[] = [];
		const surface: InProcessMemberStatusSurface = {
			getMembership: () => membership,
			isTrusted: () => true,
			isIdle: () => false,
			hasPendingMessages: () => false,
			probeEndpoint: async (socketPath) => {
				probes.push(socketPath);
				return true;
			},
			requestStatus: async (socketPath) => {
				requests.push(socketPath);
				return {
					ok: true,
					status: {
						member: { name: "Mallory", role: "dev" },
						presence: "online",
						activity: "idle",
						hasPendingMessages: false,
						observedAt: "2026-08-23T12:03:00.000Z",
					},
				};
			},
			now: () => "2026-08-23T12:03:00.000Z",
		};
		const tool = setup(createInProcessMemberStatusOperation({ surface }));
		const self = await tool.execute("id", { member: "Tony" });
		assert.equal((self.details as { error?: string }).error, "self-query");
		assert.deepEqual(probes, []);
		assert.deepEqual(requests, []);
		const foreign = await tool.execute("id", { member: "Bob" });
		assert.equal((foreign.details as { error?: string }).error, "malformed-response");
		assert.deepEqual(probes, ["/project/.pi/bebop/sockets/Bob.sock"]);
		assert.deepEqual(requests, ["/project/.pi/bebop/sockets/Bob.sock"]);
	});

	test("tool cancellation aborts the in-process operation without turn effects", async () => {
		let receivedSignal: AbortSignal | undefined;
		let localStateReads = 0;
		const surface: InProcessMemberStatusSurface = {
			getMembership: () => membership,
			isTrusted: () => true,
			isIdle: () => ((localStateReads += 1), false),
			hasPendingMessages: () => ((localStateReads += 1), false),
			probeEndpoint: async (_socketPath, signal) =>
				await new Promise<boolean>((resolve) => {
					receivedSignal = signal;
					signal?.addEventListener("abort", () => resolve(false), { once: true });
				}),
			requestStatus: async () => ({ ok: false, code: "aborted" }),
			now: () => "2026-08-23T12:03:00.000Z",
		};
		const tool = setup(createInProcessMemberStatusOperation({ surface }));
		const controller = new AbortController();
		const pending = tool.execute("id", { member: "Bob" }, controller.signal);
		controller.abort();
		const result = await pending;
		assert.ok(receivedSignal);
		assert.equal(receivedSignal.aborted, true);
		assert.equal((result.details as { error?: string }).error, "aborted");
		assert.equal(localStateReads, 0);
	});
});
