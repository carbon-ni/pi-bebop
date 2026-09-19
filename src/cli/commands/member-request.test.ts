import test from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { RpcProtocolError } from "../../infra/rpc-client.ts";
import { MAX_MEMBER_REQUEST_MAX_WAIT_SECONDS, MAX_MEMBER_REQUEST_TIMEOUT_SECONDS } from "../../domain/index.ts";
import {
	buildMemberRequestListCommand,
	buildMemberRequestRespondCommand,
	buildMemberRequestSendCommand,
	buildMemberRequestWaitCommand,
	readMemberRequestListCommand,
	readMemberRequestRespondCommand,
	readMemberRequestSendCommand,
	readMemberRequestWaitCommand,
	runMemberRequestCommand,
} from "./member-request.ts";

function parseInto(build: () => Command, tokens: readonly string[]): Command {
	const command = build()
		.exitOverride()
		.configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} });
	command.parse([...tokens], { from: "user" });
	return command;
}

test("Member Request CLI maps transport, remote, timeout, and abort failures", async () => {
	const options = readMemberRequestWaitCommand(parseInto(buildMemberRequestWaitCommand, ["opaque-id"]));
	const context = { cwd: "/tmp", input: process.stdin, signal: new AbortController().signal };
	const dependencies = (error: unknown) => ({
		resolveSource: () => ({
			ok: true as const,
			kind: "id" as const,
			idSocketPath: "/id.sock",
			aliasSocketPath: "/alias.sock",
		}),
		send: async () => {
			throw error;
		},
		readStdin: async () => "",
		environmentSession: () => undefined,
	});
	assert.equal(
		(
			(await runMemberRequestCommand(
				options,
				context,
				dependencies(new RpcProtocolError("outcome-consumed", "consumed")),
			)) as { result: { error: { code: string } } }
		).result.error.code,
		"outcome-consumed",
	);
	assert.equal(
		(
			(await runMemberRequestCommand(
				options,
				context,
				dependencies(new RpcProtocolError("remote-error", "unknown-request")),
			)) as { result: { error: { code: string } } }
		).result.error.code,
		"unknown-request",
	);
	const abort = new Error("aborted");
	abort.name = "AbortError";
	assert.equal(
		(
			(await runMemberRequestCommand(options, context, dependencies(abort))) as {
				result: { error: { code: string } };
			}
		).result.error.code,
		"aborted",
	);
	assert.equal(
		(
			(await runMemberRequestCommand(options, context, dependencies(new Error("RPC request timeout")))) as {
				result: { error: { code: string } };
			}
		).result.error.code,
		"timeout",
	);
	assert.equal(
		(
			(await runMemberRequestCommand(options, context, dependencies(new Error("socket failed")))) as {
				result: { error: { code: string } };
			}
		).result.error.code,
		"offline",
	);
	const rejected = await runMemberRequestCommand(options, context, {
		...dependencies(new Error("unused")),
		send: async () => ({ response: { success: false, error: "remote-rejected" } as never }),
	});
	assert.equal((rejected as { result: { error: { code: string } } }).result.error.code, "offline");
});

