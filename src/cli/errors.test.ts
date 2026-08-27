import assert from "node:assert/strict";
import test from "node:test";
import { errorCode, errorResult, requestedFormat, usageResult } from "./errors.ts";
import { ExternalIntakeError } from "../application/external-intake.ts";
import { DirectMessageError } from "../application/direct-message.ts";

test("errorCode maps system errors to stable CLI codes", () => {
	assert.equal(errorCode(Object.assign(new Error("denied"), { code: "EACCES" })), "permission-denied");
	assert.equal(errorCode(Object.assign(new Error("denied"), { code: "EPERM" })), "permission-denied");
	assert.equal(errorCode(Object.assign(new Error("missing"), { code: "ENOENT" })), "offline");
	assert.equal(errorCode(new Error("connection timeout")), "timeout");
	assert.equal(errorCode(Object.assign(new Error("Operation aborted"), { name: "AbortError" })), "aborted");
	assert.equal(errorCode(new Error("unknown failure")), "offline");
});

test("errorCode honors application error codes before fallbacks", () => {
	assert.equal(errorCode(new ExternalIntakeError("inbox-full", "full")), "inbox-full");
	assert.equal(errorCode(new ExternalIntakeError("untrusted-path", "layout")), "untrusted-path");
	assert.equal(errorCode(new DirectMessageError("remote-rejected", "busy")), "remote-rejected");
});

test("errorCode maps malformed JSON or parse failures to malformed-response", () => {
	assert.equal(errorCode(new Error("malformed JSON response")), "malformed-response");
	assert.equal(errorCode(new Error("parse failure")), "malformed-response");
	assert.equal(errorCode(new Error("JSON envelope invalid")), "malformed-response");
});

test("requestedFormat honors --format and --format=, last occurrence wins", () => {
	assert.equal(requestedFormat([]), "text");
	assert.equal(requestedFormat(["send", "--format", "toon"]), "toon");
	assert.equal(requestedFormat(["member", "status", "--format", "toon"]), "toon");
	assert.equal(requestedFormat(["--format", "json"]), "json");
	assert.equal(requestedFormat(["--format=text"]), "text");
	assert.equal(requestedFormat(["--format", "json", "--format=text"]), "text");
	assert.equal(requestedFormat(["--format", "json", "--wait", "later"]), "json");
});

test("usageResult and errorResult produce stable shapes without stack leaks", () => {
	assert.deepEqual(usageResult("boom"), {
		ok: false,
		target: "",
		status: "usage",
		error: { code: "usage", message: "boom" },
	});
	assert.deepEqual(errorResult("nope", "/x", "offline"), {
		ok: false,
		target: "/x",
		status: "error",
		error: { code: "offline", message: "nope" },
	});
});
