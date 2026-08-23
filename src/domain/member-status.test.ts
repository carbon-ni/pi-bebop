import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Value } from "@sinclair/typebox/value";
import {
	MAX_MEMBER_FOCUS_BYTES,
	MEMBER_FOCUS_ENTRY_TYPE,
	MemberStatusSchema,
	createMemberFocusEntryData,
	createOfflineMemberStatus,
	createOnlineMemberStatus,
	deriveMemberActivity,
	formatMemberStatus,
	isMemberFocusEntryData,
	isMemberStatus,
	restoreMemberFocus,
} from "./member-status.ts";

const bob = { name: "Bob", role: "developer" };
const observedAt = "2026-08-23T12:03:00.000Z";
const bobIdentity = "/project/.pi/bebop/sockets/dev.sock";

describe("member activity and status", () => {
	test("derives activity only from Pi idle state", () => {
		assert.equal(deriveMemberActivity(true), "idle");
		assert.equal(deriveMemberActivity(false), "busy");
	});

	test("builds online status with mechanical pending state and reported focus", () => {
		const status = createOnlineMemberStatus({
			member: bob,
			isIdle: false,
			hasPendingMessages: true,
			focus: {
				state: "reported",
				text: "Implementing Inbox enqueue",
				updatedAt: "2026-08-23T12:00:00.000Z",
			},
			observedAt,
		});

		assert.deepEqual(status, {
			member: bob,
			presence: "online",
			activity: "busy",
			hasPendingMessages: true,
			focus: {
				state: "reported",
				text: "Implementing Inbox enqueue",
				updatedAt: "2026-08-23T12:00:00.000Z",
			},
			observedAt,
		});
		assert.equal(isMemberStatus(status), true);
		assert.equal(Value.Check(MemberStatusSchema, status), true);
	});

	test("represents unspecified focus while online", () => {
		const status = createOnlineMemberStatus({
			member: bob,
			isIdle: true,
			hasPendingMessages: false,
			focus: { state: "unspecified" },
			observedAt,
		});

		assert.equal(status.activity, "idle");
		assert.deepEqual(status.focus, { state: "unspecified" });
		assert.equal(status.hasPendingMessages, false);
	});

	test("offline status never presents stale activity, pending state, or focus", () => {
		const status = createOfflineMemberStatus(bob, observedAt);
		assert.deepEqual(status, {
			member: bob,
			presence: "offline",
			activity: "unavailable",
			hasPendingMessages: "unavailable",
			focus: { state: "unavailable" },
			observedAt,
		});
		assert.equal(isMemberStatus(status), true);
		assert.equal(JSON.stringify(status).includes("Implementing"), false);
	});

	test("closed schema rejects malformed timestamps and private or unrelated fields", () => {
		const valid = createOnlineMemberStatus({
			member: bob,
			isIdle: true,
			hasPendingMessages: false,
			focus: { state: "unspecified" },
			observedAt,
		});
		const invalidValues = [
			{ ...valid, observedAt: "yesterday" },
			{ ...valid, sessionId: "secret" },
			{ ...valid, message: "private prompt" },
			{ ...valid, instructions: ["private"] },
			{ ...valid, toolCalls: [] },
			{ ...valid, model: "provider/model" },
			{ ...valid, member: { ...valid.member, socketPath: bobIdentity } },
			{ ...valid, member: { ...valid.member, description: "stable profile" } },
			{ ...valid, focus: { state: "unspecified", text: "must not exist" } },
		];

		for (const invalid of invalidValues) {
			assert.equal(isMemberStatus(invalid), false);
			assert.equal(Value.Check(MemberStatusSchema, invalid), false);
		}
	});

	test("builders reject malformed public labels, focus, and timestamps", () => {
		assert.throws(
			() =>
				createOnlineMemberStatus({
					member: { name: "Bob\nprivate", role: "developer" },
					isIdle: true,
					hasPendingMessages: false,
					focus: { state: "unspecified" },
					observedAt,
				}),
			/member status/i,
		);
		assert.throws(() => createOfflineMemberStatus(bob, "2026-02-30T12:03:00.000Z"), /member status/i);
		assert.throws(
			() =>
				createOnlineMemberStatus({
					member: bob,
					isIdle: true,
					hasPendingMessages: false,
					focus: { state: "reported", text: " padded", updatedAt: observedAt },
					observedAt,
				}),
			/member status/i,
		);
	});
});

