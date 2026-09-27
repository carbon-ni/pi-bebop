import test from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { rm } from "node:fs/promises";
import { Command } from "commander";
import { buildAskCommand, defaultAskCliDependencies, readAskCommand, runAskCommand } from "./ask.ts";
import { RpcProtocolError } from "../../infra/rpc-client.ts";
import { CrewRouteResolutionError } from "../../application/crew-target-resolution.ts";
import { BebopClientError } from "../../sdk/errors.ts";
import { closeRpcServer, createRpcServer, writeResponse } from "../../infra/rpc-server.ts";
import { writeOutcome } from "../support/output.ts";

function parse(tokens: readonly string[]): Command {
	const command = buildAskCommand()
		.exitOverride()
		.configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} });
	command.parse([...tokens], { from: "user" });
	return command;
}

const context = { cwd: "/project", input: process.stdin, signal: new AbortController().signal };
const route = {
	target: { crew: { selector: "alpha", displayName: "Alpha" }, member: { name: "Kelly", role: "qa" } },
	caller: { kind: "member" as const, identity: "Mony" },
	endpoint: "/private/target.sock",
	locator: "/private/crew.json",
};

function deps(overrides: Record<string, unknown> = {}) {
	const calls: unknown[] = [];
	return {
		calls,
		resolveSource: () => ({
			ok: true as const,
			kind: "id" as const,
			idSocketPath: "/source.sock",
			aliasSocketPath: "/alias.sock",
		}),
		environmentSession: () => undefined,
		capture: async () => ({
			crewLocator: "/project/.pi/bebop/crew.json",
			crew: { id: "alpha", displayName: "Alpha" },
			member: { name: "Mony", role: "lead" },
			projectRoot: "/project",
		}),
		resolveRoute: async () => route,
		send: async (_source: unknown, command: unknown) => {
			calls.push(command);
			return {
				response: {
					success: true,
					data: { accepted: true, requestId: "opaque-request", member: route.target.member },
				},
			};
		},
		wait: async () => ({
			response: {
				success: true,
				data: {
					kind: "response",
					requestId: "opaque-request",
					member: route.target.member,
					message: "Blocked on CI",
					instructions: [],
					requestAgeMs: 42,
				},
			},
		}),
		...overrides,
	};
}

test("default Ask dependencies preserve source fallback and Request wire contracts", async () => {
	const socketPath = `/tmp/pi-bebop-ask-${process.pid}-${Date.now()}.sock`;
	const source = {
		ok: true as const,
		kind: "id" as const,
		idSocketPath: `${socketPath}.stale`,
		aliasSocketPath: socketPath,
	};
	const methods: string[] = [];
	const responses = {
		"session.capture": {
			crewLocator: "/project/.pi/bebop/crew.json",
			crew: { id: "alpha", displayName: "Alpha" },
			member: { name: "Mony", role: "lead" },
			session: { persisted: true, id: "source-session", cwd: "/project", root: "/project" },
		},
		"member.request_start": {
			accepted: true,
			requestId: "opaque-request",
			member: { name: "Kelly", role: "qa" },
		},
		"member.request_wait": {
			kind: "response",
			requestId: "opaque-request",
			member: { name: "Kelly", role: "qa" },
			message: "Blocked on CI",
			instructions: [],
		},
	};
	const server = net.createServer((socket) => {
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			const request = JSON.parse(buffer.slice(0, newline)) as { id: string | number; method: string };
			methods.push(request.method);
			socket.end(
				`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: responses[request.method as keyof typeof responses] })}\n`,
			);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});

	try {
		const signal = new AbortController().signal;
		assert.equal(defaultAskCliDependencies.environmentSession({ PI_SESSION_ID: "session-env" }), "session-env");
		const processSession = defaultAskCliDependencies.environmentSession();
		assert.ok(processSession === undefined || typeof processSession === "string");
		const capture = await defaultAskCliDependencies.capture(source, signal);
		assert.deepEqual(capture, {
			crewLocator: "/project/.pi/bebop/crew.json",
			crew: { id: "alpha", displayName: "Alpha" },
			member: { name: "Mony", role: "lead" },
			projectRoot: "/project",
		});
		const delivered = await defaultAskCliDependencies.send(
			source,
			{
				type: "member_request_start",
				target: "Kelly",
				message: "What is blocked?",
				timeoutSeconds: 30,
				maxWaitSeconds: 120,
			},
			5_000,
			signal,
		);
		const waited = await defaultAskCliDependencies.wait(source, "opaque-request", 120_000, signal);

		assert.deepEqual(methods, ["session.capture", "member.request_start", "member.request_wait"]);
		assert.equal((delivered.response.data as { requestId: string }).requestId, "opaque-request");
		assert.equal((waited.response.data as { message: string }).message, "Blocked on CI");
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(socketPath, { force: true });
	}
});

