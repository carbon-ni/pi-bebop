import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { UsageError } from "../support/arguments.ts";
import { runDurableMessageCommand, type DurableMessageCliDependencies } from "./durable-message.ts";
import type { CliContext } from "../support/context.ts";
import { registerSendToInboxTool } from "../../tools/send-to-inbox.ts";
import { registerBroadcastToCrewTool } from "../../tools/broadcast-to-crew.ts";

const source = {
	ok: true as const,
	kind: "id" as const,
	idSocketPath: "/source.sock",
	aliasSocketPath: "/source.sock",
};
function context(): CliContext {
	return { cwd: "/project", input: new PassThrough(), signal: new AbortController().signal };
}
function deps(overrides: Partial<DurableMessageCliDependencies> = {}): DurableMessageCliDependencies {
	return {
		resolveSource: () => source,
		readStdin: async () => "from stdin",
		deliver: async (_source, command) =>
			command.type === "member_inbox_send"
				? {
						ok: true,
						result: {
							member: { name: command.target, role: "qa" },
							itemId: "inbox-1",
							persisted: true,
							hint: "skipped",
						},
					}
				: {
						ok: true,
						result: {
							dispositions: [
								{ member: "Mary", role: "po", deliveryId: "delivery-1", disposition: "delivered" },
							],
							summary: { delivered: 1, failed: 0, total: 1 },
						},
					},
		environmentSession: () => undefined,
		...overrides,
	};
}

test("durable commands map source, stdin, and delivery failures", async () => {
	await assert.rejects(
		() =>
			runDurableMessageCommand(
				{
					command: "crew-broadcast",
					intent: "broadcast",
					message: "x",
					instructions: [],
					stdin: false,
					format: "json",
				},
				context(),
				deps({ resolveSource: () => ({ ok: false, code: "missing-session", message: "missing" }) }),
			),
		(error: unknown) => error instanceof UsageError && error.message === "missing",
	);
	const failed = await runDurableMessageCommand(
		{
			command: "crew-broadcast",
			intent: "broadcast",
			message: "x",
			instructions: [],
			stdin: false,
			format: "json",
		},
		context(),
		deps({ deliver: async () => ({ ok: false, code: "offline-session" }) }),
	);
	assert.equal(failed.kind, "result");
	if (failed.kind !== "result") return;
	assert.equal(failed.result.ok, false);
	assert.equal(failed.result.error?.code, "offline-session");
});

test("Inbox remains durable while broadcast reports partial live delivery", async () => {
	const inbox = await runDurableMessageCommand(
		{
			command: "member-inbox-send",
			intent: "inbox",
			member: "Kelly",
			message: "hello",
			instructions: ["one"],
			stdin: false,
			format: "json",
		},
		context(),
		deps(),
	);
	assert.equal(inbox.kind, "result");
	if (inbox.kind !== "result") return;
	assert.equal(inbox.result.ok, true);
	assert.equal(inbox.result.status, "persisted");
	assert.equal((inbox.result.data as { persisted: boolean }).persisted, true);

	const broadcast = await runDurableMessageCommand(
		{
			command: "crew-broadcast",
			intent: "broadcast",
			message: "hello",
			instructions: [],
			stdin: false,
			format: "json",
		},
		context(),
		deps({
			deliver: async () => ({
				ok: true,
				result: {
					dispositions: [{ member: "Mary", role: "po", disposition: "failed", code: "offline" }],
					summary: { delivered: 0, failed: 1, total: 1 },
				},
			}),
		}),
	);
	assert.equal(broadcast.kind, "result");
	if (broadcast.kind !== "result") return;
	assert.equal(broadcast.result.ok, false);
	assert.equal(broadcast.result.status, "partial");
	assert.equal(broadcast.result.error?.code, "partial");
});

test("tool and CLI preserve separate Inbox and live Broadcast contracts", async () => {
	const membership = {
		manifestPath: "/project/.pi/bebop/crew.json",
		socketPath: "/project/.pi/bebop/sockets/lead.sock",
		member: {
			name: "Tony",
			role: "lead",
			socket: "/project/.pi/bebop/sockets/lead.sock",
			socketPath: "/project/.pi/bebop/sockets/lead.sock",
		},
		manifest: {
			members: [
				{
					name: "Tony",
					role: "lead",
					socket: "/project/.pi/bebop/sockets/lead.sock",
					socketPath: "/project/.pi/bebop/sockets/lead.sock",
				},
				{
					name: "Mary",
					role: "po",
					socket: "/project/.pi/bebop/sockets/po.sock",
					socketPath: "/project/.pi/bebop/sockets/po.sock",
				},
			],
		},
	};
	const state = {
		membershipRuntime: { getMembership: () => membership },
		context: { isProjectTrusted: () => true },
	} as never;
	const registered = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
	const pi = {
		registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any> }) =>
			registered.set(tool.name, tool),
	} as never;
	registerSendToInboxTool(pi, state, {
		isProjectTrusted: () => true,
		hintTransport: null,
		openStore: async () => ({ enqueue: async () => ({ item: { id: "inbox-parity" } }) }) as never,
	});
	registerBroadcastToCrewTool(pi, state, {
		resolveEndpoint: async (socketPath) => socketPath,
		coordinator: {
			enqueue: async (_key: string, operation: () => Promise<unknown>) => operation(),
			pendingKeyCount: () => 0,
		},
		transport: {
			send: async (_endpoint, _command) =>
				({
					response: { success: true, data: { deliveryId: "delivery-parity", disposition: "queued" } },
				}) as never,
		},
	} as never);
	const inboxTool = await registered
		.get("send_to_inbox")!
		.execute("call", { member: "Mary", message: "hello", instructions: ["one"] });
	assert.equal(inboxTool.details.itemId, "inbox-parity");
	const inboxCli = await runDurableMessageCommand(
		{
			command: "member-inbox-send",
			intent: "inbox",
			member: "Mary",
			message: "hello",
			instructions: ["one"],
			stdin: false,
			format: "json",
		},
		context(),
		deps({
			deliver: async () => ({
				ok: true,
				result: {
					member: { name: "Mary", role: "po" },
					itemId: "inbox-parity",
					persisted: true,
					hint: "skipped",
				},
			}),
		}),
	);
	assert.equal(inboxCli.kind, "result");
	if (inboxCli.kind === "result")
		assert.equal((inboxCli.result.data as { itemId: string }).itemId, inboxTool.details.itemId);
	const broadcastTool = await registered
		.get("broadcast_to_crew")!
		.execute("call", { message: "hello", instructions: ["one"] });
	assert.equal(broadcastTool.isError, false);
	assert.equal(broadcastTool.details.delivered, 1);
	const broadcastCli = await runDurableMessageCommand(
		{
			command: "crew-broadcast",
			intent: "broadcast",
			message: "hello",
			instructions: ["one"],
			stdin: false,
			format: "json",
		},
		context(),
		deps({
			deliver: async () => ({
				ok: true,
				result: {
					dispositions: [
						{ member: "Mary", role: "po", deliveryId: "delivery-parity", disposition: "delivered" },
					],
					summary: { delivered: 1, failed: 0, total: 1 },
				},
			}),
		}),
	);
	assert.equal(broadcastCli.kind, "result");
	if (broadcastCli.kind === "result") assert.equal(broadcastCli.result.status, "delivered");
});
