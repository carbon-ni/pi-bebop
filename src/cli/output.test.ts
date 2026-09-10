import test from "node:test";
import assert from "node:assert/strict";
import { decode } from "@toon-format/toon";
import { renderCliResult } from "./support/output.ts";

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

test("text presents crew rows with real line breaks", () => {
	const text = renderCliResult(
		{
			ok: true,
			target: "",
			status: "listed",
			data: {
				crews: [
					{
						selector: "alpha",
						displayName: "Alpha",
						availability: "online",
						memberCount: 1,
						onlineMembers: 1,
					},
				],
				total: 1,
				omitted: 0,
			},
		},
		"text",
		false,
	);
	assert.equal(text, "Crews (1):\n- alpha (Alpha) — online — 1/1 Members");
	assert.ok(!text.includes("\\\\n"));
});

test("text presents session rows, aliases, membership, totals, and omissions", () => {
	const text = renderCliResult(
		{
			ok: true,
			target: "",
			status: "listed",
			data: {
				sessions: [
					{ sessionId: "s-1", aliases: ["alpha", "project"], membership: "joined" },
					{ sessionId: "s-2", aliases: [], membership: "unknown" },
				],
				total: 3,
				omitted: 1,
			},
		},
		"text",
		false,
	);
	assert.equal(text, "Sessions (3):\n- s-1 (alpha, project) — joined\n- s-2 — unknown\nOmitted: 1");
	assert.match(
		renderCliResult(
			{ ok: true, target: "", status: "empty", data: { sessions: [], total: 0, next: "run session live" } },
			"text",
			false,
		),
		/^No sessions found \(total: 0\)\. run session live$/,
	);
});

test("text presents crew-init state, safe paths, and next command", () => {
	assert.equal(
		renderCliResult(
			{
				ok: true,
				target: "/project",
				status: "created",
				response: "ignored generic response",
				data: {
					status: "created",
					project: "/project",
					manifestPath: "/project/.pi/bebop/crew.json",
					createdPaths: ["crew.json", "common.md"],
					verifiedPaths: ["crew.json"],
					nextCommands: ["pi-bebop --crew-role lead"],
				},
			},
			"text",
			false,
		),
		"Crew scaffold created: /project\nManifest: /project/.pi/bebop/crew.json\nCreated: 2 path(s)\nVerified: 1 path(s)\nNext: pi-bebop --crew-role lead",
	);
});

test("text presents request, broadcast, Guest, and persisted data-only results", () => {
	assert.equal(
		renderCliResult(
			{ ok: true, target: "request-1", status: "accepted", data: { requestId: "request-1" } },
			"text",
			false,
		),
		"Request accepted: request-1",
	);
	assert.equal(
		renderCliResult(
			{ ok: true, target: "crew", status: "partial", data: { summary: { delivered: 2, failed: 1 } } },
			"text",
			false,
		),
		"Broadcast: 2 delivered, 1 failed",
	);
	assert.equal(
		renderCliResult(
			{
				ok: true,
				target: "member.sock",
				status: "accepted",
				data: { status: "pending", requestId: "guest-request", crew: { id: "alpha", displayName: "Alpha" } },
			},
			"text",
			false,
		),
		"Guest admission pending for Alpha (request guest-request)",
	);
	assert.equal(
		renderCliResult(
			{ ok: true, target: "member.sock", status: "left", data: { status: "left", crew: "alpha" } },
			"text",
			false,
		),
		"Left crew alpha",
	);
	assert.equal(
		renderCliResult(
			{
				ok: true,
				target: "member",
				status: "persisted",
				data: { itemId: "item-1", member: { name: "Mary", role: "po" } },
			},
			"text",
			false,
		),
		"Mary (po) — persisted item-1",
	);
});

test("data-only text success never falls through to Message completed", () => {
	const text = renderCliResult({ ok: true, target: "x", status: "observed", data: { state: "idle" } }, "text", false);
	assert.equal(text, "Operation succeeded");
	assert.doesNotMatch(text, /Message completed/);
});

