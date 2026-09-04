import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MemberRequestFlow } from "../application/member-request-flow.ts";
import { sendMemberRequest, sendRpcCommand } from "../infra/rpc-client.ts";
import { resolveMemberEndpoint } from "../infra/socket-endpoint.ts";
import { createRpcServer, closeRpcServer } from "../infra/rpc-server.ts";
import { createSocketState, handleCommand } from "./control-runtime.ts";
import {
	parseMemberRequestSendCommand,
	parseMemberRequestListCommand,
	parseMemberRequestWaitCommand,
	parseMemberRequestRespondCommand,
	runMemberRequestCommand,
} from "../cli/commands/member-request.ts";

function membership(
	member: { name: string; role: string; socketPath: string },
	peer: { name: string; role: string; socketPath: string },
) {
	return {
		manifestPath: "/project/.pi/bebop/crew.json",
		socketPath: member.socketPath,
		member,
		manifest: { members: [member, peer] },
	} as any;
}
function sourceDeps(socketPath: string) {
	return {
		resolveSource: () => ({
			ok: true as const,
			kind: "id" as const,
			idSocketPath: socketPath,
			aliasSocketPath: socketPath,
		}),
		send: async (source: any, command: any, timeout: number, signal: AbortSignal) =>
			sendRpcCommand(source.idSocketPath, command, { timeout, signal }),
		readStdin: async () => "unused",
		environmentSession: () => undefined,
	};
}
function context(signal = new AbortController().signal) {
	return { cwd: "/tmp", input: process.stdin, signal };
}

async function createRuntimePair(
	root: string,
	sourceFlow: MemberRequestFlow,
	targetFlow: MemberRequestFlow,
	onSourceCommand?: (command: any) => void,
) {
	const sourcePath = path.join(root, "source.sock");
	const targetPath = path.join(root, "target.sock");
	const sourceMember = { name: "Alex", role: "lead", socketPath: sourcePath };
	const targetMember = { name: "Blake", role: "qa", socketPath: targetPath };
	const sourceState = createSocketState();
	sourceState.context = { isProjectTrusted: () => true } as any;
	sourceState.membershipRuntime = { getMembership: () => membership(sourceMember, targetMember) } as any;
	sourceState.memberRequestFlow = sourceFlow;
	const targetState = createSocketState();
	targetState.context = { isProjectTrusted: () => true } as any;
	targetState.membershipRuntime = { getMembership: () => membership(targetMember, sourceMember) } as any;
	targetState.memberRequestFlow = targetFlow;
	const sourceServer = await createRpcServer(sourcePath, (command, socket) => {
		onSourceCommand?.(command);
		return handleCommand({ sendMessage: () => undefined } as any, sourceState, command, socket);
	});
	const targetServer = await createRpcServer(targetPath, (command, socket) =>
		handleCommand({ sendMessage: () => undefined } as any, targetState, command, socket),
	);
	return { sourcePath, targetPath, sourceState, targetState, sourceServer, targetServer };
}

test("CLI send/list/respond/wait uses one exact Request ID across two real runtimes", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "member-request-cli-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const sourcePath = path.join(root, "source.sock");
	const targetPath = path.join(root, "target.sock");
	const sourceMember = { name: "Alex", role: "lead", socketPath: sourcePath };
	const targetMember = { name: "Blake", role: "qa", socketPath: targetPath };
	const sourceState = createSocketState();
	sourceState.context = { isProjectTrusted: () => true } as any;
	sourceState.membershipRuntime = { getMembership: () => membership(sourceMember, targetMember) } as any;
	const targetState = createSocketState();
	targetState.context = { isProjectTrusted: () => true } as any;
	targetState.membershipRuntime = { getMembership: () => membership(targetMember, sourceMember) } as any;
	const sourceFlow = new MemberRequestFlow({
		transport: {
			open: (endpoint, command, options) =>
				sendMemberRequest(endpoint, command, {
					timeout: options.timeoutMs,
					signal: options.signal,
					onUpdate: options.onUpdate,
				}),
			respond: async (channel, update) => channel.send(update),
		},
		resolveEndpoint: resolveMemberEndpoint,
		createRequestId: () => "cli-request-1",
	});
	const targetFlow = new MemberRequestFlow({
		transport: { open: async () => ({ close: () => undefined }), respond: async () => undefined },
		resolveEndpoint: resolveMemberEndpoint,
	});
	sourceState.memberRequestFlow = sourceFlow;
	targetState.memberRequestFlow = targetFlow;
	const sourceServer = await createRpcServer(sourcePath, (command, socket) => {
		return handleCommand({ sendMessage: () => undefined } as any, sourceState, command, socket);
	});
	const targetServer = await createRpcServer(targetPath, (command, socket) => {
		return handleCommand({ sendMessage: () => undefined } as any, targetState, command, socket);
	});
	t.after(async () => {
		await closeRpcServer(sourceServer);
		await closeRpcServer(targetServer);
	});
	const depsToSource = sourceDeps(sourcePath);
	const send = await runMemberRequestCommand(
		parseMemberRequestSendCommand(["Blake", "--message", "Need evidence"]),
		context(),
		depsToSource,
	);
	assert.equal(send.kind, "result");
	const requestId = (send as any).result.data.requestId;
	assert.equal(requestId, "cli-request-1");
	const listed = await runMemberRequestCommand(
		parseMemberRequestListCommand(["--direction", "outbound"]),
		context(),
		depsToSource,
	);
	assert.equal((listed as any).result.data.requests[0].requestId, requestId);
	const respond = await runMemberRequestCommand(
		parseMemberRequestRespondCommand([requestId, "--message", "Evidence attached", "--instruction", "review it"]),
		context(),
		sourceDeps(targetPath),
	);
	assert.equal((respond as any).result.status, "response-accepted");
	const waited = await runMemberRequestCommand(parseMemberRequestWaitCommand([requestId]), context(), depsToSource);
	assert.equal((waited as any).result.status, "response");
	assert.equal((waited as any).result.data.message, "Evidence attached");
	assert.deepEqual((waited as any).result.data.instructions, ["review it"]);
	const consumed = await runMemberRequestCommand(parseMemberRequestWaitCommand([requestId]), context(), depsToSource);
	assert.equal((consumed as any).result.error.code, "outcome-consumed");
});

