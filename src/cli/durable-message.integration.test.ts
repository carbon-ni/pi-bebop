import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { createRpcServer, closeRpcServer } from "../infra/rpc-server.ts";
import { sendRpcCommand } from "../infra/rpc-client.ts";
import { resolveMemberEndpoint } from "../infra/socket-endpoint.ts";
import { createMemberMessageCoordinator } from "../application/member-message.ts";
import { createSocketState, handleCommand } from "../pi/control-runtime.ts";
import { openTrustedMemberInboxStore } from "../infra/member-inbox-store.ts";
import {
	runDurableMessageCommand,
	defaultDurableMessageCliDependencies,
	type DurableMessageCliDependencies,
} from "./commands/durable-message.ts";
import type { CliContext } from "./context.ts";
import type { SourceResolution } from "./source-session.ts";

function context(): CliContext {
	return { cwd: "/project", input: new PassThrough(), signal: new AbortController().signal };
}

test("Inbox CLI remains durable while Broadcast CLI leaves deliver live Follow-ups over real sockets", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-durable-cli-"));
	const layout = path.join(root, ".pi", "bebop");
	const manifestPath = path.join(layout, "crew.json");
	const sourceSocket = path.join(layout, "source.sock");
	const sockets = path.join(layout, "sockets");
	await fs.mkdir(sockets, { recursive: true });
	await fs.writeFile(manifestPath, JSON.stringify({ version: 1, members: [] }));
	const members = [
		{
			name: "Tony",
			role: "lead",
			socket: path.join(sockets, "lead.sock"),
			socketPath: path.join(sockets, "lead.sock"),
		},
		{ name: "Mary", role: "po", socket: path.join(sockets, "po.sock"), socketPath: path.join(sockets, "po.sock") },
		{ name: "Kelly", role: "qa", socket: path.join(sockets, "qa.sock"), socketPath: path.join(sockets, "qa.sock") },
	];
	const state = createSocketState();
	state.server = {} as never;
	state.membershipRuntime = {
		getMembership: () => ({
			manifestPath,
			socketPath: members[0]!.socketPath,
			member: members[0]!,
			manifest: { members },
		}),
	} as never;
	state.context = {
		hasUI: false,
		sessionManager: { getSessionId: () => "source", getSessionName: () => null, getEntries: () => [] },
		isIdle: () => true,
		hasPendingMessages: () => false,
		isProjectTrusted: () => true,
	} as never;
	state.memberInboxMessageDependencies = {
		isProjectTrusted: () => true,
		openStore: (options) => openTrustedMemberInboxStore(options),
		hintTransport: null,
	} as never;
	const targetMessages = new Map<string, string[]>();
	const targetServers = await Promise.all(
		members.slice(1).map(async (member) => {
			const targetState = createSocketState(() => 4_000);
			targetState.server = {} as never;
			targetState.membershipRuntime = {
				getMembership: () => ({
					manifestPath,
					socketPath: member.socketPath,
					member,
					manifest: { members: [member] },
				}),
			} as never;
			targetState.context = {
				hasUI: false,
				sessionManager: { getSessionId: () => member.name, getSessionName: () => null, getEntries: () => [] },
				isIdle: () => true,
				hasPendingMessages: () => false,
				isProjectTrusted: () => true,
			} as never;
			const messages: string[] = [];
			targetMessages.set(member.name, messages);
			return createRpcServer(member.socketPath, (command, socket) =>
				handleCommand({ sendMessage: (message: { content: string }) => messages.push(message.content) } as never, targetState, command, socket),
			);
		}),
	);
	state.memberMessageDependencies = {
		transport: { send: sendRpcCommand },
		resolveEndpoint: resolveMemberEndpoint,
		coordinator: createMemberMessageCoordinator(),
		now: () => 1_000,
	};
	const server = await createRpcServer(sourceSocket, (command, socket) =>
		handleCommand({} as never, state, command, socket),
	);
	t.after(async () => {
		await closeRpcServer(server);
		await Promise.all(targetServers.map((target) => closeRpcServer(target)));
		await fs.rm(root, { recursive: true, force: true });
	});
	const source: SourceResolution & { ok: true } = {
		ok: true,
		kind: "id",
		idSocketPath: sourceSocket,
		aliasSocketPath: sourceSocket,
	};
	const dependencies: DurableMessageCliDependencies = {
		resolveSource: () => source,
		readStdin: async () => "stdin message",
		deliver: (sourceValue, command, signal) =>
			defaultDurableMessageCliDependencies.deliver(sourceValue, command, signal),
		environmentSession: () => undefined,
	};

	const inbox = await runDurableMessageCommand(
		{
			command: "member-inbox-send",
			intent: "inbox",
			member: "Kelly",
			message: "persist one",
			instructions: ["careful"],
			stdin: false,
			format: "json",
		},
		context(),
		dependencies,
	);
	assert.equal(inbox.kind, "result");
	if (inbox.kind !== "result") throw new Error("expected inbox result");
	assert.equal(inbox.result.ok, true);
	assert.equal(inbox.result.status, "persisted");

	const broadcast = await runDurableMessageCommand(
		{
			command: "crew-broadcast",
			intent: "broadcast",
			message: "share all",
			instructions: ["ordered"],
			stdin: false,
			format: "json",
		},
		context(),
		dependencies,
	);
	assert.equal(broadcast.kind, "result");
	if (broadcast.kind !== "result") throw new Error("expected broadcast result");
	assert.equal(broadcast.result.ok, true, JSON.stringify(broadcast.result));
	assert.equal(broadcast.result.status, "delivered");
	const data = broadcast.result.data as { summary: { delivered: number; failed: number; total: number } };
	assert.deepEqual(data.summary, { delivered: 2, failed: 0, total: 2 });
	assert.ok(targetMessages.get("Mary")?.some((content) => content.startsWith("[broadcast]")), JSON.stringify(targetMessages.get("Mary")));
	assert.ok(targetMessages.get("Kelly")?.some((content) => content.startsWith("[broadcast]")), JSON.stringify(targetMessages.get("Kelly")));
	const retry = await runDurableMessageCommand(
		{
			command: "crew-broadcast",
			intent: "broadcast",
			message: "share all",
			instructions: ["ordered"],
			stdin: false,
			format: "json",
		},
		context(),
		dependencies,
	);
	assert.equal(retry.kind, "result");
	if (retry.kind !== "result") throw new Error("expected retry result");
	assert.deepEqual((retry.result.data as { summary: unknown }).summary, {
		delivered: 2,
		failed: 0,
		total: 2,
	});

	const inboxStore = await openTrustedMemberInboxStore({
		manifestPath,
		projectRoot: root,
		isProjectTrusted: () => true,
		member: members[2]!,
	});
	assert.equal(await inboxStore.count(), 1, "Broadcast must not create Inbox items");
});
