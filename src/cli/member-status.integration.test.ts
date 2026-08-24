import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { PassThrough } from "node:stream";
import { createRpcServer, closeRpcServer, writeResponse } from "../infra/rpc-server.ts";
import { createOnlineMemberStatus, createOfflineMemberStatus, type MemberStatus } from "../domain/index.ts";
import {
	defaultMemberStatusCliDependencies,
	runMemberStatusCommand,
	type MemberStatusCliDependencies,
} from "./commands/member-status.ts";
import { writeOutcome } from "./output.ts";
import type { CliContext } from "./context.ts";
import type { SourceResolution } from "./source-session.ts";

/**
 * TASK-0061 real-wire proof: the CLI leaf against a real Unix-socket RPC
 * server answering the delegated `member.status_target` action. The leaf uses
 * the real transport (resolveMemberEndpoint + sendRpcCommand + strict result
 * validation) while only the source-endpoint decision is pointed at the temp
 * socket — everything else is the production path.
 */

function context(): CliContext {
	return { cwd: "/project", input: new PassThrough(), signal: new AbortController().signal };
}

async function statusServer(
	socketPath: string,
	answer: (socket: net.Socket, command: { target?: string; id?: string }) => void,
): Promise<net.Server> {
	return createRpcServer(socketPath, async (command, socket) => {
		if (command.type !== "member_status_target") return;
		answer(socket, command);
	});
}

function respondOnline(socket: net.Socket, id: string | undefined, member: { name: string; role: string }): void {
	const status = createOnlineMemberStatus({
		member,
		isIdle: false,
		hasPendingMessages: true,
		focus: { state: "reported", text: "Implementing CLI", updatedAt: "2026-08-23T12:00:00.000Z" },
		observedAt: "2026-08-23T12:03:00.000Z",
	});
	writeResponse(socket, { type: "response", command: "member_status_target", success: true, data: { status }, id });
}

test("member status CLI round-trips over a real socket and falls back from missing id socket to alias symlink", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-cli-status-"));
	const targetPath = path.join(root, "real.sock");
	const server = await statusServer(targetPath, (socket, command) => {
		assert.equal(command.target, "Kelly");
		respondOnline(socket, command.id, { name: "Kelly", role: "qa" });
	});
	t.after(async () => {
		await closeRpcServer(server);
		await fs.rm(root, { recursive: true, force: true });
	});

	// The id socket path is deliberately missing; the alias path is the live server.
	const deps: MemberStatusCliDependencies = {
		...defaultMemberStatusCliDependencies,
		resolveSource: (): SourceResolution & { ok: true } => ({
			ok: true,
			kind: "id",
			idSocketPath: path.join(root, "missing.sock"),
			aliasSocketPath: targetPath,
		}),
	};

	const outcome = await runMemberStatusCommand(
		{ command: "member-status", member: "Kelly", format: "json" },
		context(),
		deps,
	);
	assert.equal(outcome.kind, "result");
	if (outcome.kind !== "result") throw new Error("expected result");
	assert.equal(outcome.result.ok, true);
	assert.equal(outcome.result.status, "observed");
	const status = (outcome.result.data as { status: MemberStatus }).status;
	assert.equal(status.presence, "online");
	assert.equal(status.member.name, "Kelly");
	assert.equal(status.observedAt, "2026-08-23T12:03:00.000Z");

	const output = new PassThrough();
	const exit = writeOutcome(output, outcome);
	assert.equal(exit, 0);
});

test("member status CLI maps a remote rejection over the real wire to exit 1 with the stable code", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-cli-status-reject-"));
	const targetPath = path.join(root, "reject.sock");
	const server = await statusServer(targetPath, (socket, command) => {
		writeResponse(socket, {
			type: "response",
			command: "member_status_target",
			success: false,
			error: "unknown-member",
			id: command.id,
		});
	});
	t.after(async () => {
		await closeRpcServer(server);
		await fs.rm(root, { recursive: true, force: true });
	});

	const deps: MemberStatusCliDependencies = {
		...defaultMemberStatusCliDependencies,
		resolveSource: (): SourceResolution & { ok: true } => ({
			ok: true,
			kind: "id",
			idSocketPath: targetPath,
			aliasSocketPath: targetPath,
		}),
	};
	const outcome = await runMemberStatusCommand(
		{ command: "member-status", member: "nobody", format: "json" },
		context(),
		deps,
	);
	assert.equal(outcome.kind, "result");
	if (outcome.kind !== "result") throw new Error("expected result");
	assert.equal(outcome.result.ok, false);
	assert.equal(outcome.result.error?.code, "unknown-member");
	assert.equal(writeOutcome(new PassThrough(), outcome), 1);
});

test("member status CLI renders an offline presence result over the real wire as success", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-cli-status-offline-"));
	const targetPath = path.join(root, "offline.sock");
	const server = await statusServer(targetPath, (socket, command) => {
		const status = createOfflineMemberStatus({ name: "Dimmy", role: "qa1" }, "2026-08-23T12:03:00.000Z");
		writeResponse(socket, {
			type: "response",
			command: "member_status_target",
			success: true,
			data: { status },
			id: command.id,
		});
	});
	t.after(async () => {
		await closeRpcServer(server);
		await fs.rm(root, { recursive: true, force: true });
	});

	const deps: MemberStatusCliDependencies = {
		...defaultMemberStatusCliDependencies,
		resolveSource: (): SourceResolution & { ok: true } => ({
			ok: true,
			kind: "id",
			idSocketPath: targetPath,
			aliasSocketPath: targetPath,
		}),
	};
	const outcome = await runMemberStatusCommand(
		{ command: "member-status", member: "Dimmy", format: "json" },
		context(),
		deps,
	);
	assert.equal(outcome.kind, "result");
	if (outcome.kind !== "result") throw new Error("expected result");
	assert.equal(outcome.result.ok, true);
	const status = (outcome.result.data as { status: MemberStatus }).status;
	assert.equal(status.presence, "offline");
	assert.equal(writeOutcome(new PassThrough(), outcome), 0);
});
