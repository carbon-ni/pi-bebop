import assert from "node:assert/strict";
import test from "node:test";
import { errorCode, errorResult } from "./support/errors.ts";
import { ExternalIntakeError } from "../application/external-intake.ts";
import { DirectMessageError } from "../application/direct-message.ts";

test("errorCode maps system errors to stable CLI codes", () => {
	assert.equal(errorCode(Object.assign(new Error("x"), { code: "EACCES" })), "permission-denied");
	assert.equal(errorCode(Object.assign(new Error("x"), { code: "ENOENT" })), "offline");
	assert.equal(errorCode(new Error("connection timeout")), "timeout");
});

test("errorCode honors application error codes before fallbacks", () => {
	assert.equal(errorCode(new ExternalIntakeError("inbox-full", "full")), "inbox-full");
	assert.equal(errorCode(new DirectMessageError("rejected", "no")), "rejected");
});

test("errorCode maps malformed JSON or parse failures to malformed-response", () => {
	assert.equal(errorCode(new Error("Unexpected token in JSON")), "malformed-response");
});

test("errorResult produces a stable operational shape without stack leaks", () => {
	const result = errorResult("Operation failed", "target", "operational");
	assert.deepEqual(result, {
		ok: false,
		target: "target",
		status: "error",
		error: { code: "operational", message: "Operation failed" },
	});
});
