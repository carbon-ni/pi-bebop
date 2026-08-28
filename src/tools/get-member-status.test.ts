import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGetMemberStatusTool, type MemberStatusToolTransport } from "./get-member-status.ts";
import type { SocketState } from "../pi/control-runtime.ts";

type RegisteredTool = {
	name: string;
	parameters: unknown;
	description: string;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
	): Promise<{
		content: Array<{ type: "text"; text: string }>;
		isError?: boolean;
		details: unknown;
	}>;
};

function setup(membership: unknown | (() => unknown), transport: Partial<MemberStatusToolTransport> = {}) {
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
	const defaultTransport: MemberStatusToolTransport = {
		probeEndpoint: async () => true,
		requestStatus: async () => ({
			ok: true,
			status: {
				member: { name: "Bob", role: "dev" },
				presence: "online",
				activity: "idle",
				hasPendingMessages: false,
				observedAt: "2026-08-23T12:03:00.000Z",
			},
		}),
	};
	registerGetMemberStatusTool(pi, state, { ...defaultTransport, ...transport });
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
		const tool = setup(membership);
		assert.equal(tool.name, "get_member_status");
		const properties = Object.keys((tool.parameters as { properties: Record<string, unknown> }).properties);
		assert.deepEqual(properties, ["member"]);
		assert.match(tool.description, /mechanical/);
		assert.match(tool.description, /never starts|does not start|no turn|without triggering/);
	});

	test("unjoined execution resolves to an actionable not-joined error before any probe", async () => {
		let probed = 0;
		const tool = setup(() => null, { probeEndpoint: async () => ((probed += 1), true) });
		const result = await tool.execute("id", { member: "Bob" });
		assert.equal(result.isError, true);
		const details = result.details as { error?: string; actionableError?: { code: string; message: string } };
		assert.equal(details.error, "not-joined");
		assert.equal(details.actionableError?.code, details.error);
		assert.equal(result.content[0]?.text, details.actionableError?.message);
		assert.doesNotMatch(result.content[0]?.text ?? "", /stack|Error:/i);
		assert.equal(probed, 0);
	});

	test("configured offline target returns compact offline result without querying", async () => {
		let requests = 0;
		const tool = setup(membership, {
			probeEndpoint: async () => false,
			requestStatus: async () => {
				requests += 1;
				return { ok: true, status: {} as never };
			},
		});
		const result = await tool.execute("id", { member: "Bob" });
		assert.equal(result.isError, undefined);
		const text = result.content[0]!.text;
		assert.match(text, /offline/);
		assert.match(text, /activity unavailable/);
		assert.equal(requests, 0);
	});

	test("online target returns formatted status with mechanical labels", async () => {
		const tool = setup(membership, {
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
		});
		const result = await tool.execute("id", { member: "Bob" });
		assert.equal(result.isError, undefined);
		const text = result.content[0]!.text;
		assert.match(text, /Bob \(dev\)/);
		assert.match(text, /online/);
		assert.match(text, /busy/);
		assert.match(text, /pending messages/);
	});

	test("unknown, ambiguous, and self targets are deterministic errors", async () => {
		const unknown = await setup(membership).execute("id", { member: "Nobody" });
		assert.equal((unknown.details as { error?: string }).error, "unknown-member");
		const ambiguous = await setup(membership).execute("id", { member: "dev" });
		assert.equal((ambiguous.details as { error?: string }).error, "ambiguous-member");
		const self = await setup(membership).execute("id", { member: "Tony" });
		assert.equal((self.details as { error?: string }).error, "self-query");
	});

	test("raw status failures use actionable parity without exposing exception text", async () => {
		const result = await setup(membership, {
			requestStatus: async () => {
				throw new Error("dependency failed at /tmp/quarantine-123");
			},
		}).execute("id", { member: "Bob" });
		const details = result.details as { error?: string; actionableError?: { code: string; message: string } };
		assert.equal(result.isError, true);
		assert.equal(details.error, "transport-error");
		assert.equal(details.actionableError?.code, details.error);
		assert.equal(result.content[0]?.text, details.actionableError?.message);
		assert.doesNotMatch(JSON.stringify(result), /quarantine-123|dependency failed/i);
	});

	test("malformed online peer output and peer rejection map to deterministic errors", async () => {
		const malformed = await setup(membership, {
			requestStatus: async () => ({ ok: true, status: { presence: "online" } as never }),
		}).execute("id", { member: "Bob" });
		assert.equal((malformed.details as { error?: string }).error, "malformed-response");
		const rejected = await setup(membership, {
			requestStatus: async () => ({ ok: false, code: "timeout" }),
		}).execute("id", { member: "Bob" });
		assert.equal((rejected.details as { error?: string }).error, "timeout");
	});
});
