import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { pickRoleSession } from "./role-session-picker.ts";

const candidate = {
	sessionId: "session-1",
	sessionFile: "/sessions/one.jsonl",
	cwd: "/project",
	root: "/sessions",
	modified: "2026-09-12T10:00:00.000Z",
	name: "One",
};

async function picker(answer: string, candidates = [candidate]) {
	const input = new PassThrough();
	const output = new PassThrough();
	const chunks: Buffer[] = [];
	output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
	const resultPromise = pickRoleSession(candidates, input, output);
	setImmediate(() => input.end(`${answer}\n`));
	return { result: await resultPromise, output: Buffer.concat(chunks).toString("utf8") };
}

test("selects one exact candidate and keeps picker separate from Pi native history", async () => {
	const result = await picker("1");
	assert.deepEqual(result.result, { kind: "selected", candidate });
	assert.match(result.output, /1\) One/);
});

test("empty, invalid, and cancellation never select a fallback session", async () => {
	assert.deepEqual((await picker("1", [])).result, { kind: "empty" });
	assert.deepEqual((await picker("q")).result, { kind: "cancelled" });
	assert.deepEqual((await picker("quit")).result, { kind: "cancelled" });
	assert.deepEqual((await picker("")).result, { kind: "cancelled" });
	assert.deepEqual((await picker("not-a-number")).result, { kind: "cancelled" });
	assert.deepEqual((await picker("9")).result, { kind: "cancelled" });
});

test("aborting the picker cancels and closes the readline session", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	const controller = new AbortController();
	const result = pickRoleSession([candidate], input, output, controller.signal);
	controller.abort();
	assert.deepEqual(await result, { kind: "cancelled" });
	input.end();
});

test("unexpected picker option failures are treated as cancellation", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	const result = pickRoleSession([candidate], input, output, {} as AbortSignal);
	assert.deepEqual(await result, { kind: "cancelled" });
	input.end();
});
