import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseCrewManifest, type CrewManifest } from "./crew-manifest.ts";
import {
	CrewIntakeError,
	createExternalIntakePayload,
	isExternalIntakeAck,
	resolveIntakeContact,
} from "./crew-intake.ts";

const members = [
	{ name: "Mary", role: "po", socket: "sockets/po.sock" },
	{ name: "Tony", role: "lead", socket: "sockets/lead.sock" },
	{ name: "Bob", role: "dev", socket: "sockets/dev.sock" },
];

const manifestWith = (intake?: unknown): CrewManifest =>
	parseCrewManifest(
		intake === undefined ? { version: 1, members } : { version: 1, members, intake },
		"/project/.pi/bebop/crew.json",
	);

describe("resolveIntakeContact", () => {
	test("resolves the exact configured member by name when enabled", () => {
		const resolution = resolveIntakeContact(manifestWith({ contact: "Mary" }));
		assert.equal(resolution.enabled, true);
		if (resolution.enabled) {
			assert.equal(resolution.contact.name, "Mary");
			assert.equal(resolution.contact.role, "po");
			assert.equal(resolution.contact.socketPath, "/project/.pi/bebop/sockets/po.sock");
		}
	});

	test("no contact yields explicit external-intake-disabled with no fallback", () => {
		const resolution = resolveIntakeContact(manifestWith());
		assert.deepEqual(resolution, { enabled: false, reason: "external-intake-disabled" });
	});

	test("disabled even when a lead/po/first member exists: no implicit fallback", () => {
		// Mary(po)/Tony(lead) exist, but without a configured contact intake stays disabled.
		const resolution = resolveIntakeContact(manifestWith());
		assert.equal(resolution.enabled, false);
	});

	test("unknown contact on a manifest is a defensive contract violation", () => {
		const malformed = parseCrewManifest({ version: 1, members }, "/project/.pi/bebop/crew.json");
		(malformed as { intake?: { contact: string } }).intake = { contact: "Ghost" };
		assert.throws(
			() => resolveIntakeContact(malformed),
			(error: unknown) => error instanceof CrewIntakeError && error.code === "unknown-contact",
		);
	});

	test("contact identity and inbox location come only from the validated manifest", () => {
		const resolution = resolveIntakeContact(manifestWith({ contact: "Bob" }));
		assert.equal(resolution.enabled, true);
		if (resolution.enabled) {
			assert.equal(resolution.contact.socketPath, "/project/.pi/bebop/sockets/dev.sock");
			assert.equal(resolution.contact.name, "Bob");
		}
	});
});

describe("createExternalIntakePayload", () => {
	test("builds a one-way message with claimed, unverified external origin", () => {
		const payload = createExternalIntakePayload({
			label: "ci-job-42",
			content: "Please review the plan",
			instructions: ["Triage", "Forward"],
		});
		assert.deepEqual(payload.origin, { kind: "external", label: "ci-job-42" });
		assert.equal(payload.content, "Please review the plan");
		assert.deepEqual(payload.instructions, ["Triage", "Forward"]);
		// One-way: no reply route and no response contract on the payload.
		assert.equal(payload.replyTo, undefined);
		assert.ok(!JSON.stringify(payload).includes("replyTo"));
	});

	test("rejects blank, NUL, or oversized content and labels", () => {
		for (const bad of [
			{ label: "", content: "x" },
			{ label: "x", content: "   " },
			{ label: "x", content: "nul\0byte" },
			{ label: "x", content: "x", instructions: [""] },
			{ label: "x", content: "x", instructions: Array(33).fill("i") },
		]) {
			assert.throws(
				() => createExternalIntakePayload(bad as never),
				(error: unknown) => error instanceof CrewIntakeError && error.code === "invalid-payload",
			);
		}
	});
});

describe("ExternalIntakeAck contract", () => {
	test("one-way persisted acknowledgement has no reply route or promised response", () => {
		const ack = {
			ok: true,
			itemId: "inbox-0-abc",
			persisted: true,
			contact: "Mary",
			contactRole: "po",
		};
		assert.equal(isExternalIntakeAck(ack), true);
		assert.ok(!JSON.stringify(ack).includes("reply"));
		assert.ok(!JSON.stringify(ack).includes("sessionId"));
	});

	test("rejects acknowledgements that carry reply routing or drop persistence", () => {
		assert.equal(
			isExternalIntakeAck({
				ok: true,
				itemId: "i",
				persisted: true,
				contact: "Mary",
				contactRole: "po",
				replyTo: {},
			}),
			false,
		);
		assert.equal(isExternalIntakeAck({ ok: true, itemId: "i", persisted: false, contact: "Mary" }), false);
		assert.equal(isExternalIntakeAck({ ok: true, itemId: "i", contact: "Mary", contactRole: "po" }), false);
		assert.equal(isExternalIntakeAck({ ok: true, itemId: "i", persisted: true, contact: "Mary" }), false);
		assert.equal(isExternalIntakeAck(null), false);
	});
});
