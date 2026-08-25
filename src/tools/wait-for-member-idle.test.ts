import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWaitForMemberIdleTool, type MemberIdleWaitToolTransport } from "./wait-for-member-idle.ts";
import type { SocketState } from "../pi/control-runtime.ts";
import { YieldingWaitRegistry } from "../domain/index.ts";
import { YieldingWaitRuntime } from "../pi/wait-resume.ts";

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

/** Deterministic flush of the microtask/macrotask queues (no wall-clock sleep). */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

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
	const delivered: Array<{ content: string; deliverAs: string }> = [];
	const yieldRuntime = new YieldingWaitRuntime({
		registry: new YieldingWaitRegistry(),
		deliver: (message) => delivered.push({ content: message.content, deliverAs: message.deliverAs }),
		isRunIdle: () => true,
		now: () => 1_000,
		createId: () => `idle-wait-${delivered.length + 1}`,
	});
	registerWaitForMemberIdleTool(pi, state, { ...defaultTransport, ...transport }, yieldRuntime);
	assert.ok(registeredTool);
	return { tool: registeredTool!, delivered };
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
		const { tool } = setup(membership);
		assert.equal(tool.name, "wait_for_member_idle");
		const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;
		assert.deepEqual(Object.keys(properties), ["member", "timeout_seconds"]);
		const timeout = properties.timeout_seconds as { minimum?: number; maximum?: number };
		assert.equal(timeout.minimum, 1);
		assert.equal(timeout.maximum, 600);
		assert.match(tool.description, /mechanical/);
		assert.match(tool.description, /yield/);
		assert.match(tool.description, /never starts|no turn|without triggering/);
	});

	test("unjoined execution resolves to a not-joined error before any probe", async () => {
		let probed = 0;
		const { tool } = setup(() => null, { probeEndpoint: async () => ((probed += 1), true) });
		const result = await tool.execute("id", { member: "Bob" });
		assert.equal(result.isError, true);
		assert.equal((result.details as { error?: string }).error, "not-joined");
		assert.equal(probed, 0);
	});

	test("configured offline target returns compact offline result without requesting or yielding", async () => {
		let requests = 0;
		const { tool } = setup(membership, {
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

	test("TASK-0077: reachable busy target yields immediately, then resumes once with became-idle", async () => {
		const { tool, delivered } = setup(membership);
		const result = await tool.execute("id", { member: "Bob" });
		assert.equal(result.isError, undefined);
		assert.equal(result.details.yielded, true, "tool yields instead of blocking");
		assert.match(result.content[0]!.text, /run yielded/);
		await flush();
		assert.equal(delivered.length, 1);
		assert.match(delivered[0]!.content, /member-idle Bob: became-idle/);
		assert.equal(delivered[0]!.deliverAs, "steer");
	});

	test("TASK-0077: already-idle and timeout outcomes resume compactly through the runtime", async () => {
		const already = setup(membership, {
			requestIdleWait: async () => ({
				ok: true,
				result: {
					member: { name: "Bob", role: "dev" },
					outcome: "idle",
					disposition: "already-idle",
					observedAt: "2026-08-23T12:03:00.000Z",
				},
			}),
		});
		await already.tool.execute("id", { member: "Bob" });
		await flush();
		assert.match(already.delivered[0]!.content, /already-idle/);

		const timedOut = setup(membership, {
			requestIdleWait: async () => ({ ok: false, code: "timeout" }),
		});
		await timedOut.tool.execute("id", { member: "Bob" });
		await flush();
		assert.match(timedOut.delivered[0]!.content, /timeout/);
	});

	test("unknown, ambiguous, and self targets are deterministic errors before IO", async () => {
		const unknown = await setup(membership).tool.execute("id", { member: "Nobody" });
		assert.equal((unknown.details as { error?: string }).error, "unknown-member");
		const ambiguous = await setup(membership).tool.execute("id", { member: "dev" });
		assert.equal((ambiguous.details as { error?: string }).error, "ambiguous-member");
		const self = await setup(membership).tool.execute("id", { member: "Tony" });
		assert.equal((self.details as { error?: string }).error, "self-wait");
	});

	test("TASK-0077: malformed transport code never resumes (wait stays parked); abort cancels and never resumes", async () => {
		const malformed = setup(membership, {
			requestIdleWait: async () => ({ ok: false, code: "malformed-response" }),
		});
		await malformed.tool.execute("id", { member: "Bob" });
		await flush();
		assert.equal(malformed.delivered.length, 0, "malformed delivery must never resume");

		const controller = new AbortController();
		const aborted = setup(membership, {
			requestIdleWait: async () => ({ ok: false, code: "aborted" }),
		});
		const pending = aborted.tool.execute("id", { member: "Bob" }, controller.signal);
		controller.abort();
		await pending;
		await flush();
		assert.equal(aborted.delivered.length, 0, "aborted wait must never resume");
	});

	test("timeout_seconds is validated (out of range rejected deterministically)", async () => {
		const { tool } = setup(membership);
		const result = await tool.execute("id", { member: "Bob", timeout_seconds: 601 });
		assert.equal(result.isError, true);
		assert.equal((result.details as { error?: string }).error, "invalid-timeout");
	});
});
