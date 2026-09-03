import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CrewManifest } from "./crew-manifest.ts";
import {
	buildBroadcastRecipients,
	createBroadcastPayload,
	deriveBroadcastOrigin,
	summarizeBroadcastDispositions,
	validateBroadcastInput,
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

describe("Crew Broadcast domain", () => {
	test("validates message and ordered instructions without accepting persistence fields", () => {
		assert.doesNotThrow(() =>
			validateBroadcastInput({ senderName: "Bob", content: "hello", instructions: ["one"] }),
		);
		assert.throws(() => validateBroadcastInput({ senderName: "Bob", content: " " }), /non-empty message/);
		assert.throws(
			() => validateBroadcastInput({ senderName: "Bob", content: "hello", instructions: [""] }),
			/instructions/,
		);
	});

	test("derives origin from the configured sender", () => {
		assert.deepEqual(deriveBroadcastOrigin(CREW.members[2]!), { kind: "crew", name: "Bob", role: "dev" });
		const payload = createBroadcastPayload(CREW.members[2]!, { content: "hello", instructions: ["one"] });
		assert.equal(payload.kind, "broadcast");
		assert.deepEqual(payload.instructions, ["one"]);
		assert.ok(!("replyTo" in payload));
	});

	test("builds manifest-order recipients excluding only the canonical sender", () => {
		const result = buildBroadcastRecipients(CREW, "Bob");
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(
			result.recipients.map((recipient) => recipient.member.name),
			["Tony", "Mary", "Kelly"],
		);
		assert.ok(result.recipients.every((recipient) => !("itemId" in recipient)));
	});

	test("unknown sender and single-member crew stop before recipient work", () => {
		assert.deepEqual(buildBroadcastRecipients(CREW, "ghost"), { ok: false, code: "unknown-sender" });
		assert.deepEqual(buildBroadcastRecipients(manifest([{ name: "Bob", role: "dev" }]), "Bob"), {
			ok: false,
			code: "no-recipients",
		});
	});

	test("summarizes delivered and failed live dispositions", () => {
		const dispositions: readonly BroadcastDisposition[] = [
			{ recipientName: "Tony", recipientRole: "lead", deliveryId: "d-1", disposition: "delivered" },
			{ recipientName: "Mary", recipientRole: "po", disposition: "failed", code: "offline" },
		];
		assert.deepEqual(summarizeBroadcastDispositions(dispositions), { delivered: 1, failed: 1, total: 2 });
		assert.deepEqual(summarizeBroadcastDispositions([]), { delivered: 0, failed: 0, total: 0 });
	});
});
