import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { createRpcServer, closeRpcServer } from "../infra/rpc-server.ts";
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

test("durable Inbox and broadcast CLI leaves delegate over a real source dispatcher to trusted stores", async (t) => {
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
	state.broadcastStoreDependencies = {
		isProjectTrusted: () => true,
		openStore: (options) => openTrustedMemberInboxStore(options),
	} as never;
	const server = await createRpcServer(sourceSocket, (command, socket) =>
		handleCommand({} as never, state, command, socket),
	);
	t.after(async () => {
		await closeRpcServer(server);
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
	assert.equal(broadcast.result.ok, true);
	assert.equal(broadcast.result.status, "persisted");
	const data = broadcast.result.data as { summary: { persisted: number; total: number } };
	assert.deepEqual(data.summary, { persisted: 2, alreadyPersisted: 0, failed: 0, total: 2 });

	const inboxStore = await openTrustedMemberInboxStore({
		manifestPath,
		projectRoot: root,
		isProjectTrusted: () => true,
		member: members[2]!,
	});
	assert.equal(await inboxStore.count(), 2);
});
