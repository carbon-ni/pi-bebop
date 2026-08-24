import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import {
	durableMessageHelp,
	parseDurableMessageCommand,
	runDurableMessageCommand,
	type DurableMessageCliDependencies,
} from "./durable-message.ts";
import type { CliContext } from "../context.ts";
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
							broadcastId: "broadcast-1",
							dispositions: [{ member: "Mary", role: "po", itemId: "item-1", disposition: "persisted" }],
							summary: { persisted: 1, alreadyPersisted: 0, failed: 0, total: 1 },
						},
					},
		environmentSession: () => undefined,
		...overrides,
	};
}

test("durable commands parse target/message sources and preserve instruction order", () => {
	assert.deepEqual(
		parseDurableMessageCommand(
			["Kelly", "--message", "hello", "--instruction", "one", "--instruction", "two"],
			"inbox",
		),
		{
			command: "member-inbox-send",
			intent: "inbox",
			member: "Kelly",
			message: "hello",
			instructions: ["one", "two"],
			stdin: false,
			format: "toon",
		},
	);
	assert.deepEqual(parseDurableMessageCommand(["--stdin", "--format", "json"], "broadcast"), {
		command: "crew-broadcast",
		intent: "broadcast",
		instructions: [],
		stdin: true,
		format: "json",
	});
	assert.throws(() => parseDurableMessageCommand(["Kelly", "--message", "x", "--stdin"], "inbox"), /exactly one/);
	assert.throws(
		() => parseDurableMessageCommand(["--wait", "response", "--message", "x"], "broadcast"),
		/persisted-only/,
	);
});

test("durable commands run Inbox persistence and broadcast partial outcomes without delivery claims", async () => {
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
					broadcastId: "broadcast-1",
					dispositions: [
						{ member: "Mary", role: "po", itemId: "item-1", disposition: "failed", code: "inbox-full" },
					],
					summary: { persisted: 0, alreadyPersisted: 0, failed: 1, total: 1 },
				},
			}),
		}),
	);
	assert.equal(broadcast.kind, "result");
	if (broadcast.kind !== "result") return;
	assert.equal(broadcast.result.ok, false);
	assert.equal(broadcast.result.status, "partial");
	assert.equal(broadcast.result.error?.code, "partial");

	const conflict = await runDurableMessageCommand(
		{
			command: "crew-broadcast",
			intent: "broadcast",
			message: "changed",
			instructions: [],
			stdin: false,
			format: "json",
		},
		context(),
		deps({
			deliver: async () => ({
				ok: true,
				result: {
					broadcastId: "broadcast-1",
					dispositions: [
						{
							member: "Mary",
							role: "po",
							itemId: "item-1",
							disposition: "failed",
							code: "idempotency-conflict",
						},
					],
					summary: { persisted: 0, alreadyPersisted: 0, failed: 1, total: 1 },
				},
			}),
		}),
	);
	assert.equal(conflict.kind, "result");
	if (conflict.kind !== "result") return;
	assert.equal(conflict.result.error?.code, "idempotency-conflict");
});

test("tool and CLI parity preserve persisted Inbox and broadcast outcomes", async () => {
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
		isProjectTrusted: () => true,
		openStore: async () =>
			({ enqueueWithId: async (_payload: unknown, _now: number, id: string) => ({ item: { id } }) }) as never,
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
	assert.equal(broadcastTool.details.broadcastId.startsWith("broadcast-"), true);
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
					broadcastId: broadcastTool.details.broadcastId,
					dispositions: [{ member: "Mary", role: "po", itemId: "x", disposition: "persisted" }],
					summary: { persisted: 1, alreadyPersisted: 0, failed: 0, total: 1 },
				},
			}),
		}),
	);
	assert.equal(broadcastCli.kind, "result");
	if (broadcastCli.kind === "result")
		assert.equal(
			(broadcastCli.result.data as { broadcastId: string }).broadcastId,
			broadcastTool.details.broadcastId,
		);
});

test("durable help teaches persistence-only semantics and broadcast limitation", () => {
	assert.match(durableMessageHelp("inbox"), /persisted.*never read, delivered/i);
	assert.match(durableMessageHelp("inbox"), /no wait_for flag/i);
	assert.match(durableMessageHelp("broadcast"), /idempotency-conflict/i);
});
