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

const intakeResult = {
	ok: true as const,
	target: "/project/.pi/bebop/crew.json",
	status: "persisted" as const,
	response: "Persisted for Mary (po) — inbox item inbox-0-abc",
	data: { ok: true, itemId: "inbox-0-abc", persisted: true, contact: "Mary", contactRole: "po" },
};

test("persisted intake output carries item id, contact, and persisted; never delivery/completion claims", () => {
	const json = JSON.parse(renderCliResult(intakeResult, "json", false));
	assert.equal(json.status, "persisted");
	assert.deepEqual(json.data, {
		ok: true,
		itemId: "inbox-0-abc",
		persisted: true,
		contact: "Mary",
		contactRole: "po",
	});
	for (const forbidden of ["delivered", "completed", "assigned", "answered"]) {
		assert.ok(!JSON.stringify(json).toLowerCase().includes(forbidden), `forbidden word: ${forbidden}`);
	}
	const toon = decode(renderCliResult(intakeResult, "toon", false));
	assert.deepEqual(toon, JSON.parse(renderCliResult(intakeResult, "json", false)));
});

test("persisted text output renders the one-way acknowledgement", () => {
	assert.equal(renderCliResult(intakeResult, "text", false), "Persisted for Mary (po) — inbox item inbox-0-abc");
});

test("persisted text falls back to a neutral ack never 'completed'", () => {
	assert.equal(
		renderCliResult({ ok: true, target: "/x", status: "persisted", data: { itemId: "i" } }, "text", false),
		"Message persisted",
	);
});
