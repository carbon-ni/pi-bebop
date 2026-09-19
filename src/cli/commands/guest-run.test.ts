import test from "node:test";
import assert from "node:assert/strict";
import { guestWireErrorCode, runGuestJoinCommand, runGuestLeaveCommand, runGuestMessageCommand } from "./guest.ts";
import type { GuestJoinCliOptions, GuestLeaveCliOptions } from "./guest.ts";
import { RpcProtocolError } from "../../infra/rpc-client.ts";

const context = { cwd: "/project", input: process.stdin, signal: new AbortController().signal };

function joinOptions(): GuestJoinCliOptions {
	return {
		command: "guest-join",
		target: "/tmp/member.sock",
		guestIdentity: "guest-session",
		guestName: "Alex",
		callback: "/tmp/callback.sock",
		format: "toon",
	};
}

function leaveOptions(): GuestLeaveCliOptions {
	return {
		command: "guest-leave",
		target: "/tmp/member.sock",
		crewId: "alpha",
		guestIdentity: "guest-session",
		callback: "/tmp/callback.sock",
		format: "toon",
	};
}

function depsWith(response?: unknown, error?: unknown) {
	const calls: Array<{ target: string; command: Record<string, unknown> }> = [];
	const deps = {
		sendCommand: async (target: string, command: Record<string, unknown>) => {
			calls.push({ target, command });
			if (error) throw error;
			return { response: response as never };
		},
	};
	return { deps, calls };
}

test("guest join reports pending admission with a deterministic next step", async () => {
	const { deps, calls } = depsWith({
		success: true,
		data: { status: "pending", requestId: "alpha-generated-1", crew: { id: "alpha", displayName: "Alpha" } },
	});
	const outcome = await runGuestJoinCommand(joinOptions(), context, deps);
	assert.equal(outcome.kind, "result");
	if (outcome.kind !== "result") return;
	assert.equal(outcome.result.ok, true);
	assert.equal(outcome.result.status, "pending");
	assert.deepEqual(outcome.result.data, {
		status: "pending",
		requestId: "alpha-generated-1",
		crew: { id: "alpha", displayName: "Alpha" },
		next: "wait for an exact configured approver to run /crew guest approve",
	});
	assert.deepEqual(calls, [
		{
			target: "/tmp/member.sock",
			command: {
				type: "guest_join",
				guestIdentity: "guest-session",
				guestName: "Alex",
				callbackEndpoint: "/tmp/callback.sock",
			},
		},
	]);
});

test("guest join reports approved admission", async () => {
	const { deps } = depsWith({
		success: true,
		data: { status: "approved", requestId: "approved-1", crew: { id: "alpha", displayName: "Alpha" } },
	});
	const outcome = await runGuestJoinCommand(joinOptions(), context, deps);
	assert.equal(outcome.kind, "result");
	if (outcome.kind === "result") assert.equal(outcome.result.data.next, "admission approved");
});

test("guest join surfaces member-side admission codes and invalid responses", async () => {
	const { deps } = depsWith(undefined, new RpcProtocolError("remote-error", "name-collision"));
	const rejected = await runGuestJoinCommand(joinOptions(), context, deps);
	assert.equal(rejected.kind, "result");
	if (rejected.kind === "result") assert.equal(rejected.result.error?.code, "name-collision");

	const { deps: invalidDeps } = depsWith({ success: true, data: { bogus: true } });
	const invalid = await runGuestJoinCommand(joinOptions(), context, invalidDeps);
	assert.equal(invalid.kind, "result");
	if (invalid.kind === "result") assert.equal(invalid.result.error?.code, "invalid-admission-response");
});

test("guest join maps transport failures to stable guest codes", async () => {
	const { deps } = depsWith(
		undefined,
		Object.assign(new Error("connect ENOENT /tmp/member.sock"), { code: "ENOENT" }),
	);
	const outcome = await runGuestJoinCommand(joinOptions(), context, deps);
	assert.equal(outcome.kind, "result");
	if (outcome.kind === "result") assert.equal(outcome.result.error?.code, "join-failed");
	assert.equal(guestWireErrorCode(new RpcProtocolError("timeout", "timed out")), "timeout");
	assert.equal(guestWireErrorCode(new RpcProtocolError("remote-error", "nope")), "nope");
	assert.equal(guestWireErrorCode(new RpcProtocolError("some-code", "x")), "some-code");
});

test("guest leave sends the exact wire command and reports a left crew", async () => {
	const { deps, calls } = depsWith({ success: true, data: {} });
	const outcome = await runGuestLeaveCommand(leaveOptions(), context, deps);
	assert.equal(outcome.kind, "result");
	if (outcome.kind !== "result") return;
	assert.equal(outcome.result.ok, true);
	assert.equal(outcome.result.status, "left");
	assert.deepEqual(outcome.result.data, { status: "left", crew: "alpha" });
	assert.deepEqual(calls, [
		{
			target: "/tmp/member.sock",
			command: {
				type: "guest_leave",
				guestIdentity: "guest-session",
				crewId: "alpha",
				callbackEndpoint: "/tmp/callback.sock",
			},
		},
	]);
});

test("guest leave keeps member-side rejection codes", async () => {
	const { deps } = depsWith(undefined, new RpcProtocolError("remote-error", "not-found"));
	const outcome = await runGuestLeaveCommand(leaveOptions(), context, deps);
	assert.equal(outcome.kind, "result");
	if (outcome.kind === "result") assert.equal(outcome.result.error?.code, "not-found");
});
