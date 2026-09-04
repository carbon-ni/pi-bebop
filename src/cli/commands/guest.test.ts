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

describe("guest CLI help and error branches", () => {
	test("--help returns deterministic help text without any IO", async () => {
		const joinOptions = parseGuestJoinCommand(["--help"]);
		assert.deepEqual(joinOptions, {
			command: "guest-join",
			target: "",
			guestIdentity: "",
			guestName: "",
			callback: "",
			format: "toon",
			help: true,
		});
		const { deps, calls } = depsWith({ success: true, data: {} });
		const joinOutcome = await runGuestJoinCommand(joinOptions, context, deps);
		assert.equal(joinOutcome.kind, "help");
		assert.match((joinOutcome as { text: string }).text, /pi-bebop guest join <member-socket>/);
		assert.deepEqual(calls, []);

		const leaveOptions = parseGuestLeaveCommand(["--help", "--format", "json"]);
		assert.deepEqual(leaveOptions, {
			command: "guest-leave",
			target: "",
			crewId: "",
			guestIdentity: "",
			callback: "",
			format: "json",
			help: true,
		});
		const leaveOutcome = await runGuestLeaveCommand(leaveOptions, context, deps);
		assert.equal(leaveOutcome.kind, "help");
		assert.match((leaveOutcome as { text: string }).text, /pi-bebop guest leave <member-socket>/);
		assert.deepEqual(calls, []);
	});

	test("commander usage errors map to precise messages", () => {
		assert.throws(
			() => parseGuestJoinCommand(["/tmp/member.sock", "--identity", "i", "--as"]),
			/Missing value for --as/,
		);
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
					"--bogus",
					"x",
				]),
			/unknown option '--bogus'/,
		);
		assert.throws(
			() => parseGuestJoinCommand(["/tmp/member.sock", "--identity", "i", "--as", "", "--callback", "c"]),
			/Guest --as requires a non-empty value\./,
		);
	});

	test("each required option rejects empty and missing values", () => {
		const join = (flag: string[]) => parseGuestJoinCommand(["/tmp/member.sock", "--as", "Alex", ...flag]);
		assert.throws(() => join(["--callback"]), /Missing value for --callback/);
		assert.throws(
			() => parseGuestJoinCommand(["/tmp/member.sock", "--identity", "i", "--as", "Alex", "--callback", ""]),
			/Guest --callback <socket> requires a non-empty value\./,
		);
		assert.throws(
			() => parseGuestLeaveCommand(["/tmp/member.sock", "--crew", " ", "--identity", "i", "--callback", "c"]),
			/Guest --crew <crew-id> requires a non-empty value\./,
		);
		assert.throws(
			() => parseGuestLeaveCommand(["/tmp/member.sock", "--crew", "alpha", "--identity", " ", "--callback", "c"]),
			/Guest --identity <guest-identity> requires a non-empty value\./,
		);
	});

	test("--format=json inline form and duplicate --format are handled", () => {
		const parsed = parseGuestJoinCommand([
			"/tmp/member.sock",
			"--identity=i",
			"--as=Alex",
			"--callback=/tmp/callback.sock",
			"--format=json",
		]);
		assert.equal(parsed.format, "json");
		assert.equal(parsed.callback, "/tmp/callback.sock");
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
					"json",
					"--format",
					"text",
				]),
			/Duplicate flag: --format/,
		);
	});

	test("malformed success payloads and unlabelled remote rejections fail with stable codes", async () => {
		const malformed = depsWith({ success: true, data: { bogus: true } });
		const outcome = await runGuestJoinCommand(
			{
				command: "guest-join",
				target: "/tmp/member.sock",
				guestIdentity: "i",
				guestName: "Alex",
				callback: "c",
				format: "toon",
			},
			context,
			malformed.deps,
		);
		assert.equal(outcome.kind, "result");
		if (outcome.kind !== "result") return;
		assert.equal(outcome.result.error?.code, "invalid-admission-response");

		const unlabelled = depsWith({ success: false });
		const leaveOutcome = await runGuestLeaveCommand(
			{
				command: "guest-leave",
				target: "/tmp/member.sock",
				crewId: "alpha",
				guestIdentity: "i",
				callback: "c",
				format: "toon",
			},
			context,
			unlabelled.deps,
		);
		assert.equal(leaveOutcome.kind, "result");
		if (leaveOutcome.kind !== "result") return;
		assert.equal(leaveOutcome.result.error?.code, "leave-failed");

		const labelled = depsWith({ success: false, error: "revoked" });
		const labelledOutcome = await runGuestLeaveCommand(
			{
				command: "guest-leave",
				target: "/tmp/member.sock",
				crewId: "alpha",
				guestIdentity: "i",
				callback: "c",
				format: "toon",
			},
			context,
			labelled.deps,
		);
		if (labelledOutcome.kind !== "result") return;
		assert.equal(labelledOutcome.result.error?.code, "revoked");
	});

	test("empty transport errors and empty member codes keep deterministic fallbacks", async () => {
		const blank = depsWith(undefined, new Error(""));
		const outcome = await runGuestJoinCommand(
			{
				command: "guest-join",
				target: "/tmp/member.sock",
				guestIdentity: "i",
				guestName: "Alex",
				callback: "c",
				format: "toon",
			},
			context,
			blank.deps,
		);
		assert.equal(outcome.kind, "result");
		if (outcome.kind !== "result") return;
		assert.equal(outcome.result.error?.message, "transport error");

		assert.equal(guestWireErrorCode(new RpcProtocolError("remote-error", "")), "remote-error");
	});
});

test("a trailing --format without a value falls back to the toon default", () => {
	const parsed = parseGuestJoinCommand([
		"/tmp/member.sock",
		"--identity",
		"i",
		"--as",
		"Alex",
		"--callback",
		"c",
		"--format",
	]);
	assert.equal(parsed.format, "toon");
});
