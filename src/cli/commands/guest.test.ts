import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { RpcProtocolError } from "../../infra/rpc-client.ts";
import { UsageError } from "../arguments.ts";
import {
	guestWireErrorCode,
	parseGuestJoinCommand,
	parseGuestLeaveCommand,
	runGuestJoinCommand,
	runGuestLeaveCommand,
	type GuestCliDependencies,
} from "./guest.ts";
import type { CliContext } from "../context.ts";

const context = {} as CliContext;

function depsWith(response: unknown, error?: unknown): { deps: GuestCliDependencies; calls: unknown[] } {
	const calls: unknown[] = [];
	return {
		calls,
		deps: {
			sendCommand: async (target: unknown, command: unknown) => {
				calls.push({ target, command });
				if (error !== undefined) throw error;
				return { response } as never;
			},
		},
	};
}

describe("pi-bebop guest join CLI", () => {
	test("parses the full wire surface with stable option names", () => {
		assert.deepEqual(
			parseGuestJoinCommand([
				"/tmp/member.sock",
				"--identity",
				"guest-session",
				"--as",
				"Alex",
				"--callback",
				"/tmp/callback.sock",
				"--format",
				"json",
			]),
			{
				command: "guest-join",
				target: "/tmp/member.sock",
				guestIdentity: "guest-session",
				guestName: "Alex",
				callback: "/tmp/callback.sock",
				format: "json",
			},
		);
	});

	test("rejects missing, duplicate, and empty arguments before any IO", () => {
		assert.throws(() => parseGuestJoinCommand(["/tmp/member.sock", "--as", "Alex"]), UsageError);
		assert.throws(
			() =>
				parseGuestJoinCommand([
					"/tmp/member.sock",
					"--identity",
					"i",
					"--as",
					"Alex",
					"--callback",
					"c",
					"--format",
					"yaml",
				]),
			/Invalid --format/,
		);
		assert.throws(
			() =>
				parseGuestJoinCommand([
					"/tmp/member.sock",
					"--identity",
					"",
					"--as",
					"Alex",
					"--callback",
					"/tmp/callback.sock",
				]),
			/non-empty/,
		);
		assert.throws(() => parseGuestJoinCommand(["--identity", "i", "--as", "Alex", "--callback", "c"]), UsageError);
	});

	test("reports pending admission with safe crew identity and a deterministic next step", async () => {
		const { deps, calls } = depsWith({
			success: true,
			data: { status: "pending", requestId: "alpha-generated-1", crew: { id: "alpha", displayName: "Alpha" } },
		});
		const outcome = await runGuestJoinCommand(
			{
				command: "guest-join",
				target: "/tmp/member.sock",
				guestIdentity: "guest-session",
				guestName: "Alex",
				callback: "/tmp/callback.sock",
				format: "toon",
			},
			context,
			deps,
		);
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

	test("surfaces exact member-side admission codes from wire rejections", async () => {
		const { deps } = depsWith(undefined, new RpcProtocolError("remote-error", "name-collision"));
		const outcome = await runGuestJoinCommand(
			{
				command: "guest-join",
				target: "/tmp/member.sock",
				guestIdentity: "guest-session",
				guestName: "Alex",
				callback: "/tmp/callback.sock",
				format: "text",
			},
			context,
			deps,
		);
		assert.equal(outcome.kind, "result");
		if (outcome.kind !== "result") return;
		assert.equal(outcome.result.ok, false);
		assert.equal(outcome.result.error?.code, "name-collision");
		assert.equal(outcome.format, "text");
	});

	test("maps transport failures to stable guest codes", async () => {
		const { deps } = depsWith(
			undefined,
			Object.assign(new Error("connect ENOENT /tmp/member.sock"), { code: "ENOENT" }),
		);
		const outcome = await runGuestJoinCommand(
			{
				command: "guest-join",
				target: "/tmp/member.sock",
				guestIdentity: "guest-session",
				guestName: "Alex",
				callback: "/tmp/callback.sock",
				format: "toon",
			},
			context,
			deps,
		);
		assert.equal(outcome.kind, "result");
		if (outcome.kind !== "result") return;
		assert.equal(outcome.result.error?.code, "join-failed");
		assert.equal(guestWireErrorCode(new RpcProtocolError("timeout", "timed out")), "timeout");
	});
});

describe("pi-bebop guest leave CLI", () => {
	test("parses crew, identity, and callback requirements", () => {
		assert.deepEqual(
			parseGuestLeaveCommand([
				"/tmp/member.sock",
				"--crew",
				"alpha",
				"--identity",
				"guest-session",
				"--callback",
				"/tmp/callback.sock",
			]),
			{
				command: "guest-leave",
				target: "/tmp/member.sock",
				crewId: "alpha",
				guestIdentity: "guest-session",
				callback: "/tmp/callback.sock",
				format: "toon",
			},
		);
		assert.throws(
			() => parseGuestLeaveCommand(["/tmp/member.sock", "--identity", "i", "--callback", "c"]),
			UsageError,
		);
	});

	test("sends the exact guest_leave wire command and reports a left crew", async () => {
		const { deps, calls } = depsWith({ success: true, data: {} });
		const outcome = await runGuestLeaveCommand(
			{
				command: "guest-leave",
				target: "/tmp/member.sock",
				crewId: "alpha",
				guestIdentity: "guest-session",
				callback: "/tmp/callback.sock",
				format: "json",
			},
			context,
			deps,
		);
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

	test("remote rejections keep their member-side codes", async () => {
		const { deps } = depsWith(undefined, new RpcProtocolError("remote-error", "not-found"));
		const outcome = await runGuestLeaveCommand(
			{
				command: "guest-leave",
				target: "/tmp/member.sock",
				crewId: "alpha",
				guestIdentity: "guest-session",
				callback: "/tmp/callback.sock",
				format: "toon",
			},
			context,
			deps,
		);
		assert.equal(outcome.kind, "result");
		if (outcome.kind !== "result") return;
		assert.equal(outcome.result.ok, false);
		assert.equal(outcome.result.error?.code, "not-found");
	});
});