describe("member focus persistence contract", () => {
	test("creates strict set and clear data for typed custom session entries", () => {
		const set = createMemberFocusEntryData({
			memberIdentity: bobIdentity,
			action: "set",
			focus: "Investigating inbox recovery",
			updatedAt: "2026-08-23T12:00:00.000Z",
		});
		const clear = createMemberFocusEntryData({
			memberIdentity: bobIdentity,
			action: "clear",
			updatedAt: "2026-08-23T12:05:00.000Z",
		});

		assert.equal(MEMBER_FOCUS_ENTRY_TYPE, "bebop-member-focus");
		assert.equal(isMemberFocusEntryData(set), true);
		assert.equal(isMemberFocusEntryData(clear), true);
		assert.equal("focus" in clear, false);
	});

	test("accepts exact UTF-8 focus limit and rejects unsafe or oversized focus", () => {
		const base = {
			memberIdentity: bobIdentity,
			action: "set" as const,
			updatedAt: "2026-08-23T12:00:00.000Z",
		};
		assert.doesNotThrow(() => createMemberFocusEntryData({ ...base, focus: "é".repeat(128) }));

		for (const focus of [
			"",
			"   ",
			" padded",
			"padded ",
			"two\nlines",
			"nul\0byte",
			"é".repeat(MAX_MEMBER_FOCUS_BYTES / 2 + 1),
		]) {
			assert.throws(() => createMemberFocusEntryData({ ...base, focus }), /focus/i);
		}
		assert.throws(
			() => createMemberFocusEntryData({ ...base, action: "clear", focus: "must not exist" }),
			/focus/i,
		);
	});

	test("rejects invalid member identity and update timestamp", () => {
		assert.throws(
			() =>
				createMemberFocusEntryData({
					memberIdentity: "old\nmember",
					action: "clear",
					updatedAt: observedAt,
				}),
			/focus/i,
		);
		assert.throws(
			() =>
				createMemberFocusEntryData({
					memberIdentity: bobIdentity,
					action: "clear",
					updatedAt: "not-a-time",
				}),
			/focus/i,
		);
	});

	test("restores latest focus for exact membership and clear remains isolated", () => {
		const qaIdentity = "/project/.pi/bebop/sockets/qa.sock";
		const entry = (data: unknown) => ({ type: "custom", customType: MEMBER_FOCUS_ENTRY_TYPE, data });
		const entries = [
			entry(
				createMemberFocusEntryData({
					memberIdentity: qaIdentity,
					action: "set",
					focus: "Reviewing security",
					updatedAt: "2026-08-23T11:59:00.000Z",
				}),
			),
			entry(
				createMemberFocusEntryData({
					memberIdentity: bobIdentity,
					action: "set",
					focus: "Implementing status schema",
					updatedAt: "2026-08-23T12:00:00.000Z",
				}),
			),
			entry(
				createMemberFocusEntryData({
					memberIdentity: bobIdentity,
					action: "set",
					focus: "Reviewing status schema",
					updatedAt: "2026-08-23T12:02:00.000Z",
				}),
			),
		];

		assert.deepEqual(restoreMemberFocus(entries, bobIdentity), {
			state: "reported",
			text: "Reviewing status schema",
			updatedAt: "2026-08-23T12:02:00.000Z",
		});
		assert.deepEqual(restoreMemberFocus(entries, qaIdentity), {
			state: "reported",
			text: "Reviewing security",
			updatedAt: "2026-08-23T11:59:00.000Z",
		});
		assert.deepEqual(restoreMemberFocus(entries, "/project/.pi/bebop/sockets/lead.sock"), {
			state: "unspecified",
		});

		entries.push(
			entry(
				createMemberFocusEntryData({
					memberIdentity: bobIdentity,
					action: "clear",
					updatedAt: "2026-08-23T12:05:00.000Z",
				}),
			),
		);
		assert.deepEqual(restoreMemberFocus(entries, bobIdentity), { state: "unspecified" });
		assert.equal(restoreMemberFocus(entries, qaIdentity).state, "reported");
	});

	test("ignores malformed, wrong-type, and unrelated session entries without throwing", () => {
		const entries = [
			null,
			42,
			"invalid",
			{ type: "message", customType: MEMBER_FOCUS_ENTRY_TYPE, data: {} },
			{ type: "custom", customType: "other", data: {} },
			{
				type: "custom",
				customType: MEMBER_FOCUS_ENTRY_TYPE,
				data: {
					version: 1,
					memberIdentity: bobIdentity,
					action: "set",
					focus: "private",
					updatedAt: "invalid",
				},
			},
		];
		assert.deepEqual(restoreMemberFocus(entries, bobIdentity), { state: "unspecified" });
	});
});

describe("privacy-safe member status formatting", () => {
	test("labels reported focus and keeps unspecified and unavailable explicit", () => {
		const reported = createOnlineMemberStatus({
			member: bob,
			isIdle: false,
			hasPendingMessages: true,
			focus: {
				state: "reported",
				text: "Implementing status schema",
				updatedAt: "2026-08-23T12:00:00.000Z",
			},
			observedAt,
		});
		assert.equal(
			formatMemberStatus(reported),
			"Bob (developer) — online — busy — pending messages — Focus (member-reported): Implementing status schema",
		);

		const unspecified = createOnlineMemberStatus({
			member: bob,
			isIdle: true,
			hasPendingMessages: false,
			focus: { state: "unspecified" },
			observedAt,
		});
		assert.equal(formatMemberStatus(unspecified), "Bob (developer) — online — idle — Focus: unspecified");
		assert.equal(
			formatMemberStatus(createOfflineMemberStatus(bob, observedAt)),
			"Bob (developer) — offline — activity unavailable — Focus: unavailable",
		);
	});

	test("formatted output contains no hidden status fields", () => {
		const output = formatMemberStatus(
			createOnlineMemberStatus({
				member: bob,
				isIdle: true,
				hasPendingMessages: false,
				focus: { state: "unspecified" },
				observedAt,
			}),
		);
		for (const forbidden of [
			"sessionId",
			"socketPath",
			"description",
			"instructions",
			"toolCall",
			"model",
			"alias",
		]) {
			assert.equal(output.includes(forbidden), false);
		}
	});
});
