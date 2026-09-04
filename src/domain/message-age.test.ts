import test from "node:test";
import assert from "node:assert/strict";
import {
	UNAVAILABLE_MESSAGE_AGE,
	elapsedMessageMilliseconds,
	formatMessageAge,
	formatMessageAgeBetween,
	formatMessageHeader,
	MESSAGE_KINDS,
} from "./message-age.ts";

test("formatMessageAge uses deterministic duration buckets and boundaries", () => {
	const cases = [
		[0, "<1s"],
		[999, "<1s"],
		[1_000, "1s"],
		[59_999, "59s"],
		[60_000, "1m"],
		[3_599_999, "59m"],
		[3_600_000, "1h 0m"],
		[86_399_999, "23h 59m"],
		[86_400_000, "1d 0h"],
		[2 * 86_400_000 + 2 * 3_600_000 - 1, "2d 1h"],
	] as const;
	for (const [elapsed, expected] of cases) assert.equal(formatMessageAge(elapsed), expected);
});

test("formatMessageAge rejects invalid elapsed values without consulting a clock", () => {
	for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 1.5])
		assert.equal(formatMessageAge(value), UNAVAILABLE_MESSAGE_AGE);
});

test("elapsedMessageMilliseconds rejects malformed, future, and overflowing instants", () => {
	assert.equal(elapsedMessageMilliseconds(100, 250), 150);
	assert.equal(elapsedMessageMilliseconds(250, 100), null);
	assert.equal(elapsedMessageMilliseconds(-1, 100), null);
	assert.equal(elapsedMessageMilliseconds(Number.NaN, 100), null);
	assert.equal(elapsedMessageMilliseconds(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), 0);
	assert.equal(elapsedMessageMilliseconds(Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER), 1);
	assert.equal(elapsedMessageMilliseconds(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1), null);
});

test("formatMessageAgeBetween renders valid age and unavailable invalid timing", () => {
	assert.equal(formatMessageAgeBetween(1_000, 61_000), "1m");
	assert.equal(formatMessageAgeBetween(61_000, 60_999), UNAVAILABLE_MESSAGE_AGE);
});

test("formatMessageHeader uses the closed kind list and request ID only for request kinds", () => {
	assert.deepEqual(MESSAGE_KINDS, [
		"follow-up",
		"member request",
		"redirect",
		"interrupt",
		"inbox",
		"broadcast",
		"external intake",
		"member response",
	]);
	const crew = { kind: "crew" as const, name: "Mony", role: "lead" };
	assert.equal(
		formatMessageHeader({ kind: "follow-up", origin: crew, elapsedMs: 134_000, requestId: "hidden" }),
		"[follow-up] from Mony (lead) · age at delivery 2m",
	);
	assert.equal(
		formatMessageHeader({ kind: "member request", origin: crew, elapsedMs: 37 * 60_000, requestId: "request_123" }),
		"[member request] from Mony (lead) · age at delivery 37m · request request_123",
	);
	assert.equal(
		formatMessageHeader({
			kind: "member response",
			origin: { kind: "external", label: "jira-automation" },
			elapsedMs: 86_400_000 + 3 * 3_600_000,
			requestId: "request_123",
		}),
		"[member response] from jira-automation (unverified) · request age 1d 3h · request request_123",
	);
	assert.equal(
		formatMessageHeader({
			kind: "follow-up",
			origin: { kind: "guest", identity: "guest-1", name: "Taylor" },
			elapsedMs: 1_000,
		}),
		"[follow-up] from Taylor (guest) · age at delivery 1s",
	);
});

test("formatMessageHeader makes missing origin and invalid timing explicit", () => {
	assert.equal(
		formatMessageHeader({ kind: "external intake", elapsedMs: Number.NaN }),
		"[external intake] from unknown · age at delivery unavailable",
	);
});
