import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { readStdinMessage } from "./message-input.ts";

test("reads injected stdin until end and resolves the exact UTF-8 bytes", async () => {
	const input = new PassThrough();
	input.end("line one\nline two\n");
	const signal = new AbortController().signal;
	assert.equal(await readStdinMessage(input, signal), "line one\nline two\n");
});

test("rejects with the input error when stdin errors", async () => {
	const input = new PassThrough();
	const signal = new AbortController().signal;
	const pending = readStdinMessage(input, signal);
	input.emit("error", Object.assign(new Error("stdin closed"), { code: "EIO" }));
	await assert.rejects(pending, (error: unknown) => (error as NodeJS.ErrnoException).code === "EIO");
});

test("rejects with the abort reason when the signal aborts a held-open read", async () => {
	const input = new PassThrough();
	const controller = new AbortController();
	const abortError = Object.assign(new Error("Operation aborted"), { name: "AbortError" });
	const pending = readStdinMessage(input, controller.signal);
	controller.abort(abortError);
	await assert.rejects(pending, (error: unknown) => (error as Error).name === "AbortError");
});

test("rejects with a usage error when stdin exceeds the byte bound", async () => {
	const input = new PassThrough();
	const signal = new AbortController().signal;
	const pending = readStdinMessage(input, signal, 8);
	input.end("0123456789");
	await assert.rejects(pending, /exceeds/);
});

test("accepts input exactly at the byte bound", async () => {
	const input = new PassThrough();
	input.end("12345678");
	const signal = new AbortController().signal;
	assert.equal(await readStdinMessage(input, signal, 8), "12345678");
});

test("does not leak listeners after a completed read", async () => {
	const input = new PassThrough();
	input.end("done");
	const signal = new AbortController().signal;
	await readStdinMessage(input, signal);
	assert.equal(input.listenerCount("data"), 0);
	assert.equal(input.listenerCount("end"), 0);
	assert.equal(signal.aborted, false);
});