test("CLI exact wait covers idle timeout, offline outcome, and cancellation without polling", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "member-request-cli-outcomes-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const scheduled: Array<() => void> = [];
	const sourceFlow = new MemberRequestFlow({
		transport: {
			open: (endpoint, command, options) =>
				sendMemberRequest(endpoint, command, {
					timeout: options.timeoutMs,
					signal: options.signal,
					onUpdate: options.onUpdate,
				}),
			respond: async (channel, update) => channel.send(update),
		},
		resolveEndpoint: resolveMemberEndpoint,
		createRequestId: (() => {
			const ids = ["cli-idle", "cli-offline", "cli-cancel"];
			return () => ids.shift()!;
		})(),
		setTimeout: (callback) => {
			scheduled.push(callback);
			return callback as any;
		},
		clearTimeout: () => undefined,
	});
	const targetFlow = new MemberRequestFlow({
		transport: { open: async () => ({ close: () => undefined }), respond: async () => undefined },
		resolveEndpoint: resolveMemberEndpoint,
	});
	let waitSeenResolve!: () => void;
	const waitSeen = new Promise<void>((resolve) => {
		waitSeenResolve = resolve;
	});
	const pair = await createRuntimePair(root, sourceFlow, targetFlow, (command) => {
		if (command.type === "member_request_wait") waitSeenResolve();
	});
	t.after(async () => {
		await closeRpcServer(pair.sourceServer);
		await closeRpcServer(pair.targetServer);
	});

	const deps = sourceDeps(pair.sourcePath);
	const idleSend = await runMemberRequestCommand(
		parseMemberRequestSendCommand(["Blake", "--message", "idle", "--response-grace", "1s"]),
		context(),
		deps,
	);
	assert.equal(idleSend.kind, "result");
	await targetFlow.settleAllInboundIdle();
	// The target write and source notification callback each cross an I/O turn.
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(scheduled.length, 2, "accepted request has hard and post-idle timers");
	scheduled[1]!();
	const idleWait = await runMemberRequestCommand(parseMemberRequestWaitCommand(["cli-idle"]), context(), deps);
	assert.equal((idleWait as any).result.status, "timeout");
	assert.equal((idleWait as any).result.data.reason, "response-after-idle");

	const offlineSend = await runMemberRequestCommand(
		parseMemberRequestSendCommand(["Blake", "--message", "offline"]),
		context(),
		deps,
	);
	assert.equal(offlineSend.kind, "result");
	sourceFlow.cancelRequest("cli-offline");
	const offlineWait = await runMemberRequestCommand(parseMemberRequestWaitCommand(["cli-offline"]), context(), deps);
	assert.equal((offlineWait as any).result.status, "offline");

	const cancelSend = await runMemberRequestCommand(
		parseMemberRequestSendCommand(["Blake", "--message", "cancel"]),
		context(),
		deps,
	);
	assert.equal(cancelSend.kind, "result");
	const controller = new AbortController();
	const canceledPromise = runMemberRequestCommand(
		parseMemberRequestWaitCommand(["cli-cancel"]),
		context(controller.signal),
		deps,
	);
	await waitSeen;
	controller.abort();
	const canceled = await canceledPromise;
	assert.equal((canceled as any).result.error.code, "aborted");
	assert.equal(sourceFlow.registry.outboundCount(), 1, "cancelling CLI wait preserves accepted Request");
	sourceFlow.cancelRequest("cli-cancel");
	const laterWait = await runMemberRequestCommand(parseMemberRequestWaitCommand(["cli-cancel"]), context(), deps);
	assert.equal((laterWait as any).result.status, "offline");
});