test("default Ask capture accepts an approved Guest and rejects incomplete route evidence", async () => {
	const socketPath = `/tmp/pi-bebop-ask-capture-${process.pid}-${Date.now()}.sock`;
	const source = { ok: true as const, kind: "id" as const, idSocketPath: socketPath, aliasSocketPath: socketPath };
	const session = { persisted: true, id: "source-session", cwd: "/project", root: "/project" };
	let result: unknown = {
		crewLocator: "/project/.pi/bebop/crew.json",
		crew: { id: "alpha", displayName: "Alpha" },
		guest: { identity: "guest-1", name: "Ada", capabilities: ["member-request"] },
		session,
	};
	const server = net.createServer((socket) => {
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			const request = JSON.parse(buffer.slice(0, newline)) as { id: string | number };
			socket.end(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});

	try {
		const guest = await defaultAskCliDependencies.capture(source, new AbortController().signal);
		assert.equal(guest.guest?.identity, "guest-1");
		assert.equal(guest.member, undefined);

		for (const invalidResult of [
			{
				crewLocator: "/project/.pi/bebop/crew.json",
				crew: { displayName: "Alpha" },
				member: { name: "Mony", role: "lead" },
				session,
			},
			{ crewLocator: "/project/.pi/bebop/crew.json", crew: { id: "alpha" }, session },
		]) {
			result = invalidResult;
			await assert.rejects(
				defaultAskCliDependencies.capture(source, new AbortController().signal),
				(error: unknown) => error instanceof RpcProtocolError && error.code === "authorization-required",
			);
		}
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(socketPath, { force: true });
	}
});

test("default Ask capture does not fall back when the ID socket fails for another reason", async () => {
	const socketPath = `/tmp/pi-bebop-ask-unused-${process.pid}-${Date.now()}.sock`;
	let connections = 0;
	const server = net.createServer(() => {
		connections += 1;
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});

	try {
		await assert.rejects(
			defaultAskCliDependencies.capture(
				{ ok: true, kind: "id", idSocketPath: "/dev/null", aliasSocketPath: socketPath },
				new AbortController().signal,
			),
			(error: unknown) => ["ENOTSOCK", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? ""),
		);
		assert.equal(connections, 0);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(socketPath, { force: true });
	}
});

test("default Ask route requires an authorized caller and validates the target", async () => {
	const capture = {
		crewLocator: "/project/.pi/bebop/crew.json",
		crew: { id: "alpha", displayName: "Alpha" },
		projectRoot: "/project",
	};
	const signal = new AbortController().signal;
	await assert.rejects(
		defaultAskCliDependencies.resolveRoute(capture, "alpha/Kelly", signal),
		(error: unknown) => error instanceof RpcProtocolError && error.code === "authorization-required",
	);

	for (const callerCapture of [
		{ ...capture, member: { name: "Mony", role: "lead" } },
		{ ...capture, guest: { identity: "guest-1", name: "Ada", capabilities: ["member-request"] } },
	]) {
		await assert.rejects(
			defaultAskCliDependencies.resolveRoute(callerCapture, " alpha", signal),
			(error: unknown) => error instanceof CrewRouteResolutionError && error.code === "unknown-crew",
		);
	}
});

test("default Ask route resolves authorized Member and Guest sources against the canonical owner", async () => {
	const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ask-route-resolution-"));
	const manifestPath = path.join(projectRoot, ".pi", "bebop", "crew.json");
	const endpoint = path.join(projectRoot, ".pi", "bebop", "sockets", "Mony.sock");
	await fs.mkdir(path.dirname(endpoint), { recursive: true });
	await fs.writeFile(
		manifestPath,
		JSON.stringify({
			version: 2,
			crew: { id: "alpha", displayName: "Alpha Crew" },
			members: [
				{ name: "Mony", role: "lead", socket: "sockets/Mony.sock" },
				{ name: "Kelly", role: "qa", socket: "sockets/Kelly.sock" },
			],
			presence: { notifications: true },
			intake: { contact: "Mony" },
		}),
	);
	const server = await createRpcServer(endpoint, (command, socket) => {
		if (command.type !== "status") return;
		writeResponse(socket, {
			type: "response",
			command: "status",
			success: true,
			id: command.id,
			data: { status: "joined", crewLocator: manifestPath, projectTrusted: true },
		});
	});

	try {
		const baseCapture = {
			crewLocator: manifestPath,
			crew: { id: "alpha", displayName: "Alpha Crew" },
			projectRoot,
		};
		const memberRoute = await defaultAskCliDependencies.resolveRoute(
			{ ...baseCapture, member: { name: "Kelly", role: "qa" } },
			"alpha/Mony",
			new AbortController().signal,
		);
		assert.deepEqual(memberRoute.caller, { kind: "member", identity: "Kelly" });
		assert.deepEqual(memberRoute.target.member, { name: "Mony", role: "lead" });

		const guestRoute = await defaultAskCliDependencies.resolveRoute(
			{
				...baseCapture,
				guest: { identity: "guest-1", name: "Ada", capabilities: ["member-request"] },
			},
			"alpha/Mony",
			new AbortController().signal,
		);
		assert.deepEqual(guestRoute.caller, { kind: "guest", identity: "Ada" });
		assert.deepEqual(guestRoute.target.member, { name: "Mony", role: "lead" });
	} finally {
		await closeRpcServer(server);
		await fs.rm(projectRoot, { recursive: true, force: true });
	}
});

test("Ask requires a resolved source session before route discovery", async () => {
	const options = readAskCommand(parse(["alpha", "question"]));
	await assert.rejects(
		runAskCommand(
			options,
			context,
			deps({ resolveSource: () => ({ ok: false, message: "No source session" }) }) as never,
		),
		/No source session/,
	);
});

test("Ask reader preserves explicit session and format options", () => {
	const options = readAskCommand(parse(["alpha", "question", "--session", "session-1", "--format", "json"]));
	assert.equal(options.session, "session-1");
	assert.equal(options.format, "json");
});

test("Ask reader preserves exact question bytes and validates bounded durations", () => {
	const options = readAskCommand(
		parse(["alpha/Kelly", "  What is blocked?  ", "--instruction", "first", "--instruction", "second"]),
	);
	assert.equal(options.question, "  What is blocked?  ");
	assert.deepEqual(options.instructions, ["first", "second"]);
	assert.equal(options.responseGraceSeconds, 30);
	assert.equal(options.totalWaitSeconds, 120);
	assert.throws(() => readAskCommand(parse(["alpha", "question", "--timeout", "30s", "--response-grace", "30s"])));
});

test("Ask reader rejects invalid format, UTF-8 target, duration, and question inputs", () => {
	for (const args of [
		["alpha", "question", "--format", "yaml"],
		["alpha", "question", "--response-grace", "bad"],
		["alpha", "question", "--response-grace", "0s"],
		["alpha", "question", "--timeout", "1s"],
		["alpha", "question", "--timeout", "30s", "--response-grace", "30s"],
		["alpha", "   "],
		["alpha", "\u0000"],
		["a".repeat(257), "question"],
		[" alpha", "question"],
	] as const)
		assert.throws(() => readAskCommand(parse(args)));
});

test("Ask sends exactly one correlated request, waits its opaque ID, and hides transport metadata", async () => {
	const options = readAskCommand(parse(["alpha/Kelly", "What is blocked?"]));
	const injected = deps();
	const outcome = await runAskCommand(options, context, injected as never);
	assert.equal(outcome.kind, "result");
	if (outcome.kind === "result") {
		assert.equal(outcome.result.status, "response");
		assert.equal(outcome.result.response, "Blocked on CI");
		assert.equal((outcome.result.data as any).freshness.requestAgeMs, 42);
		assert.doesNotMatch(JSON.stringify(outcome.result), /opaque-request|private\/target|private\/crew/);
	}
	assert.equal((injected.calls[0] as any).target, "Kelly");
	assert.equal((injected.calls[0] as any).timeoutSeconds, 30);
	assert.equal((injected.calls[0] as any).maxWaitSeconds, 120);
});

test("Ask rejects a response that does not match the accepted Request", async () => {
	const options = readAskCommand(parse(["alpha/Kelly", "What is blocked?"]));
	const injected = deps({
		wait: async () => ({
			response: {
				success: true,
				data: {
					kind: "response",
					requestId: "different-request",
					member: route.target.member,
					message: "wrong response",
					instructions: [],
				},
			},
		}),
	});
	const outcome = await runAskCommand(options, context, injected as never);
	assert.equal(outcome.kind, "result");
	if (outcome.kind === "result") assert.equal(outcome.result.error?.code, "malformed-response");
});

test("Ask preserves an approved Guest route and sends its exact Crew selector", async () => {
	const options = readAskCommand(parse(["alpha/Kelly", "What is blocked?"]));
	const injected = deps({
		capture: async () => ({
			crewLocator: "/project/.pi/bebop/crew.json",
			crew: { id: "alpha", displayName: "Alpha" },
			guest: { identity: "guest-1", name: "Ada", capabilities: ["member-request"] },
			projectRoot: "/project",
		}),
		resolveRoute: async (_capture: unknown, target: string) => ({
			...route,
			caller: { kind: "guest", identity: "Ada" },
			target: route.target,
		}),
	});
	await runAskCommand(options, context, injected as never);
	assert.equal((injected.calls[0] as any).crew, "alpha");
});

test("Ask reports acceptance uncertainty without retrying", async () => {
	const options = readAskCommand(parse(["alpha", "question"]));
	let sends = 0;
	const injected = deps({
		send: async () => {
			sends += 1;
			throw new Error("RPC request timeout");
		},
	});
	const outcome = await runAskCommand(options, context, injected as never);
	assert.equal(outcome.kind, "result");
	if (outcome.kind === "result") assert.equal(outcome.result.error?.code, "delivery-timeout-unknown");
	assert.equal(sends, 1);
});

test("Ask maps source, discovery, delivery, and wait failures without leaking private errors", async () => {
	const options = readAskCommand(parse(["alpha", "question"]));
	const failures: Array<{ phase: string; error: unknown; code: string; status?: string }> = [
		{ phase: "capture", error: new Error("RPC request timeout /private/socket"), code: "discovery-timeout" },
		{ phase: "capture", error: Object.assign(new Error("aborted"), { name: "AbortError" }), code: "cancelled" },
		{
			phase: "capture",
			error: Object.assign(new Error("missing /private/socket"), { code: "ENOENT" }),
			code: "offline",
		},
		{ phase: "capture", error: new Error("private transport failure"), code: "ask-failed" },
		{ phase: "capture", error: new RpcProtocolError("remote-error", "private rejection"), code: "remote-error" },
		{
			phase: "route",
			error: new CrewRouteResolutionError("route-conflict", "private", { target: "alpha", recovery: "Retry" }),
			code: "route-conflict",
		},
		{
			phase: "route",
			error: new CrewRouteResolutionError("unknown-crew", "private", {
				target: "alpha",
				recovery: "Select a Crew",
			}),
			code: "unknown-crew",
			status: "usage",
		},
		{
			phase: "send",
			error: new RpcProtocolError("outcome-unknown", "private transport"),
			code: "delivery-timeout-unknown",
		},
		{ phase: "send", error: Object.assign(new Error("aborted"), { name: "AbortError" }), code: "cancelled" },
		{
			phase: "send",
			error: new BebopClientError("offline-member", "private member route"),
			code: "offline-member",
		},
		{
			phase: "send",
			error: new BebopClientError("outcome-unknown", "private acceptance state"),
			code: "delivery-timeout-unknown",
		},
		{ phase: "wait", error: new Error("RPC request timeout"), code: "timeout-total" },
		{ phase: "wait", error: Object.assign(new Error("aborted"), { name: "AbortError" }), code: "cancelled" },
	];
	for (const failure of failures) {
		const injected = deps({
			capture: async () => {
				if (failure.phase === "capture") throw failure.error;
				return await deps().capture({} as never, new AbortController().signal);
			},
			resolveRoute: async () => {
				if (failure.phase === "route") throw failure.error;
				return route;
			},
			send: async () => {
				if (failure.phase === "send") throw failure.error;
				return {
					response: {
						success: true,
						data: { accepted: true, requestId: "opaque-request", member: route.target.member },
					},
				};
			},
			wait: async () => {
				if (failure.phase === "wait") throw failure.error;
				return {
					response: {
						success: true,
						data: {
							kind: "response",
							requestId: "opaque-request",
							member: route.target.member,
							message: "answer",
							instructions: [],
						},
					},
				};
			},
		});
		const outcome = await runAskCommand(options, context, injected as never);
		assert.equal(outcome.kind, "result");
		if (outcome.kind === "result") {
			assert.equal(outcome.result.error?.code, failure.code);
			if ("status" in failure) assert.equal(outcome.result.status, failure.status);
			assert.doesNotMatch(JSON.stringify(outcome.result), /private/);
		}
	}
});

test("Ask maps source authority and target rejections through the default Request adapter", async () => {
	for (const [wireCode, cliCode] of [
		["not-joined", "not-joined"],
		["untrusted-project", "untrusted"],
		["unknown-member", "unknown-member"],
		["invalid-input", "invalid-input"],
		["request-failed", "delivery-rejected"],
	] as const) {
		const outcome = await runAskCommand(
			readAskCommand(parse(["alpha", "question"])),
			context,
			deps({
				send: async () => ({ response: { success: false, error: `${wireCode}: private detail` } }),
			}) as never,
		);
		assert.equal(outcome.kind, "result");
		if (outcome.kind === "result") {
			assert.equal(outcome.result.error?.code, cliCode);
			assert.doesNotMatch(JSON.stringify(outcome.result), /private detail/);
		}
	}
});

test("Ask maps terminal pending, timeout, offline, and malformed outcomes", async () => {
	const options = readAskCommand(parse(["alpha", "question"]));
	for (const [data, code] of [
		[
			{ kind: "pending", requestId: "opaque-request", member: route.target.member, reason: "pending-after-idle" },
			"timeout-after-idle",
		],
		[
			{ kind: "timeout", requestId: "opaque-request", member: route.target.member, reason: "max-wait" },
			"timeout-total",
		],
		[{ kind: "offline", requestId: "opaque-request", member: route.target.member }, "route-lost"],
		[{ nope: true }, "malformed-response"],
	] as const) {
		const outcome = await runAskCommand(
			options,
			context,
			deps({ wait: async () => ({ response: { success: true, data } }) }) as never,
		);
		assert.equal(outcome.kind, "result");
		if (outcome.kind === "result") assert.equal(outcome.result.error?.code, code);
	}
});

test("Ask timeout failure preserves the same semantic outcome across formats", async () => {
	const terminal = await runAskCommand(
		readAskCommand(parse(["alpha", "question"])),
		context,
		deps({
			wait: async () => ({
				response: {
					success: true,
					data: {
						kind: "timeout",
						requestId: "opaque-request",
						member: route.target.member,
						reason: "max-wait",
					},
				},
			}),
		}) as never,
	);
	const transport = await runAskCommand(
		readAskCommand(parse(["alpha", "question"])),
		context,
		deps({
			wait: async () => {
				throw new Error("RPC request timeout /private/socket");
			},
		}) as never,
	);
	assert.deepEqual((terminal as any).result.data, { outcome: "timeout-total", safeRetry: false });
	assert.deepEqual((transport as any).result.data, { outcome: "timeout-total", safeRetry: false });

	for (const format of ["text", "json", "toon"] as const) {
		const options = readAskCommand(parse(["alpha", "question", "--format", format]));
		const outcome = await runAskCommand(
			options,
			context,
			deps({
				wait: async () => ({
					response: {
						success: true,
						data: {
							kind: "timeout",
							requestId: "opaque-request",
							member: route.target.member,
							reason: "max-wait",
						},
					},
				}),
			}) as never,
		);
		const chunks: string[] = [];
		const stream = { write: (chunk: string | Uint8Array) => (chunks.push(String(chunk)), true) } as never;
		assert.equal(writeOutcome({ write: () => true } as never, stream, outcome), 1);
		const rendered = chunks.join("");
		if (format === "text") assert.match(rendered, /timeout-total/);
		else {
			const structured = format === "json" ? JSON.parse(rendered) : rendered;
			if (format === "json") {
				assert.equal(structured.outcome, "timeout-total");
				assert.equal(structured.data.outcome, "timeout-total");
				assert.equal(structured.data.safeRetry, false);
			}
			assert.match(rendered, /timeout-total/);
		}
	}
});

test("Ask discovery failure never starts delivery", async () => {
	const options = readAskCommand(parse(["alpha", "question"]));
	let sends = 0;
	const injected = deps({
		resolveRoute: async () => {
			throw new Error("discovery timeout");
		},
		send: async () => {
			sends += 1;
			return { response: { success: true, data: {} } };
		},
	});
	const outcome = await runAskCommand(options, context, injected as never);
	assert.equal(outcome.kind, "result");
	if (outcome.kind === "result") assert.equal(outcome.result.error?.code, "discovery-timeout");
	assert.equal(sends, 0);
});
