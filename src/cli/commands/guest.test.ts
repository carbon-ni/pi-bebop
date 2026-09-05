import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { RpcProtocolError } from "../../infra/rpc-client.ts";
import { UsageError } from "../support/arguments.ts";
import {
	guestJoinHelp,
	guestLeaveHelp,
	guestMessageHelp,
	guestWireErrorCode,
	parseGuestJoinCommand,
	parseGuestLeaveCommand,
	parseGuestMessageCommand,
	runGuestJoinCommand,
	runGuestLeaveCommand,
	runGuestMessageCommand,
	type GuestCliDependencies,
} from "./guest.ts";
import type { CliContext } from "../support/context.ts";
import { runCli } from "../run.ts";
import { createGuestRegistryStore, digestGuestCapability } from "../../infra/guest-registry-store.ts";

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

	test("reports approved admission with the approved next step", async () => {
		const { deps } = depsWith({
			success: true,
			data: { status: "approved", requestId: "approved-1", crew: { id: "alpha", displayName: "Alpha" } },
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
		if (outcome.kind === "result") assert.equal(outcome.result.data.next, "admission approved");
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
		assert.equal(guestWireErrorCode(new RpcProtocolError("offline", "offline")), "offline");
		assert.equal(guestWireErrorCode(Object.assign(new Error("offline"), { code: "offline" })), "join-failed");
		assert.equal(guestWireErrorCode(new Error("other")), "join-failed");
	});
});

test("Guest message parser covers help and syntax failures", () => {
	assert.equal(parseGuestMessageCommand(["--help"], "send").help, true);
	assert.throws(() => parseGuestJoinCommand(["--help", "--format", "xml"]), /Invalid --format/);
	assert.equal(parseGuestMessageCommand(["--help"], "broadcast").help, true);
	assert.throws(() => parseGuestMessageCommand(["--help", "--format", "xml"], "broadcast"), /Invalid --format/);
	assert.equal(
		parseGuestMessageCommand(
			[
				"--crew",
				"alpha",
				"--identity",
				"guest-1",
				"--as",
				"Alex",
				"--callback",
				"c",
				"--capability",
				"cap",
				"--message",
				"hello",
				"--format",
			],
			"broadcast",
		).format,
		"toon",
	);
	assert.throws(
		() =>
			parseGuestMessageCommand(
				[
					"--crew",
					"alpha",
					"--identity",
					"guest-1",
					"--as",
					"Alex",
					"--callback",
					"c",
					"--capability",
					"cap",
					"--message",
					"hello",
					"--bogus",
					"x",
				],
				"broadcast",
			),
		/unknown option|unknown flag/i,
	);
	assert.throws(
		() => parseGuestMessageCommand(["--crew", "alpha", "--identity"], "broadcast"),
		/Missing value|required option/i,
	);
	assert.throws(
		() =>
			parseGuestMessageCommand(
				[
					"--crew",
					"alpha",
					"--identity",
					"guest-1",
					"--as",
					"Alex",
					"--callback",
					"c",
					"--capability",
					"cap",
					"--message",
					"hello",
					"--format",
					"xml",
				],
				"broadcast",
			),
		/Invalid --format/,
	);
});

test("Guest message parsers accept declared routing without a positional socket", () => {
	const common = [
		"--crew",
		"alpha",
		"--identity",
		"guest-1",
		"--as",
		"Alex",
		"--callback",
		"/tmp/callback.sock",
		"--capability",
		"cap-1",
		"--message",
		"hello",
	] as const;
	assert.equal(parseGuestMessageCommand([...common, "--target", "Mary"], "send").target, "Mary");
	assert.deepEqual(parseGuestMessageCommand([...common, "--instruction", "one"], "broadcast"), {
		command: "guest-broadcast",
		crew: "alpha",
		target: undefined,
		guestIdentity: "guest-1",
		guestName: "Alex",
		callback: "/tmp/callback.sock",
		capability: "cap-1",
		message: "hello",
		instructions: ["one"],
		format: "toon",
	});
});

