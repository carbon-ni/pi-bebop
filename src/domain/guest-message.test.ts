import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	buildGuestBroadcastRecipients,
	createGuestMessagePayload,
	deriveGuestOrigin,
	GuestMessageError,
	resolveGuestTarget,
	validateGuestMessageInput,
} from "./guest-message.ts";

const members = [
	{ name: "lead", role: "lead" },
	{ name: "dev", role: "developer" },
	{ name: "qa", role: "QA" },
];

describe("Guest message target resolution", () => {
	test("resolves exact unique member names and unique roles inside the crew", () => {
		assert.deepEqual(resolveGuestTarget(members, "dev"), { name: "dev", role: "developer" });
		assert.deepEqual(resolveGuestTarget(members, "developer"), { name: "dev", role: "developer" });
	});

	test("rejects unknown targets and ambiguous roles without guessing", () => {
		assert.throws(
			() => resolveGuestTarget(members, "nobody"),
			(error: GuestMessageError) => {
				assert.equal(error.code, "unknown-member");
				assert.match(error.message, /Unknown crew member: nobody/);
				return true;
			},
		);
		assert.throws(
			() => resolveGuestTarget([...members, { name: "qa2", role: "QA" }], "QA"),
			(error: GuestMessageError) => {
				assert.equal(error.code, "ambiguous-member");
				assert.match(error.message, /Ambiguous crew role: QA/);
				return true;
			},
		);
	});

	test("rejects empty, padded, and non-canonical targets", () => {
		assert.throws(
			() => resolveGuestTarget(members, ""),
			(error: GuestMessageError) => error.code === "unknown-member",
		);
		assert.throws(
			() => resolveGuestTarget(members, " dev"),
			(error: GuestMessageError) => error.code === "unknown-member",
		);
	});
});

describe("Guest message input validation", () => {
	test("requires an exact crew selector and non-empty content", () => {
		assert.throws(
			() => validateGuestMessageInput({ crew: "", message: "hello" }),
			(error: GuestMessageError) => {
				assert.equal(error.code, "invalid-request");
				assert.match(error.message, /crew selector is required/);
				return true;
			},
		);
		assert.throws(
			() => validateGuestMessageInput({ crew: "alpha", message: "  " }),
			(error: GuestMessageError) => {
				assert.equal(error.code, "invalid-request");
				assert.match(error.message, /non-empty message/);
				return true;
			},
		);
		assert.throws(
			() => validateGuestMessageInput({ crew: "alpha", message: "hi", instructions: ["", "x"] }),
			(error: GuestMessageError) => error.code === "invalid-request",
		);
		assert.equal(validateGuestMessageInput({ crew: "alpha", message: "hello" }).crew, "alpha");
	});
});

describe("Guest origin and payload", () => {
	test("derives typed guest origin from approved runtime identity", () => {
		assert.deepEqual(deriveGuestOrigin({ identity: "guest-session", name: "Alex" }), {
			kind: "guest",
			identity: "guest-session",
			name: "Alex",
		});
	});

	test("builds a follow-up payload with guest origin and no reply route", () => {
		const payload = createGuestMessagePayload(
			{ identity: "guest-session", name: "Alex" },
			{ message: "hello crew", instructions: ["be brief"] },
		);
		assert.deepEqual(payload, {
			content: "hello crew",
			instructions: ["be brief"],
			origin: { kind: "guest", identity: "guest-session", name: "Alex" },
			kind: "follow-up",
		});
		assert.equal("replyTo" in payload, false);
		assert.equal(payload.sentAt, undefined, "sentAt stays source-owned and is stamped by the transport seam");
	});
});

describe("Guest broadcast recipients", () => {
	test("includes manifest members and approved guests in deterministic order, excluding the guest sender", () => {
		const result = buildGuestBroadcastRecipients({
			crewMembers: members,
			approvedGuests: [
				{ identity: "guest-a", name: "Alex" },
				{ identity: "guest-b", name: "Blake" },
			],
			sender: { kind: "guest", identity: "guest-a", name: "Alex" },
		});
		assert.ok(result.ok);
		if (!result.ok) return;
		assert.deepEqual(result.recipients, [
			{ kind: "member", name: "lead", role: "lead" },
			{ kind: "member", name: "dev", role: "developer" },
			{ kind: "member", name: "qa", role: "QA" },
			{ kind: "guest", identity: "guest-b", name: "Blake" },
		]);
	});

	test("excludes a member sender by name and guest senders by identity", () => {
		const memberSender = buildGuestBroadcastRecipients({
			crewMembers: members,
			approvedGuests: [{ identity: "guest-b", name: "Blake" }],
			sender: { kind: "member", name: "dev" },
		});
		assert.ok(memberSender.ok);
		if (memberSender.ok) {
			assert.deepEqual(
				memberSender.recipients.map((recipient) => ("role" in recipient ? recipient.name : recipient.name)),
				["lead", "qa", "Blake"],
			);
		}

		const unknownMemberSender = buildGuestBroadcastRecipients({
			crewMembers: members,
			approvedGuests: [],
			sender: { kind: "member", name: "stranger" },
		});
		assert.deepEqual(unknownMemberSender, { ok: false, code: "unknown-sender" });
	});

	test("reports no-recipients when the sender is the only participant", () => {
		const result = buildGuestBroadcastRecipients({
			crewMembers: [{ name: "lead", role: "lead" }],
			approvedGuests: [],
			sender: { kind: "member", name: "lead" },
		});
		assert.deepEqual(result, { ok: false, code: "no-recipients" });
	});
});
