import test from "node:test";
import assert from "node:assert/strict";
import { RpcProtocolError } from "../../infra/rpc-client.ts";
import { MAX_MEMBER_REQUEST_MAX_WAIT_SECONDS, MAX_MEMBER_REQUEST_TIMEOUT_SECONDS } from "../../domain/index.ts";
import {
	parseMemberRequestSendCommand,
	parseMemberRequestListCommand,
	parseMemberRequestWaitCommand,
	parseMemberRequestRespondCommand,
	runMemberRequestCommand,
} from "./member-request.ts";

const sendArgs = [
	"Dev",
	"--message",
	"status?",
	"--response-grace",
	"30s",
	"--max-wait",
	"5m",
	"--instruction",
	"ordered",
];

test("Member Request CLI parses exact lifecycle surfaces and bounded durations", () => {
	assert.deepEqual(parseMemberRequestSendCommand(sendArgs), {
		command: "member-request-send",
		member: "Dev",
		message: "status?",
		stdin: false,
		instructions: ["ordered"],
		responseGraceSeconds: 30,
		maxWaitSeconds: 300,
		direction: "all",
		format: "toon",
	});
	assert.equal(parseMemberRequestListCommand(["--direction", "inbound"]).direction, "inbound");
	assert.equal(parseMemberRequestWaitCommand(["opaque-id"]).requestId, "opaque-id");
	assert.equal(parseMemberRequestRespondCommand(["opaque-id", "--message", "answer"]).requestId, "opaque-id");
});

test("Member Request CLI rejects max-wait not strictly greater than grace and duplicate values", () => {
	assert.throws(
		() => parseMemberRequestSendCommand(["Dev", "--message", "x", "--response-grace", "5m", "--max-wait", "5m"]),
		/strictly greater/,
	);
	assert.throws(() => parseMemberRequestListCommand(["--direction", "bad"]), /Invalid --direction/);
	assert.throws(() => parseMemberRequestWaitCommand(["id", "--session", "a", "--session", "b"]), /Duplicate flag/);
});

test("Member Request CLI parses help, aliases, repeated instructions, and invalid input", () => {
	assert.equal(parseMemberRequestSendCommand(["--help", "--format", "json"]).help, true);
	assert.equal(parseMemberRequestListCommand(["--help"]).help, true);
	assert.equal(parseMemberRequestWaitCommand(["--help"]).help, true);
	assert.equal(parseMemberRequestRespondCommand(["--help"]).help, true);
	assert.equal(
		parseMemberRequestSendCommand([
			"Dev",
			"--message=status?",
			"--instruction=first",
			"--instruction",
			"second",
			"--session",
			"alias",
			"--format",
			"json",
		]).format,
		"json",
	);
	assert.deepEqual(parseMemberRequestSendCommand(["Dev", "--message", "x", "--instruction=first"]).instructions, [
		"first",
	]);
	assert.throws(() => parseMemberRequestSendCommand([]), /missing required argument 'member'|Missing <member>/);
	assert.throws(() => parseMemberRequestSendCommand([" Dev", "--message", "x"]), /Missing <member>/);
	assert.throws(() => parseMemberRequestSendCommand(["Dev"]), /Missing message source/);
	assert.throws(() => parseMemberRequestSendCommand(["Dev", "--message", "x", "--stdin"]), /Choose exactly one/);
	assert.throws(() => parseMemberRequestSendCommand(["Dev", "--message", " "]), /must not be empty/);
	assert.throws(
		() => parseMemberRequestSendCommand(["Dev", "--message", "x", "--response-grace", "bad"]),
		/Invalid --response-grace/,
	);
	assert.throws(
		() => parseMemberRequestSendCommand(["Dev", "--message", "x", "--response-grace", "500ms"]),
		/whole-second/,
	);
	assert.throws(
		() => parseMemberRequestSendCommand(["Dev", "--message", "x", "--response-grace", "0s"]),
		/whole-second/,
	);
	assert.throws(() => parseMemberRequestSendCommand(["Dev", "--message", "x", "--max-wait", "3h"]), /whole-second/);
	assert.throws(() => parseMemberRequestSendCommand(["Dev", "--message", "x", "--instruction"]), /Missing value/);
	assert.throws(() => parseMemberRequestSendCommand(["Dev", "--message", "x", "--help", "--help"]), /Duplicate flag/);
	assert.throws(() => parseMemberRequestSendCommand(["Dev", "--message", "x", "--bogus"]), /unknown option/);
	assert.throws(() => parseMemberRequestListCommand(["--format", "yaml"]), /Invalid --format/);
	assert.throws(() => parseMemberRequestWaitCommand([" id "]), /Missing exact/);
	assert.throws(() => parseMemberRequestRespondCommand(["id"]), /Missing message source/);
});