test("Guest message execution loads a trusted Crew manifest before authorization", async () => {
	const root = await mkdtemp(path.join("/tmp", "bebop-guest-cli-"));
	try {
		assert.equal(await runCli(["crew", "init", "--project", root], root, process.stdin, new PassThrough()), 0);
		const manifestPath = path.join(root, ".pi", "bebop", "crew.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
		manifest.crew = { id: "alpha", displayName: "Alpha" };
		await writeFile(manifestPath, JSON.stringify(manifest));
		for (const command of ["guest-send", "guest-broadcast"] as const) {
			const outcome = await runGuestMessageCommand(
				{
					command,
					crew: "alpha",
					target: command === "guest-send" ? "Mary" : undefined,
					guestIdentity: "guest-1",
					guestName: "Alex",
					callback: "/tmp/callback.sock",
					capability: "cap-1",
					message: "hello",
					instructions: [],
					format: "toon",
				},
				{ cwd: root, input: process.stdin, signal: new AbortController().signal },
				{ sendCommand: async () => ({ response: { success: true, data: {} } }) as never },
			);
			assert.equal(outcome.kind, "result");
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Guest message execution sends after a trusted approved registry binding", async () => {
	const root = await mkdtemp(path.join("/tmp", "bebop-guest-approved-"));
	try {
		assert.equal(await runCli(["crew", "init", "--project", root], root, process.stdin, new PassThrough()), 0);
		const manifestPath = path.join(root, ".pi", "bebop", "crew.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
		manifest.crew = { id: "alpha", displayName: "Alpha" };
		await writeFile(manifestPath, JSON.stringify(manifest));
		await cp(path.join(root, ".pi", "bebop"), path.join(root, ".pi", "crew"), { recursive: true });
		const foreignPath = path.join(root, ".pi", "crew", "crew.json");
		const foreignManifest = JSON.parse(await readFile(foreignPath, "utf8")) as Record<string, unknown>;
		foreignManifest.crew = { id: "beta", displayName: "Beta" };
		await writeFile(foreignPath, JSON.stringify(foreignManifest));
		createGuestRegistryStore({ manifestPath, crew: { id: "alpha", displayName: "Alpha" } }).replaceEntries([
			{
				status: "approved",
				record: {
					crew: { id: "alpha", displayName: "Alpha" },
					guestIdentity: "guest-1",
					guestName: "Alex",
					callbackEndpoint: "/tmp/callback.sock",
					approvedBy: "lead",
				},
				capabilityDigest: digestGuestCapability("cap-1"),
			},
			{
				status: "approved",
				record: {
					crew: { id: "alpha", displayName: "Alpha" },
					guestIdentity: "guest-2",
					guestName: "Blair",
					callbackEndpoint: "/tmp/blair.sock",
					approvedBy: "lead",
				},
				capabilityDigest: digestGuestCapability("cap-2"),
			},
			{
				status: "denied",
				request: {
					crew: { id: "alpha", displayName: "Alpha" },
					guestIdentity: "guest-denied",
					guestName: "Denied",
					callbackEndpoint: "/tmp/denied.sock",
				},
				approver: "lead",
			},
		]);
		const outcome = await runGuestMessageCommand(
			{
				command: "guest-send",
				crew: "alpha",
				target: "lead",
				guestIdentity: "guest-1",
				guestName: "Alex",
				callback: "/tmp/callback.sock",
				capability: "cap-1",
				message: "hello",
				instructions: ["one"],
				format: "toon",
			},
			{ cwd: root, input: process.stdin, signal: new AbortController().signal },
			{
				sendCommand: async () =>
					({
						response: {
							success: true,
							data: { deliveryId: "d-1", disposition: "direct", fromGuestName: "Alex" },
						},
					}) as never,
			},
		);
		assert.equal(outcome.kind, "result");
		const broadcast = await runGuestMessageCommand(
			{
				command: "guest-broadcast",
				crew: "alpha",
				guestIdentity: "guest-1",
				guestName: "Alex",
				callback: "/tmp/callback.sock",
				capability: "cap-1",
				message: "hello",
				instructions: [],
				format: "toon",
			},
			{ cwd: root, input: process.stdin, signal: new AbortController().signal },
			{
				sendCommand: async () =>
					({
						response: {
							success: true,
							data: { deliveryId: "d-2", disposition: "direct", fromGuestName: "Alex" },
						},
					}) as never,
			},
		);
		assert.equal(broadcast.kind, "result");
		const partial = await runGuestMessageCommand(
			{
				command: "guest-broadcast",
				crew: "alpha",
				guestIdentity: "guest-1",
				guestName: "Alex",
				callback: "/tmp/callback.sock",
				capability: "cap-1",
				message: "hello",
				instructions: [],
				format: "toon",
			},
			{ cwd: root, input: process.stdin, signal: new AbortController().signal },
			{
				sendCommand: async () => {
					throw new Error("offline");
				},
			},
		);
		assert.equal(partial.kind, "result");
		const rejected = await runGuestMessageCommand(
			{
				command: "guest-send",
				crew: "alpha",
				target: "lead",
				guestIdentity: "guest-1",
				guestName: "Alex",
				callback: "/tmp/callback.sock",
				capability: "cap-1",
				message: "hello",
				instructions: [],
				format: "toon",
			},
			{ cwd: root, input: process.stdin, signal: new AbortController().signal },
			{
				sendCommand: async () => {
					throw new RpcProtocolError("remote-error", "remote-error: not-found");
				},
			},
		);
		assert.equal(rejected.kind, "result");
		const blankFailure = await runGuestMessageCommand(
			{
				command: "guest-send",
				crew: "alpha",
				target: "lead",
				guestIdentity: "guest-1",
				guestName: "Alex",
				callback: "/tmp/callback.sock",
				capability: "cap-1",
				message: "hello",
				instructions: [],
				format: "toon",
			},
			{ cwd: root, input: process.stdin, signal: new AbortController().signal },
			{
				sendCommand: async () => {
					throw new Error("");
				},
			},
		);
		assert.equal(blankFailure.kind, "result");
		const invalidAck = await runGuestMessageCommand(
			{
				command: "guest-send",
				crew: "alpha",
				target: "lead",
				guestIdentity: "guest-1",
				guestName: "Alex",
				callback: "/tmp/callback.sock",
				capability: "cap-1",
				message: "hello",
				instructions: [],
				format: "toon",
			},
			{ cwd: root, input: process.stdin, signal: new AbortController().signal },
			{ sendCommand: async () => ({ response: { success: true, data: {} } }) as never },
		);
		assert.equal(invalidAck.kind, "result");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Guest routing rejects ambiguous trusted manifest layouts", async () => {
	const root = await mkdtemp(path.join("/tmp", "bebop-guest-ambiguous-"));
	try {
		assert.equal(await runCli(["crew", "init", "--project", root], root, process.stdin, new PassThrough()), 0);
		await cp(path.join(root, ".pi", "bebop"), path.join(root, ".pi", "crew"), { recursive: true });
		for (const layout of ["bebop", "crew"]) {
			const manifestPath = path.join(root, ".pi", layout, "crew.json");
			const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
			manifest.crew = { id: "alpha", displayName: "Alpha" };
			await writeFile(manifestPath, JSON.stringify(manifest));
		}
		const output = new PassThrough();
		let text = "";
		output.setEncoding("utf8");
		output.on("data", (chunk) => (text += chunk));
		const code = await runCli(
			[
				"guest",
				"send",
				"--crew",
				"alpha",
				"--target",
				"lead",
				"--identity",
				"guest-1",
				"--as",
				"Alex",
				"--callback",
				"c",
				"--capability",
				"cap",
				"--message",
				"hello",
			],
			root,
			process.stdin,
			output,
		);
		assert.equal(code, 1);
		assert.match(text, /multiple trusted manifests/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Guest message help returns text without manifest IO", async () => {
	for (const command of ["guest-send", "guest-broadcast"] as const) {
		const outcome = await runGuestMessageCommand(
			{
				command,
				crew: "alpha",
				target: command === "guest-send" ? "Mary" : undefined,
				guestIdentity: "guest-1",
				guestName: "Alex",
				callback: "/tmp/callback.sock",
				capability: "cap-1",
				message: "hello",
				instructions: [],
				format: "toon",
				help: true,
			},
			context,
		);
		assert.equal(outcome.kind, "help");
	}
});

test("production Guest send and broadcast use declared routing without a positional socket", async () => {
	for (const kind of ["send", "broadcast"] as const) {
		const output = new PassThrough();
		let text = "";
		output.setEncoding("utf8");
		output.on("data", (chunk) => {
			text += chunk;
		});
		const args = [
			"guest",
			kind,
			"--crew",
			"alpha",
			...(kind === "send" ? ["--target", "Mary"] : []),
			"--identity",
			"guest-1",
			"--as",
			"Alex",
			"--callback",
			"/tmp/callback.sock",
			"--capability",
			"cap-1",
			"--message",
			"hello",
		];
		const code = await runCli(args, "/tmp/task-0168-no-manifest", process.stdin, output);
		assert.equal(code, 1, kind);
		assert.doesNotMatch(text, /Guest commands require one live Member socket target/);
		assert.match(text, /No trusted crew manifest found/);
	}
});

test("guest help names each delivery surface", () => {
	assert.match(guestJoinHelp(), /guest join <member-socket>/);
	assert.match(guestLeaveHelp(), /guest leave <member-socket>/);
	assert.match(guestMessageHelp("send"), /guest send --target <member>/);
	assert.match(guestMessageHelp("send"), /direct Guest Follow-up/);
	assert.match(guestMessageHelp("broadcast"), /guest broadcast --crew/);
	assert.match(guestMessageHelp("broadcast"), /transient Guest Broadcast/);
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
