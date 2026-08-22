import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseCrewManifest } from "../domain/index.ts";
import type { MembershipRuntime } from "../infra/membership-runtime.ts";
import type { RpcClientOptions } from "../infra/rpc-client.ts";
import type { RpcCommand } from "../domain/index.ts";
import { createSocketState } from "../pi/control-runtime.ts";
import { registerMemberTool } from "./send-to-member.ts";

interface RegisteredTool {
	name: string;
	parameters: { properties?: Record<string, unknown> };
	execute: (...args: any[]) => Promise<any>;
}

const manifestPath = "/project/.pi/intray/crew.json";
const manifest = parseCrewManifest({ version: 1, members: [
	{ name: "dev", role: "developer", socket: "sockets/dev.sock" },
	{ name: "qa", role: "reviewer", socket: "sockets/qa.sock" },
] }, manifestPath);
const membership = {
	manifestPath,
	manifest,
	member: { ...manifest.members[0], socketPath: "/project/.pi/intray/sockets/dev.sock" },
	socketPath: "/project/.pi/intray/sockets/dev.sock",
	globalSocketPath: "/project/.pi/intray/global.sock",
};

function setup(sendRpcCommand: (socketPath: string, command: RpcCommand, options?: RpcClientOptions) => Promise<any>, joined = true, currentMembership = membership) {
	let tool: RegisteredTool | undefined;
	const pi = { registerTool(value: unknown) { tool = value as RegisteredTool; } } as unknown as ExtensionAPI;
	const state = createSocketState();
	state.context = { sessionManager: { getSessionId: () => "dev-session", getSessionName: () => "dev" } } as never;
	state.membershipRuntime = { getMembership: () => joined ? currentMembership : null } as unknown as MembershipRuntime;
	registerMemberTool(pi, state, { sendRpcCommand });
	assert.ok(tool);
	return { tool, state };
}

const ok = (data: unknown = { delivered: true }) => ({ response: { type: "response", command: "send", success: true, data } });

test("send_to_member exposes member, message, and shared response policy parameters", () => {
	const { tool } = setup(async () => ok());
	assert.equal(tool.name, "send_to_member");
	assert.deepEqual(Object.keys(tool.parameters.properties ?? {}).sort(), ["member", "message", "mode", "reply_behavior", "wait_until"]);
});

test("sends to a manifest member with role identity, signal, and synchronous response", async () => {
	const calls: Array<{ socketPath: string; command: RpcCommand; options?: RpcClientOptions }> = [];
	const { tool } = setup(async (socketPath, command, options) => { calls.push({ socketPath, command, options }); return { ...ok(), event: { message: { content: "done" } } }; });
	const signal = new AbortController().signal;
	const result = await tool.execute("call", { member: "qa", message: "hello", mode: "follow_up" }, signal, undefined, undefined);
	assert.equal(result.isError, undefined);
	assert.match(result.content[0].text, /qa \(reviewer\)/);
	assert.deepEqual(calls, [{ socketPath: "/project/.pi/intray/sockets/qa.sock", command: { type: "send", message: "hello", mode: "follow_up" }, options: { timeout: 300000, waitForEvent: "turn_end", signal } }]);
});

test("rejects unjoined, unknown, and self targets without RPC", async () => {
	let calls = 0;
	const send = async () => { calls += 1; return ok(); };
	assert.equal((await setup(send, false).tool.execute("call", { member: "qa", message: "x" }, new AbortController().signal, undefined, undefined)).isError, true);
	assert.match((await setup(send).tool.execute("call", { member: "missing", message: "x" }, new AbortController().signal, undefined, undefined)).content[0].text, /Unknown/);
	assert.match((await setup(send).tool.execute("call", { member: "dev", message: "x" }, new AbortController().signal, undefined, undefined)).content[0].text, /yourself/);
	assert.equal(calls, 0);
});

test("forwards abort signals and reports an aborted request", async () => {
	const controller = new AbortController();
	controller.abort();
	const result = await setup(async (_path, _command, options) => {
		assert.equal(options?.signal, controller.signal);
		throw new Error("Operation aborted");
	}).tool.execute("call", { member: "qa", message: "x" }, controller.signal, undefined, undefined);
	assert.equal(result.isError, true);
	assert.equal(result.content[0].text, "[qa (reviewer)] Member request aborted");
	const abortError = await setup(async () => { throw Object.assign(new Error("cancelled"), { name: "AbortError" }); }).tool.execute("call", { member: "qa", message: "x" }, new AbortController().signal, undefined, undefined);
	assert.equal(abortError.content[0].text, "[qa (reviewer)] Member request aborted");
});

test("reuses asynchronous policy, forwards abort, and reports offline endpoints", async () => {
	const controller = new AbortController();
	let callOptions: RpcClientOptions | undefined;
	const { tool } = setup(async (_path, _command, options) => { callOptions = options; return ok(); });
	const delivered = await tool.execute("call", { member: "qa", message: "x", wait_until: "message_processed", reply_behavior: "end_conversation" }, controller.signal, undefined, undefined);
	assert.match(delivered.content[0].text, /Message delivered/);
	assert.deepEqual(callOptions, { signal: controller.signal });
	const offline = await setup(async () => { throw new Error("socket closed"); }).tool.execute("call", { member: "qa", message: "x" }, controller.signal, undefined, undefined);
	assert.equal(offline.isError, true);
	assert.equal(offline.content[0].text, "[qa (reviewer)] Member endpoint offline: socket closed");
});

test("rejects ambiguous role targets", async () => {
	const ambiguousManifest = parseCrewManifest({ version: 1, members: [
		{ name: "dev", role: "developer", socket: "sockets/dev.sock" },
		{ name: "qa", role: "reviewer", socket: "sockets/qa.sock" },
		{ name: "qa2", role: "reviewer", socket: "sockets/qa2.sock" },
	] }, manifestPath);
	const ambiguousMembership = { ...membership, manifest: ambiguousManifest };
	const result = await setup(async () => ok(), true, ambiguousMembership).tool.execute("call", { member: "reviewer", message: "x" }, new AbortController().signal, undefined, undefined);
	assert.equal(result.isError, true);
	assert.equal(result.content[0].text, "[dev (developer)] Ambiguous crew role: reviewer");
});
