import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import type { CliContext } from "./context.ts";
import type { SourceResolution } from "./support/source-session.ts";
import { RpcProtocolError } from "../infra/rpc-client.ts";
import { runMemberMessageCommand } from "./commands/member-message.ts";
import { runMemberInterruptCommand } from "./commands/member-interrupt.ts";
import { runDurableMessageCommand } from "./commands/durable-message.ts";
import { runMemberRequestCommand, type MemberRequestCliDependencies } from "./commands/member-request.ts";
import type { MemberMessageCliOptions } from "./commands/member-message.ts";
import type { MemberInterruptCliOptions } from "./commands/member-interrupt.ts";
import type { DurableMessageCliOptions } from "./commands/durable-message.ts";
import type { MemberRequestCliOptions } from "./commands/member-request.ts";

function context(): CliContext {
	return {
		cwd: "/project",
		input: new Writable({
			write(_c, _e, cb) {
				cb();
			},
		}),
		signal: new AbortController().signal,
	};
}

function sink(): { text: string; output: Writable } {
	let text = "";
	const output = new Writable({
		write(c: unknown, _e: unknown, cb: () => void) {
			text += String(c);
			cb();
		},
	});
	return { text, output };
}

const okSource: SourceResolution = {
	ok: true,
	kind: "id",
	idSocketPath: "/tmp/x.sock",
	aliasSocketPath: "/tmp/x.alias",
};
const failSource: SourceResolution = { ok: false, code: "invalid-session", message: "Invalid --session 'bad'" };

type Fail = { ok: false; code: string };

function baseMessage(overrides: Partial<MemberMessageCliOptions> = {}): MemberMessageCliOptions {
	return {
		command: "member-message",
		member: "Mony",
		intent: "follow_up",
		message: "hello",
		instructions: [],
		stdin: false,
		format: "toon",
		...overrides,
	} as MemberMessageCliOptions;
}

function baseInterrupt(overrides: Partial<MemberInterruptCliOptions> = {}): MemberInterruptCliOptions {
	return {
		command: "member-interrupt",
		member: "Mony",
		message: "recover",
		instructions: [],
		stdin: false,
		format: "toon",
		...overrides,
	} as MemberInterruptCliOptions;
}

function baseDurable(overrides: Partial<DurableMessageCliOptions> = {}): DurableMessageCliOptions {
	return {
		command: "durable-message",
		member: "Mony",
		message: "hello",
		instructions: [],
		stdin: false,
		format: "toon",
		...overrides,
	} as DurableMessageCliOptions;
}

function baseRequest(overrides: Partial<MemberRequestCliOptions> = {}): MemberRequestCliOptions {
	return {
		command: "member-request-send",
		member: "Mony",
		message: "hello",
		instructions: [],
		stdin: false,
		responseGraceSeconds: 30,
		maxWaitSeconds: 120,
		direction: "all",
		format: "toon",
		...overrides,
	} as unknown as MemberRequestCliOptions;
}

const FORMATS = ["toon", "json", "text"] as const;

test("member message: operational failures keep format parity across toon/json/text", async () => {
	for (const format of FORMATS) {
		const outcome = await runMemberMessageCommand(baseMessage({ format }), context(), {
			resolveSource: () => failSource,
			readStdin: async () => "",
			environmentSession: () => undefined,
		} as never);
		assert.equal(outcome.kind, "result");
		if (outcome.kind !== "result") continue;
		assert.equal(outcome.result.ok, false);
		assert.match(outcome.result.error?.message ?? "", /Invalid --session 'bad'/);
		assert.equal(outcome.format, format);
	}
	const deliveryCodes: readonly string[] = ["unknown-member", "offline-session", "transport-error"];
	for (const code of deliveryCodes) {
		for (const format of FORMATS) {
			const deps = {
				resolveSource: () => okSource,
				deliverMessage: async () => ({ ok: false as const, code }),
				readStdin: async () => "",
				environmentSession: () => undefined,
			};
			const outcome = await runMemberMessageCommand(baseMessage({ format }), context(), deps as never);
			assert.equal(outcome.kind, "result");
			if (outcome.kind !== "result") continue;
			assert.equal(outcome.result.ok, false, `${code} ${format}`);
			assert.equal(outcome.result.error?.code, code, `${code} ${format}`);
			assert.equal(outcome.format, format, `${code} ${format}`);
		}
	}
});

test("member interrupt: delivery failure codes keep format parity", async () => {
	for (const code of ["unknown-member", "offline-session", "transport-error"]) {
		for (const format of FORMATS) {
			const deps = {
				resolveSource: () => okSource,
				deliverInterrupt: async () => ({ ok: false as const, code }),
				readStdin: async () => "",
				environmentSession: () => undefined,
			};
			const outcome = await runMemberInterruptCommand(baseInterrupt({ format }), context(), deps as never);
			assert.equal(outcome.kind, "result");
			if (outcome.kind !== "result") continue;
			assert.equal(outcome.result.ok, false, `${code} ${format}`);
			assert.match(outcome.result.error?.message ?? "", new RegExp(code));
			assert.equal(outcome.format, format, `${code} ${format}`);
		}
	}
});

test("durable message (crew broadcast/intake): operational failures keep format parity", async () => {
	for (const format of FORMATS) {
		const outcome = await runDurableMessageCommand(baseDurable({ format }), context(), {
			resolveSource: () => failSource,
			readStdin: async () => "",
			environmentSession: () => undefined,
		} as never);
		assert.equal(outcome.kind, "result");
		if (outcome.kind !== "result") continue;
		assert.equal(outcome.result.ok, false);
		assert.equal(outcome.format, format);
	}
});

