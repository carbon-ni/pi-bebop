import test from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { buildAskCommand, readAskCommand, runAskCommand } from "./ask.ts";
import { RpcProtocolError } from "../../infra/rpc-client.ts";
import { CrewRouteResolutionError } from "../../application/crew-target-resolution.ts";
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
	const failures: Array<{ phase: string; error: unknown; code: string }> = [
		{ phase: "capture", error: new Error("RPC request timeout /private/socket"), code: "discovery-timeout" },
		{ phase: "capture", error: Object.assign(new Error("aborted"), { name: "AbortError" }), code: "cancelled" },
		{
			phase: "route",
			error: new CrewRouteResolutionError("route-conflict", "private", { target: "alpha", recovery: "Retry" }),
			code: "route-conflict",
		},
		{
			phase: "send",
			error: new RpcProtocolError("outcome-unknown", "private transport"),
			code: "delivery-timeout-unknown",
		},
		{ phase: "send", error: Object.assign(new Error("aborted"), { name: "AbortError" }), code: "cancelled" },
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
