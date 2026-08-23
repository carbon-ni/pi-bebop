import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CrewManifest } from "./crew-manifest.ts";
import {
	buildBroadcastRecipients,
	createBroadcastId,
	createBroadcastPayload,
	createBroadcastRecipientItemId,
	deriveBroadcastOrigin,
	summarizeBroadcastDispositions,
	type BroadcastDisposition,
} from "./crew-broadcast.ts";

function manifest(members: Array<{ name: string; role: string }>): CrewManifest {
	return {
		version: 1,
		presence: { notifications: true },
		members: members.map((member) => ({
			...member,
			socket: `sockets/${member.name}.sock`,
			socketPath: `/p/.pi/bebop/sockets/${member.name}.sock`,
		})),
	};
}

const CREW = manifest([
	{ name: "Tony", role: "lead" },
	{ name: "Mary", role: "po" },
	{ name: "Bob", role: "dev" },
	{ name: "Kelly", role: "qa" },
]);

const REQUEST = { senderName: "Bob", content: "Constraint: no commit before independent QA" };

describe("createBroadcastId", () => {
	test("is stable for an identical request", () => {
		assert.equal(createBroadcastId(REQUEST), createBroadcastId({ ...REQUEST }));
	});

	test("changes when content, instructions, or sender change", () => {
		const base = createBroadcastId(REQUEST);
		assert.notEqual(createBroadcastId({ ...REQUEST, content: "different" }), base);
		assert.notEqual(
			createBroadcastId({ ...REQUEST, instructions: ["first", "second"] }),
			createBroadcastId({ ...REQUEST, instructions: ["second", "first"] }),
		);
		assert.notEqual(createBroadcastId({ ...REQUEST, senderName: "Mary" }), base);
	});

	test("rejects blank sender or content", () => {
		assert.throws(
			() => createBroadcastId({ senderName: "  ", content: "x" }),
			(error: Error) => ("code" in error ? error.code === "invalid-request" : false),
		);
		assert.throws(
			() => createBroadcastId({ senderName: "Bob", content: "" }),
			(error: Error) => ("code" in error ? error.code === "invalid-request" : false),
		);
	});
});

describe("createBroadcastRecipientItemId", () => {
	test("is deterministic per recipient and distinct across recipients and broadcasts", () => {
		const broadcastId = createBroadcastId(REQUEST);
		const otherBroadcastId = createBroadcastId({ ...REQUEST, content: "other" });
		assert.equal(
			createBroadcastRecipientItemId(broadcastId, "Mary"),
			createBroadcastRecipientItemId(broadcastId, "Mary"),
		);
		assert.notEqual(
			createBroadcastRecipientItemId(broadcastId, "Mary"),
			createBroadcastRecipientItemId(broadcastId, "Kelly"),
		);
		assert.notEqual(
			createBroadcastRecipientItemId(broadcastId, "Mary"),
			createBroadcastRecipientItemId(otherBroadcastId, "Mary"),
		);
	});
});

describe("deriveBroadcastOrigin", () => {
	test("derives a crew origin from the manifest member, never from caller claims", () => {
		const sender = CREW.members[2]!; // Bob
		assert.deepEqual(deriveBroadcastOrigin(sender), { kind: "crew", name: "Bob", role: "dev" });
	});
});

describe("createBroadcastPayload", () => {
	test("builds one validated payload with derived crew origin and ordered instructions", () => {
		const payload = createBroadcastPayload(CREW.members[2]!, REQUEST);
		assert.deepEqual(payload.origin, { kind: "crew", name: "Bob", role: "dev" });
		assert.equal(payload.content, REQUEST.content);
		assert.ok(!("replyTo" in payload));
		assert.ok(!("instructions" in payload));
	});

	test("rejects an invalid payload", () => {
		assert.throws(
			() => createBroadcastPayload(CREW.members[2]!, { content: "" }),
			(error: Error) => ("code" in error ? error.code === "invalid-payload" : false),
		);
	});
});

describe("buildBroadcastRecipients", () => {
	test("keeps manifest order and excludes the sender by exact canonical identity", () => {
		const result = buildBroadcastRecipients(CREW, "Bob", createBroadcastId(REQUEST));
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(
			result.recipients.map((recipient) => recipient.member.name),
			["Tony", "Mary", "Kelly"],
		);
		assert.deepEqual(
			result.recipients.map((recipient) => recipient.itemId),
			["Tony", "Mary", "Kelly"].map((name) => createBroadcastRecipientItemId(createBroadcastId(REQUEST), name)),
		);
	});

	test("never excludes a member by name/role heuristics, only the exact canonical identity", () => {
		const result = buildBroadcastRecipients(CREW, "Bob", createBroadcastId(REQUEST));
		assert.equal(result.ok, true);
		if (!result.ok) return;
		const names = result.recipients.map((recipient) => recipient.member.name);
		assert.ok(names.includes("Mary"));
		assert.ok(!names.includes("Bob"));
	});

	test("includes offline members: recipients never depend on presence", () => {
		const result = buildBroadcastRecipients(CREW, "Bob", createBroadcastId(REQUEST));
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.recipients.length, CREW.members.length - 1);
	});

	test("rejects a sender that is not a configured member before any recipient work", () => {
		const result = buildBroadcastRecipients(CREW, "ghost", createBroadcastId(REQUEST));
		assert.deepEqual(result, { ok: false, code: "unknown-sender" });
	});

	test("returns an explicit no-recipients result when self exclusion empties the crew", () => {
		const solo = manifest([{ name: "Bob", role: "dev" }]);
		const result = buildBroadcastRecipients(solo, "Bob", createBroadcastId(REQUEST));
		assert.deepEqual(result, { ok: false, code: "no-recipients" });
	});

	test("duplicate retry produces identical recipient item ids (idempotency contract)", () => {
		const first = buildBroadcastRecipients(CREW, "Bob", createBroadcastId(REQUEST));
		const retry = buildBroadcastRecipients(CREW, "Bob", createBroadcastId(REQUEST));
		assert.equal(first.ok, true);
		assert.equal(retry.ok, true);
		if (!first.ok || !retry.ok) return;
		assert.deepEqual(
			first.recipients.map((recipient) => recipient.itemId),
			retry.recipients.map((recipient) => recipient.itemId),
		);
	});
});

describe("summarizeBroadcastDispositions", () => {
	const dispositions: readonly BroadcastDisposition[] = [
		{ recipientName: "Tony", recipientRole: "lead", itemId: "a", status: "persisted" },
		{ recipientName: "Mary", recipientRole: "po", itemId: "b", status: "already-persisted" },
		{ recipientName: "Kelly", recipientRole: "qa", itemId: "c", status: "failed", code: "inbox-full" },
	];

	test("counts every disposition without masking partial failure", () => {
		assert.deepEqual(summarizeBroadcastDispositions(dispositions), {
			persisted: 1,
			alreadyPersisted: 1,
			failed: 1,
			total: 3,
		});
	});

	test("empty dispositions yield a zero summary", () => {
		assert.deepEqual(summarizeBroadcastDispositions([]), {
			persisted: 0,
			alreadyPersisted: 0,
			failed: 0,
			total: 0,
		});
	});
});