test("member request: source failure, remote error, abort, timeout, and offline keep format parity", async () => {
	function depsWith(overrides: Partial<MemberRequestCliDependencies>): MemberRequestCliDependencies {
		return {
			resolveSource: () => okSource,
			send: async () => ({ response: { success: true, data: {} } }),
			readStdin: async () => "hello",
			environmentSession: () => undefined,
			...overrides,
		} as MemberRequestCliDependencies;
	}
	for (const format of FORMATS) {
		const sourceFail = await runMemberRequestCommand(
			baseRequest({ format }),
			context(),
			depsWith({
				resolveSource: () => failSource,
			}),
		);
		assert.equal(sourceFail.format, format);
		if (sourceFail.kind === "result") assert.equal(sourceFail.result.ok, false);

		const remote = await runMemberRequestCommand(
			baseRequest({ format }),
			context(),
			depsWith({
				send: async () => ({ response: { success: false, error: "remote-error: rejected by policy" } }),
			}),
		);
		assert.equal(remote.format, format);
		if (remote.kind === "result") {
			assert.equal(remote.result.ok, false);
			assert.match(remote.result.error?.message ?? "", /rejected by policy/);
		}

		const abort = await runMemberRequestCommand(
			baseRequest({ format }),
			context(),
			depsWith({
				send: async () => {
					const e = new Error("Operation aborted");
					e.name = "AbortError";
					throw e;
				},
			}),
		);
		assert.equal(abort.format, format);
		if (abort.kind === "result") assert.equal(abort.result.error?.code, "aborted");

		const timeout = await runMemberRequestCommand(
			baseRequest({ format }),
			context(),
			depsWith({
				send: async () => {
					throw new Error("timeout: deadline exceeded after 30m");
				},
			}),
		);
		assert.equal(timeout.format, format);
		if (timeout.kind === "result") assert.equal(timeout.result.error?.code, "timeout");

		const offline = await runMemberRequestCommand(
			baseRequest({ format }),
			context(),
			depsWith({
				send: async () => {
					throw new RpcProtocolError("offline", "connect refused");
				},
			}),
		);
		assert.equal(offline.format, format);
		if (offline.kind === "result") {
			assert.equal(offline.result.ok, false);
			assert.equal(offline.result.error?.code, "offline");
		}
	}
});

test("KNOWN GAP FIXED: member message stdin read failure is a formatted operational failure", async () => {
	// C6: stdin transport failures render like every other operational failure,
	// in the selected format, with the stable "stdin-error" code.
	for (const format of FORMATS) {
		const outcome = await runMemberMessageCommand(
			baseMessage({ format, stdin: true, message: undefined }),
			{ ...context(), input: process.stdin },
			{
				resolveSource: () => okSource,
				readStdin: async () => {
					throw new Error("stdin closed");
				},
				environmentSession: () => undefined,
			} as never,
		);
		assert.equal(outcome.kind, "result");
		if (outcome.kind !== "result") continue;
		assert.equal(outcome.result.ok, false);
		assert.equal(outcome.format, format);
		assert.equal(outcome.result.error?.code, "stdin-error");
		assert.match(outcome.result.error?.message ?? "", /stdin closed/);
	}
});

test("member interrupt: stdin read failure is a formatted stdin-error outcome", async () => {
	for (const format of FORMATS) {
		const outcome = await runMemberInterruptCommand(baseInterrupt({ format, stdin: true }), context(), {
			resolveSource: () => okSource,
			deliverInterrupt: async () => ({ ok: true as const, result: {} as never }),
			readStdin: async () => {
				throw new Error("stdin closed");
			},
			environmentSession: () => undefined,
		} as never);
		assert.equal(outcome.kind, "result");
		if (outcome.kind !== "result") continue;
		assert.equal(outcome.result.error?.code, "stdin-error", format);
		assert.equal(outcome.format, format, format);
	}
});

test("durable message: stdin read failure is a formatted stdin-error outcome", async () => {
	for (const format of FORMATS) {
		const outcome = await runDurableMessageCommand(baseDurable({ format, stdin: true }), context(), {
			resolveSource: () => okSource,
			readStdin: async () => {
				throw new Error("stdin closed");
			},
			environmentSession: () => undefined,
		} as never);
		assert.equal(outcome.kind, "result");
		if (outcome.kind !== "result") continue;
		assert.equal(outcome.result.error?.code, "stdin-error", format);
		assert.equal(outcome.format, format, format);
	}
});

test("default delivery deps map real socket connect failures to stable codes", async () => {
	// Real default deps, no mocks: the source resolves to a socket path that is
	// a regular file, so connect fails deterministically (ENOTCONN/ECONNREFUSED)
	// and the handler maps it to a formatted operational failure.
	const { mkdtemp, writeFile } = await import("node:fs/promises");
	const os = await import("node:os");
	const path = await import("node:path");
	const dir = await mkdtemp(path.join(os.tmpdir(), "bebop-op-parity-"));
	const socketPath = path.join(dir, "target.sock");
	await writeFile(socketPath, ""); // regular file at a socket path: connect fails

	const { defaultMemberMessageCliDependencies } = await import("./commands/member-message.ts");
	for (const format of FORMATS) {
		const outcome = await runMemberMessageCommand(baseMessage({ format }), context(), {
			...defaultMemberMessageCliDependencies,
			resolveSource: () => ({ ok: true, kind: "id", idSocketPath: socketPath, aliasSocketPath: socketPath }),
		} as never);
		assert.equal(outcome.kind, "result", format);
		if (outcome.kind !== "result") continue;
		assert.equal(outcome.result.ok, false, format);
		assert.equal(outcome.format, format, format);
		assert.match(
			outcome.result.error?.code ?? "",
			/^(offline-session|transport-error)$/,
			`${format}: ${outcome.result.error?.code}`,
		);
	}
});
