import test from "node:test";
import assert from "node:assert/strict";
import { decode } from "@toon-format/toon";
import { renderCliResult } from "./output.ts";

const success = { ok: true as const, target: "/tmp/dev.sock", status: "completed" as const, response: "hello" };

test("TOON and JSON outputs are semantically equivalent", () => {
	const toon = renderCliResult(success, "toon", false);
	const json = renderCliResult(success, "json", false);
	assert.deepEqual(decode(toon), JSON.parse(json));
	assert.deepEqual(JSON.parse(json), {
		...success,
		truncation: { truncated: false, originalChars: 5, shownChars: 5 },
	});
});

test("bounds assistant output with explicit truncation metadata unless full", () => {
	const large = { ...success, response: "x".repeat(5000) };
	const bounded = JSON.parse(renderCliResult(large, "json", false));
	assert.equal(bounded.response.length, 2000);
	assert.deepEqual(bounded.truncation, { truncated: true, originalChars: 5000, shownChars: 2000 });
	assert.equal(JSON.parse(renderCliResult(large, "json", true)).response.length, 5000);
});

test("text emits only useful success output and concise errors", () => {
	assert.equal(renderCliResult(success, "text", false), "hello");
	assert.equal(
		renderCliResult({ ok: true, target: "/x", status: "accepted", data: { delivered: true } }, "text", false),
		"Message accepted",
	);
	assert.equal(
		renderCliResult(
			{ ok: false, target: "/x", status: "error", error: { code: "offline", message: "Socket is offline" } },
			"text",
			false,
		),
		"Socket is offline",
	);
});
