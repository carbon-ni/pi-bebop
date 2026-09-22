import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMemberStatusEnvelope, probeMemberStatus } from "./plan-loop-probe.mjs";

const worker = { name: "Dave", role: "dev" };
const status = (overrides = {}) => ({
	member: worker,
	presence: "online",
	activity: "idle",
	hasPendingMessages: false,
	observedAt: "2026-09-22T12:00:00.000Z",
	...overrides,
});

const envelope = (value) =>
	JSON.stringify({ ok: true, target: worker.name, status: "observed", data: { status: value } });

test("parses the current member status CLI envelope", () => {
	assert.deepEqual(parseMemberStatusEnvelope(envelope(status()), worker), { kind: "idle", detail: "idle" });
});

test("treats pending messages as busy even when activity is idle", () => {
	assert.deepEqual(parseMemberStatusEnvelope(envelope(status({ hasPendingMessages: true })), worker), {
		kind: "busy",
		detail: "pending-messages",
	});
});

test("parses the current offline member status sentinel fields", () => {
	assert.deepEqual(
		parseMemberStatusEnvelope(
			envelope(
				status({
					presence: "offline",
					activity: "unavailable",
					hasPendingMessages: "unavailable",
				}),
			),
			worker,
		),
		{ kind: "offline", detail: "offline" },
	);
});

test("fails closed for malformed and identity-mismatched results", () => {
	assert.equal(parseMemberStatusEnvelope("not json", worker).kind, "error");
	assert.equal(
		parseMemberStatusEnvelope(envelope(status({ member: { name: "Kelly", role: "qa" } })), worker).detail,
		"identity-mismatch",
	);
});

test("uses argv-only CLI invocation and parses an operational failure envelope", async () => {
	let received;
	const state = await probeMemberStatus(worker, {
		command: "pi-bebop",
		session: "source-1",
		run: async (command, args) => {
			received = { command, args };
			return {
				stdout: JSON.stringify({ ok: false, target: "Dave", status: "error", error: { code: "offline" } }),
			};
		},
	});
	assert.deepEqual(received, {
		command: "pi-bebop",
		args: ["member", "status", "Dave", "--format", "json", "--session", "source-1"],
	});
	assert.deepEqual(state, { kind: "offline", detail: "offline" });
});
