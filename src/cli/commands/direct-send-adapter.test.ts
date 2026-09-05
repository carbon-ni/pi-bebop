import assert from "node:assert/strict";
import test from "node:test";
import { deliverDirectMessage, type DirectSendDependencies } from "./direct-send-adapter.ts";
import type { SendCliOptions } from "../arguments.ts";
import type { DirectMessageRequest } from "../../application/direct-message.ts";

function options(overrides: Partial<SendCliOptions> = {}): SendCliOptions {
	return {
		command: "send",
		socketPath: "/tmp/peer.sock",
		instructions: ["first", "second"],
		origin: { kind: "external", label: "CI" },
		stdin: false,
		mode: "follow_up",
		wait: "accepted",
		timeoutMs: 1200,
		format: "toon",
		full: false,
		...overrides,
	};
}

test("delivers a typed direct request and maps the result to an outcome", async () => {
	const signal = new AbortController().signal;
	const captured: DirectMessageRequest[] = [];
	const deps: DirectSendDependencies = {
		send: async (request) => {
			captured.push(request);
			return { status: "accepted" };
		},
	};
	const outcome = await deliverDirectMessage(options(), "hello", signal, deps);
	assert.equal(outcome.kind, "result");
	if (outcome.kind !== "result") return;
	assert.equal(outcome.result.ok, true);
	assert.equal(outcome.result.status, "accepted");
	assert.equal(outcome.result.target, "/tmp/peer.sock");
	assert.equal(outcome.format, "toon");
	assert.equal(captured.length, 1);
	assert.deepEqual(captured[0], {
		socketPath: "/tmp/peer.sock",
		message: "hello",
		instructions: ["first", "second"],
		origin: { kind: "external", label: "CI" },
		mode: "follow_up",
		wait: "accepted",
		timeoutMs: 1200,
		signal,
	});
});

test("omits optional fields when absent and preserves the assistant response", async () => {
	const deps: DirectSendDependencies = {
		send: async (request) => ({
			status: "completed",
			message: { role: "assistant", content: "answer", timestamp: 1 },
			turnIndex: 3,
		}),
	};
	const outcome = await deliverDirectMessage(
		options({ instructions: [], origin: undefined }),
		"hello",
		new AbortController().signal,
		deps,
	);
	assert.equal(outcome.kind, "result");
	if (outcome.kind !== "result") return;
	assert.equal(outcome.result.response, "answer");
	assert.equal(outcome.result.turnIndex, 3);
});

test("delivery failures propagate for the handler to map", async () => {
	const deps: DirectSendDependencies = {
		send: async () => {
			throw Object.assign(new Error("missing"), { code: "ENOENT" });
		},
	};
	await assert.rejects(deliverDirectMessage(options(), "hello", new AbortController().signal, deps), {
		code: "ENOENT",
	});
});