test("Member Request CLI renders every leaf help contract", () => {
	for (const kind of ["send", "list", "wait", "respond"] as const) {
		const options =
			kind === "send"
				? parseMemberRequestSendCommand(["--help"])
				: kind === "list"
					? parseMemberRequestListCommand(["--help"])
					: kind === "wait"
						? parseMemberRequestWaitCommand(["--help"])
						: parseMemberRequestRespondCommand(["--help"]);
		const outcome = runMemberRequestCommand(options, {
			cwd: "/tmp",
			input: process.stdin,
			signal: new AbortController().signal,
		});
		assert.equal(outcome instanceof Promise, true);
	}
});

test("Member Request CLI maps transport, remote, timeout, and abort failures", async () => {
	const options = parseMemberRequestWaitCommand(["opaque-id"]);
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
			)) as any
		).result.error.code,
		"outcome-consumed",
	);
	assert.equal(
		(
			(await runMemberRequestCommand(
				options,
				context,
				dependencies(new RpcProtocolError("remote-error", "unknown-request")),
			)) as any
		).result.error.code,
		"unknown-request",
	);
	const abort = new Error("aborted");
	abort.name = "AbortError";
	assert.equal(
		((await runMemberRequestCommand(options, context, dependencies(abort))) as any).result.error.code,
		"aborted",
	);
	assert.equal(
		((await runMemberRequestCommand(options, context, dependencies(new Error("RPC request timeout")))) as any)
			.result.error.code,
		"timeout",
	);
	assert.equal(
		((await runMemberRequestCommand(options, context, dependencies(new Error("socket failed")))) as any).result
			.error.code,
		"offline",
	);
	const rejected = await runMemberRequestCommand(options, context, {
		...dependencies(new Error("unused")),
		send: async () => ({ response: { success: false, error: "remote-rejected" } as any }),
	});
	assert.equal((rejected as any).result.error.code, "offline");
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
				return { response: { success: true, data: { requests: [], omitted: 0 } } as any };
			if (command.type === "member_request_wait")
				return {
					response: {
						success: true,
						data: {
							kind: "offline",
							requestId: command.requestId,
							member: { name: "Dev", role: "developer" },
						},
					} as any,
				};
			return { response: { success: true, data: {} } as any };
		},
		readStdin: async () => "",
		environmentSession: () => undefined,
	};
	const context = { cwd: "/tmp", input: process.stdin, signal: new AbortController().signal };
	const listed = await runMemberRequestCommand(parseMemberRequestListCommand(["--format", "text"]), context, deps);
	const waited = await runMemberRequestCommand(parseMemberRequestWaitCommand(["opaque-id"]), context, deps);
	const responded = await runMemberRequestCommand(
		parseMemberRequestRespondCommand(["inbound-id", "--message", "done"]),
		context,
		deps,
	);
	assert.equal((listed as any).result.status, "listed");
	assert.equal((waited as any).result.status, "offline");
	assert.equal((responded as any).result.status, "response-accepted");
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
		parseMemberRequestSendCommand(["Dev", "--stdin"]),
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
	assert.equal((outcome as any).result.error.code, "aborted");
});

test("Member Request CLI preserves exact IDs on source-resolution failures", async () => {
	const outcome = await runMemberRequestCommand(
		parseMemberRequestWaitCommand(["opaque-wait", "--session", "missing"]),
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
	assert.deepEqual((outcome as any).result.data, { requestId: "opaque-wait" });
});

test("Member Request CLI sends through the selected source and preserves opaque IDs", async () => {
	const calls: any[] = [];
	const outcome = await runMemberRequestCommand(
		parseMemberRequestSendCommand(["Dev", "--message", "status?"]),
		{ cwd: "/tmp", input: process.stdin, signal: new AbortController().signal },
		{
			resolveSource: () => ({ ok: true, kind: "id", idSocketPath: "/id.sock", aliasSocketPath: "/alias.sock" }),
			send: async (_source, command) => {
				calls.push(command);
				return {
					response: {
						success: true,
						data: { accepted: true, requestId: "opaque-1", member: { name: "Dev", role: "developer" } },
					} as any,
				};
			},
			readStdin: async () => "",
			environmentSession: () => undefined,
		},
	);
	assert.equal(outcome.kind, "result");
	assert.equal((outcome as any).result.data.requestId, "opaque-1");
	assert.equal(calls[0].type, "member_request_start");
	assert.equal("origin" in calls[0], false);
});
