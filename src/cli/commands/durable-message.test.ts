import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { UsageError } from "../support/arguments.ts";
import {
	buildDurableMessageCommand,
	defaultDurableMessageCliDependencies,
	readDurableMessageCommand,
	runDurableMessageCommand,
	type DurableMessageCliDependencies,
} from "./durable-message.ts";
import type { CliContext } from "../support/context.ts";
import { registerSendToInboxTool } from "../../tools/send-to-inbox.ts";
import { registerBroadcastToCrewTool } from "../../tools/broadcast-to-crew.ts";
import { Command } from "commander";

const source = {
	ok: true as const,
	kind: "id" as const,
	idSocketPath: "/source.sock",
	aliasSocketPath: "/source.sock",
};
function context(): CliContext {
	return { cwd: "/project", input: new PassThrough(), signal: new AbortController().signal };
}
function parseInto(intent: "inbox" | "broadcast", tokens: readonly string[]) {
	const command = buildDurableMessageCommand(intent)
		.exitOverride()
		.configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} });
	command.parse([...tokens], { from: "user" });
	return readDurableMessageCommand(command, intent);
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

test("durable message default transport maps stale id and alias sockets", async () => {
	const command = { type: "crew_broadcast" as const, message: "hello" };
	const same = await defaultDurableMessageCliDependencies.deliver(
		{
			ok: true,
			kind: "id",
			idSocketPath: "/tmp/missing-durable.sock",
			aliasSocketPath: "/tmp/missing-durable.sock",
		},
		command,
		new AbortController().signal,
	);
	assert.deepEqual(same, { ok: false, code: "unknown-session" });
	const fallback = await defaultDurableMessageCliDependencies.deliver(
		{
			ok: true,
			kind: "id",
			idSocketPath: "/tmp/missing-durable-id.sock",
			aliasSocketPath: "/tmp/missing-durable-alias.sock",
		},
		command,
		new AbortController().signal,
	);
	assert.deepEqual(fallback, { ok: false, code: "unknown-session" });
});

test("durable message dependencies read explicit environment sessions and process fallback", () => {
	assert.equal(defaultDurableMessageCliDependencies.environmentSession({ PI_SESSION_ID: "env-1" }), "env-1");
	const processSession = defaultDurableMessageCliDependencies.environmentSession();
	assert.ok(processSession === undefined || typeof processSession === "string");
});

test("durable message readers preserve inbox and broadcast grammar", () => {
	const inbox = parseInto("inbox", ["Kelly", "--message", "hello", "--instruction", "one"]);
	assert.deepEqual(inbox, {
		command: "member-inbox-send",
		intent: "inbox",
		member: "Kelly",
		message: "hello",
		instructions: ["one"],
		stdin: false,
		format: "text",
	});
	const broadcast = parseInto("broadcast", ["--stdin", "--format", "text", "--session", "source-1"]);
	assert.equal(broadcast.command, "crew-broadcast");
	assert.equal(broadcast.stdin, true);
	assert.equal(broadcast.format, "text");
	assert.equal(broadcast.session, "source-1");
	assert.equal(parseInto("inbox", ["Kelly", "--message", "hello", "--session", "source-1"]).session, "source-1");
});

test("durable message readers reject invalid targets, content, and source selection", () => {
	for (const tokens of [
		["--message", "hello"],
		[" Kelly", "--message", "hello"],
		["Kelly", "--format", "yaml", "--message", "hello"],
		["Kelly", "--message", "hello", "--stdin"],
		["Kelly", "--message", ""],
		["Kelly", "--message", "hello\0world"],
	] as const)
		assert.throws(() => parseInto("inbox", tokens));
	for (const tokens of [
		["--stdin", "--instruction", " padded "],
		["--stdin", "--instruction", "bad\0value"],
	] as const)
		assert.throws(() => parseInto("broadcast", tokens));
	assert.throws(() => parseInto("inbox", ["Kelly", "--message", "x".repeat(1_000_001)]), /message limit/);
	assert.throws(() => parseInto("inbox", ["Kelly", "--stdin", "--instruction", "x".repeat(100_001)]), /100000-byte/);
	const tooMany = ["--stdin"];
	for (let i = 0; i < 33; i++) tooMany.push("--instruction", String(i));
	assert.throws(() => parseInto("broadcast", tooMany), /maximum is 32/);
});

test("durable commands map stdin read failures before delivery", async () => {
	const outcome = await runDurableMessageCommand(
		{
			command: "crew-broadcast",
			intent: "broadcast",
			stdin: true,
			instructions: [],
			format: "json",
		},
		context(),
		deps({
			readStdin: async () => {
				throw new Error("stdin unavailable");
			},
		}),
	);
	assert.equal(outcome.kind, "result");
	if (outcome.kind === "result") assert.equal(outcome.result.error?.code, "stdin-error");
});

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