test("text presents home state and next action without exposing internals", () => {
	assert.equal(
		renderCliResult(
			{
				ok: true,
				target: "",
				status: "home",
				data: { project: "/project", scaffold: "missing", commands: ["send"], next: "pi-bebop crew init" },
			},
			"text",
			false,
		),
		"Project: /project\nCrew scaffold: missing\nCommands: 1 available\nNext: pi-bebop crew init",
	);
	assert.equal(
		renderCliResult(
			{ ok: true, target: "", status: "home", data: { project: "", scaffold: "", commands: [], next: "" } },
			"text",
			false,
		),
		"Project: current project\nCrew scaffold: unknown",
	);
});

test("text presents request lists, responses, and direct deliveries", () => {
	assert.equal(
		renderCliResult({ ok: true, target: "", status: "listed", data: { requests: [] } }, "text", false),
		"No pending requests",
	);
	assert.equal(
		renderCliResult(
			{ ok: true, target: "request-1", status: "response", data: { kind: "timeout" } },
			"text",
			false,
		),
		"Request request-1: timeout",
	);
	assert.equal(
		renderCliResult(
			{ ok: true, target: "request-1", status: "response-accepted", data: { requestId: "request-1" } },
			"text",
			false,
		),
		"Response submitted for request request-1",
	);
	assert.equal(
		renderCliResult(
			{
				ok: true,
				target: "Bob",
				status: "accepted",
				data: { deliveryId: "delivery-1", disposition: "queued", member: { name: "Bob" } },
			},
			"text",
			false,
		),
		"Delivery to Bob: queued (delivery-1)",
	);
});

test("text presenter handles bounded fallback fields without raw object dumping", () => {
	assert.match(
		renderCliResult(
			{
				ok: true,
				target: "",
				status: "listed",
				data: { sessions: [{ aliases: [1, "a"], membership: "" }], omitted: 0 },
			},
			"text",
			false,
		),
		/- unknown \(a\) — unknown/,
	);
	assert.equal(
		renderCliResult(
			{ ok: true, target: "", status: "listed", data: { roles: [{ role: "lead" }, {}] } },
			"text",
			false,
		),
		"2 configured roles: lead, unknown",
	);
	assert.equal(
		renderCliResult(
			{
				ok: true,
				target: "/project",
				status: "verified",
				data: {
					status: "",
					manifestPath: "/crew.json",
					project: "",
					createdPaths: [],
					verifiedPaths: [],
					nextCommands: [],
				},
			},
			"text",
			false,
		),
		"Crew scaffold verified: /project\nManifest: /crew.json",
	);
	assert.equal(
		renderCliResult(
			{ ok: true, target: "", status: "listed", data: { requests: [{ id: "r" }], omitted: 2 } },
			"text",
			false,
		),
		"1 request(s) listed; omitted: 2",
	);
	assert.equal(
		renderCliResult(
			{ ok: true, target: "", status: "approved", data: { status: "approved", crew: { id: "alpha" } } },
			"text",
			false,
		),
		"Guest admission approved for alpha",
	);
	assert.equal(
		renderCliResult(
			{ ok: true, target: "", status: "accepted", data: { deliveryId: "d", disposition: "direct" } },
			"text",
			false,
		),
		"Delivery to target: direct (d)",
	);
	assert.equal(renderCliResult({ ok: true, target: "", status: "empty" }, "text", false), "No results found");
	assert.equal(renderCliResult({ ok: true, target: "", status: "persisted" }, "text", false), "Message persisted");
});

test("text presenter covers empty and singular canonical projections", () => {
	assert.equal(
		renderCliResult({ ok: true, target: "", status: "listed", data: { sessions: [], total: 0 } }, "text", false),
		"No sessions found (total: 0). Start a session and retry.",
	);
	assert.equal(
		renderCliResult(
			{ ok: true, target: "", status: "listed", data: { roles: ["lead"], roleCount: 1 } },
			"text",
			false,
		),
		"1 configured role: lead",
	);
	assert.equal(
		renderCliResult(
			{ ok: true, target: "", status: "persisted", data: { itemId: "i", member: {} } },
			"text",
			false,
		),
		"member — persisted i",
	);
	assert.equal(
		renderCliResult(
			{ ok: true, target: "", status: "approved", data: { status: "approved", crew: {} } },
			"text",
			false,
		),
		"Guest admission approved for crew",
	);
});
