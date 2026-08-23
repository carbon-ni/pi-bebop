import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Value } from "@sinclair/typebox/value";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSendToInboxTool } from "./send-to-inbox.ts";
import { MemberInboxStoreError } from "../infra/member-inbox-store.ts";
import type { SocketState } from "../pi/control-runtime.ts";

type RegisteredTool = {
	name: string;
	parameters: unknown;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
	): Promise<{
		content: Array<{ type: "text"; text: string }>;
		isError?: boolean;
		details: unknown;
	}>;
};

function setup(
	membership: unknown | (() => unknown),
	dependencies: Parameters<typeof registerSendToInboxTool>[2] = {},
): RegisteredTool {
	let registeredTool: RegisteredTool | undefined;
	const pi = {
		registerTool(tool: unknown) {
			registeredTool = tool as RegisteredTool;
		},
	} as unknown as ExtensionAPI;
	const getMembership = typeof membership === "function" ? (membership as () => unknown) : () => membership;
	const state = { membershipRuntime: { getMembership } } as never as SocketState;
	registerSendToInboxTool(pi, state, dependencies);
	assert.ok(registeredTool);
	return registeredTool!;
}

const membership = {
	member: { name: "Tony", role: "lead", socket: "sockets/Tony.sock" },
	socketPath: "/project/.pi/bebop/sockets/Tony.sock",
	manifestPath: "/project/.pi/bebop/crew.json",
	manifest: {
		version: 1,
		members: [
			{ name: "Bob", role: "dev", socket: "sockets/Bob.sock", socketPath: "/project/.pi/bebop/sockets/Bob.sock" },
		],
	},
};

const persistingStore = () =>
	({
		memberKey: "member-test",
		enqueue: async () => ({
			item: { version: 1, id: "inbox-0-abc", target: null, payload: null, enqueuedAt: 1, sequence: 0 },
		}),
	}) as never;

describe("send_to_inbox tool", () => {
	test("schema is closed and exposes no task/git/workflow/priority fields", () => {
		const tool = setup(membership);
		assert.equal(Value.Check(tool.parameters, { member: "Bob", message: "hello" }), true);
		assert.equal(Value.Check(tool.parameters, { member: "Bob", message: "hello", instructions: ["step 1"] }), true);
		for (const extra of [
			{ priority: 1 },
			{ task: "x" },
			{ branch: "main" },
			{ workflow: "y" },
			{ storagePath: "/tmp" },
		]) {
			assert.equal(Value.Check(tool.parameters, { member: "Bob", message: "hello", ...extra }), false);
		}
	});

	test("success returns persisted acknowledgement with stable item id, no delivery claim", async () => {
		const tool = setup(membership, {
			isProjectTrusted: () => true,
			openStore: (async () => persistingStore()) as never,
			hintTransport: null,
		});
		const result = await tool.execute("c", { member: "Bob", message: "please review" });
		assert.equal(result.isError, undefined);
		assert.deepEqual(result.details, { itemId: "inbox-0-abc", persisted: true, target: "Bob", hint: "skipped" });
		assert.ok(result.content[0]!.text.includes("persisted"));
		assert.ok(!result.content[0]!.text.includes("delivered"));
	});

	test("unjoined, unknown member, self-send, untrusted, full inbox are distinct bounded errors", async () => {
		const deps = {
			isProjectTrusted: () => true,
			openStore: (async () => persistingStore()) as never,
			hintTransport: null,
		};
		const unjoined = await setup(null, deps).execute("c", { member: "Bob", message: "x" });
		assert.deepEqual(unjoined.details, { error: "not-joined" });

		const unknown = await setup(membership, deps).execute("c", { member: "Ghost", message: "x" });
		assert.deepEqual(unknown.details, { error: "unknown-member" });

		const selfMembership = {
			...membership,
			manifest: {
				...membership.manifest,
				members: [
					...membership.manifest.members,
					{
						name: "Tony",
						role: "lead",
						socket: "sockets/Tony.sock",
						socketPath: "/project/.pi/bebop/sockets/Tony.sock",
					},
				],
			},
		};
		const self = await setup(selfMembership, deps).execute("c", { member: "Tony", message: "x" });
		assert.equal(self.isError, true);
		assert.deepEqual(self.details, { error: "self-send" });

		const untrusted = await setup(membership, { ...deps, isProjectTrusted: () => false }).execute("c", {
			member: "Bob",
			message: "x",
		});
		assert.deepEqual(untrusted.details, { error: "untrusted-project" });

		const full = await setup(membership, {
			...deps,
			openStore: (async () => {
				throw new MemberInboxStoreError("capacity-exceeded", "member inbox is full: 64/64 items");
			}) as never,
		}).execute("c", { member: "Bob", message: "x" });
		assert.deepEqual(full.details, { error: "inbox-full" });
	});

	test("membership is read at execute time, not registration time", async () => {
		let current: unknown = membership;
		const tool = setup(() => current, {
			isProjectTrusted: () => true,
			openStore: (async () => persistingStore()) as never,
			hintTransport: null,
		});
		current = null;
		const left = await tool.execute("c", { member: "Bob", message: "x" });
		assert.equal(left.isError, true);
		current = membership;
		const rejoined = await tool.execute("c", { member: "Bob", message: "x" });
		assert.equal(rejoined.isError, undefined);
	});

	test("hint failure never turns a persisted enqueue into an error", async () => {
		const tool = setup(membership, {
			isProjectTrusted: () => true,
			openStore: (async () => persistingStore()) as never,
			hintTransport: {
				sendHint: async () => {
					throw new Error("offline");
				},
			},
		});
		const result = await tool.execute("c", { member: "Bob", message: "x" });
		assert.equal(result.isError, undefined);
		assert.deepEqual(result.details, { itemId: "inbox-0-abc", persisted: true, target: "Bob", hint: "skipped" });
	});
});
