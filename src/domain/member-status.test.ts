import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Value } from "@sinclair/typebox/value";
import {
	MemberStatusSchema,
	createOfflineMemberStatus,
	createOnlineMemberStatus,
	deriveMemberActivity,
	formatMemberStatus,
	isMemberStatus,
} from "./member-status.ts";

const bob = { name: "Bob", role: "developer" };
const observedAt = "2026-08-23T12:03:00.000Z";

describe("member activity and status", () => {
	test("derives compacting before busy before idle", () => {
		assert.equal(deriveMemberActivity(true), "idle");
		assert.equal(deriveMemberActivity(false), "busy");
		assert.equal(deriveMemberActivity(true, true), "compacting");
		assert.equal(deriveMemberActivity(false, true), "compacting");
	});

	test("builds online status with mechanical pending state only", () => {
		const status = createOnlineMemberStatus({
			member: bob,
			isIdle: false,
			hasPendingMessages: true,
			observedAt,
		});

		assert.deepEqual(status, {
			member: bob,
			presence: "online",
			activity: "busy",
			hasPendingMessages: true,
			observedAt,
		});
		assert.equal(isMemberStatus(status), true);
		assert.equal(Value.Check(MemberStatusSchema, status), true);
	});

	test("reports compacting without exposing compaction details", () => {
		const status = createOnlineMemberStatus({
			member: bob,
			isIdle: true,
			isCompacting: true,
			hasPendingMessages: false,
			observedAt,
		});
		assert.equal(status.activity, "compacting");
		assert.equal(isMemberStatus(status), true);
		assert.equal(Object.keys(status).includes("reason"), false);
	});

	test("online idle status exposes only mechanical fields", () => {
		const status = createOnlineMemberStatus({
			member: bob,
			isIdle: true,
			hasPendingMessages: false,
			observedAt,
		});

		assert.equal(status.activity, "idle");
		assert.equal(status.hasPendingMessages, false);
	});

	test("offline status never presents stale activity or pending state", () => {
		const status = createOfflineMemberStatus(bob, observedAt);
		assert.deepEqual(status, {
			member: bob,
			presence: "offline",
			activity: "unavailable",
			hasPendingMessages: "unavailable",
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
			observedAt,
		});
		const invalidValues = [
			{ ...valid, observedAt: "yesterday" },
			{ ...valid, sessionId: "secret" },
			{ ...valid, message: "private prompt" },
			{ ...valid, instructions: ["private"] },
			{ ...valid, toolCalls: [] },
			{ ...valid, model: "provider/model" },
			{ ...valid, member: { ...valid.member, socketPath: "/project/.pi/bebop/sockets/dev.sock" } },
			{ ...valid, member: { ...valid.member, description: "stable profile" } },
			{ ...valid, focus: { state: "unspecified", text: "must not exist" } },
		];

		for (const invalid of invalidValues) {
			assert.equal(isMemberStatus(invalid), false);
			assert.equal(Value.Check(MemberStatusSchema, invalid), false);
		}
	});

	test("builders reject malformed public labels and timestamps", () => {
		assert.throws(
			() =>
				createOnlineMemberStatus({
					member: { name: "Bob\nprivate", role: "developer" },
					isIdle: true,
					hasPendingMessages: false,
					observedAt,
				}),
			/member status/i,
		);
		assert.throws(() => createOfflineMemberStatus(bob, "2026-02-30T12:03:00.000Z"), /member status/i);
	});
});

describe("privacy-safe member status formatting", () => {
	test("labels mechanical activity, pending state, and offline explicitly", () => {
		const busy = createOnlineMemberStatus({
			member: bob,
			isIdle: false,
			hasPendingMessages: true,
			observedAt,
		});
		assert.equal(formatMemberStatus(busy), "Bob (developer) — online — busy — pending messages");

		const idle = createOnlineMemberStatus({
			member: bob,
			isIdle: true,
			hasPendingMessages: false,
			observedAt,
		});
		assert.equal(formatMemberStatus(idle), "Bob (developer) — online — idle");
		assert.equal(
			formatMemberStatus(createOfflineMemberStatus(bob, observedAt)),
			"Bob (developer) — offline — activity unavailable",
		);
	});

	test("formatted output contains no hidden status fields", () => {
		const output = formatMemberStatus(
			createOnlineMemberStatus({
				member: bob,
				isIdle: true,
				hasPendingMessages: false,
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
			"focus",
		]) {
			assert.equal(output.includes(forbidden), false);
		}
	});
});