test("Member Request CLI dispatches list, wait, and respond leaves", async () => {
	const calls: any[] = [];
	const timeouts: number[] = [];
	const deps = {
		resolveSource: () => ({
			ok: true as const,
			kind: "id" as const,
			idSocketPath: "/id.sock",
			aliasSocketPath: "/alias.sock",
		}),
		send: async (_source: unknown, command: any, timeoutMs: number) => {
			calls.push(command);
			timeouts.push(timeoutMs);
			if (command.type === "member_request_list")
				return { response: { success: true, data: { requests: [], omitted: 0 } } as never };
			if (command.type === "member_request_wait")
				return {
					response: {
						success: true,
						data: {
							kind: "offline",
							requestId: command.requestId,
							member: { name: "Dev", role: "developer" },
						},
					} as never,
				};
			return { response: { success: true, data: {} } as never };
		},
		readStdin: async () => "",
		environmentSession: () => undefined,
	};
	const context = { cwd: "/tmp", input: process.stdin, signal: new AbortController().signal };
	const listed = await runMemberRequestCommand(
		readMemberRequestListCommand(parseInto(buildMemberRequestListCommand, ["--format", "text"])),
		context,
		deps,
	);
	const waited = await runMemberRequestCommand(
		readMemberRequestWaitCommand(parseInto(buildMemberRequestWaitCommand, ["opaque-id"])),
		context,
		deps,
	);
	const responded = await runMemberRequestCommand(
		readMemberRequestRespondCommand(
			parseInto(buildMemberRequestRespondCommand, ["inbound-id", "--message", "done"]),
		),
		context,
		deps,
	);
	assert.equal((listed as { result: { status: string } }).result.status, "listed");
	assert.equal((waited as { result: { status: string } }).result.status, "offline");
	assert.equal((responded as { result: { status: string } }).result.status, "response-accepted");
	assert.deepEqual(
		calls.map((command) => command.type),
		["member_request_list", "member_request_wait", "member_response"],
	);
	assert.equal(timeouts[1], (MAX_MEMBER_REQUEST_MAX_WAIT_SECONDS + MAX_MEMBER_REQUEST_TIMEOUT_SECONDS + 10) * 1000);
});

test("Member Request CLI maps stdin cancellation to a stable failure", async () => {
	const abort = new Error("stdin aborted");
	abort.name = "AbortError";
	const outcome = await runMemberRequestCommand(
		readMemberRequestSendCommand(parseInto(buildMemberRequestSendCommand, ["Dev", "--stdin"])),
		{ cwd: "/tmp", input: process.stdin, signal: new AbortController().signal },
		{
			resolveSource: () => ({ ok: true, kind: "id", idSocketPath: "/id.sock", aliasSocketPath: "/alias.sock" }),
			send: async () => {
				throw new Error("must not send");
			},
			readStdin: async () => {
				throw abort;
			},
			environmentSession: () => undefined,
		},
	);
	assert.equal((outcome as { result: { error: { code: string } } }).result.error.code, "aborted");
});

test("Member Request CLI preserves exact IDs on source-resolution failures", async () => {
	const outcome = await runMemberRequestCommand(
		readMemberRequestWaitCommand(parseInto(buildMemberRequestWaitCommand, ["opaque-wait", "--session", "missing"])),
		{ cwd: "/tmp", input: process.stdin, signal: new AbortController().signal },
		{
			resolveSource: () => ({ ok: false, code: "source-not-found", message: "Source session was not found" }),
			send: async () => {
				throw new Error("must not send");
			},
			readStdin: async () => "",
			environmentSession: () => undefined,
		},
	);
	assert.equal(outcome.kind, "result");
	assert.deepEqual((outcome as { result: { data: unknown } }).result.data, { requestId: "opaque-wait" });
});

test("Member Request CLI sends through the selected source and preserves opaque IDs", async () => {
	const calls: any[] = [];
	const outcome = await runMemberRequestCommand(
		readMemberRequestSendCommand(parseInto(buildMemberRequestSendCommand, ["Dev", "--message", "status?"])),
		{ cwd: "/tmp", input: process.stdin, signal: new AbortController().signal },
		{
			resolveSource: () => ({ ok: true, kind: "id", idSocketPath: "/id.sock", aliasSocketPath: "/alias.sock" }),
			send: async (_source: unknown, command: any) => {
				calls.push(command);
				return {
					response: {
						success: true,
						data: { accepted: true, requestId: "opaque-1", member: { name: "Dev", role: "developer" } },
					} as never,
				};
			},
			readStdin: async () => "",
			environmentSession: () => undefined,
		},
	);
	assert.equal(outcome.kind, "result");
	assert.equal((outcome as { result: { data: { requestId: string } } }).result.data.requestId, "opaque-1");
	assert.equal(calls[0].type, "member_request_start");
	assert.equal("origin" in calls[0], false);
});
