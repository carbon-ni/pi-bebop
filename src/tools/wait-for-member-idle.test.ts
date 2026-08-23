import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWaitForMemberIdleTool, type MemberIdleWaitToolTransport } from "./wait-for-member-idle.ts";
import type { SocketState } from "../pi/control-runtime.ts";

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

function setup(membership: unknown | (() => unknown), transport: Partial<MemberIdleWaitToolTransport> = {}) {
	let registeredTool: RegisteredTool | undefined;
	const pi = {
		registerTool(tool: unknown) {
			registeredTool = tool as RegisteredTool;
		},
	} as unknown as ExtensionAPI;
	const getMembership = typeof membership === "function" ? (membership as () => unknown) : () => membership;
	const state = {
		membershipRuntime: { getMembership },
		context: { isProjectTrusted: () => true },
	} as never as SocketState;
	const defaultTransport: MemberIdleWaitToolTransport = {
		probeEndpoint: async () => true,
		requestIdleWait: async () => ({
			ok: true,
			result: {
				member: { name: "Bob", role: "dev" },
				outcome: "idle",
				disposition: "became-idle",
				observedAt: "2026-08-23T12:03:00.000Z",
			},
		}),
	};
	registerWaitForMemberIdleTool(pi, state, { ...defaultTransport, ...transport });
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

describe("wait_for_member_idle tool", () => {
	test("registers with only member and optional bounded timeout_seconds and an honest description", () => {
		const tool = setup(membership);
		assert.equal(tool.name, "wait_for_member_idle");
		const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;
		assert.deepEqual(Object.keys(properties), ["member", "timeout_seconds"]);
		const timeout = properties.timeout_seconds as { minimum?: number; maximum?: number };
		assert.equal(timeout.minimum, 1);
		assert.equal(timeout.maximum, 600);
		assert.match(tool.description, /mechanical/);
		assert.match(tool.description, /self-reported|member-reported|never.*reply/i);
		assert.match(tool.description, /never starts|no turn|without triggering/);
	});

	test("unjoined execution resolves to a not-joined error before any probe", async () => {
		let probed = 0;
		const tool = setup(() => null, { probeEndpoint: async () => ((probed += 1), true) });
		const result = await tool.execute("id", { member: "Bob" });
		assert.equal(result.isError, true);
		assert.equal((result.details as { error?: string }).error, "not-joined");
		assert.equal(probed, 0);
	});

	test("configured offline target returns compact offline result without requesting", async () => {
		let requests = 0;
		const tool = setup(membership, {
			probeEndpoint: async () => false,
			requestIdleWait: async () => {
				requests += 1;
				return { ok: true, result: {} as never };
			},
		});
		const result = await tool.execute("id", { member: "Bob" });
		assert.equal(result.isError, undefined);
		assert.match(result.content[0]!.text, /offline/);
		assert.equal(requests, 0);
	});

	test("busy target that settles returns became-idle with identity, disposition, and timestamp", async () => {
		const tool = setup(membership);
		const result = await tool.execute("id", { member: "Bob" });
		assert.equal(result.isError, undefined);
		const text = result.content[0]!.text;
		assert.match(text, /Bob \(dev\)/);
		assert.match(text, /idle/);
		assert.match(text, /became-idle/);
		assert.match(text, /12:03:00\.000Z/);
	});

	test("already-idle and timeout outcomes render compactly", async () => {
		const already = await setup(membership, {
			requestIdleWait: async () => ({
				ok: true,
				result: {
					member: { name: "Bob", role: "dev" },
					outcome: "idle",
					disposition: "already-idle",
					observedAt: "2026-08-23T12:03:00.000Z",
				},
			}),
		}).execute("id", { member: "Bob" });
		assert.match(already.content[0]!.text, /already-idle/);

		const timedOut = await setup(membership, {
			requestIdleWait: async () => ({ ok: false, code: "timeout" }),
		}).execute("id", { member: "Bob" });
		assert.equal(timedOut.isError, undefined);
		assert.match(timedOut.content[0]!.text, /timeout/);
	});

	test("unknown, ambiguous, and self targets are deterministic errors before IO", async () => {
		const unknown = await setup(membership).execute("id", { member: "Nobody" });
		assert.equal((unknown.details as { error?: string }).error, "unknown-member");
		const ambiguous = await setup(membership).execute("id", { member: "dev" });
		assert.equal((ambiguous.details as { error?: string }).error, "ambiguous-member");
		const self = await setup(membership).execute("id", { member: "Tony" });
		assert.equal((self.details as { error?: string }).error, "self-wait");
	});

	test("malformed and aborted outcomes map to deterministic errors", async () => {
		const malformed = await setup(membership, {
			requestIdleWait: async () => ({ ok: false, code: "malformed-response" }),
		}).execute("id", { member: "Bob" });
		assert.equal((malformed.details as { error?: string }).error, "malformed-response");

		const aborted = await setup(membership, {
			requestIdleWait: async () => ({ ok: false, code: "aborted" }),
		}).execute("id", { member: "Bob" });
		assert.equal((aborted.details as { error?: string }).error, "aborted");
	});

	test("timeout_seconds is validated (out of range rejected deterministically)", async () => {
		const tool = setup(membership);
		const result = await tool.execute("id", { member: "Bob", timeout_seconds: 601 });
		assert.equal(result.isError, true);
		assert.equal((result.details as { error?: string }).error, "invalid-timeout");
	});
});
