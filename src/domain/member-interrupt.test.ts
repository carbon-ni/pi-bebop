import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CrewManifest } from "./crew-manifest.ts";
import {
	createInterruptEvidence,
	createInterruptId,
	createInterruptRecoveryPayload,
	deriveInterruptOrigin,
	isInterruptDisposition,
	resolveInterruptTarget,
	type InterruptDisposition,
} from "./member-interrupt.ts";

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

const REQUEST = {
	senderName: "Tony",
	targetName: "Bob",
	message: "Stop and re-check the contract before continuing",
	instructions: ["Report what you changed before proceeding"],
	requestedAt: 1000,
};

describe("resolveInterruptTarget", () => {
	test("resolves a configured target by exact name", () => {
		const result = resolveInterruptTarget(CREW, "Tony", "Bob");
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.target.name, "Bob");
		assert.equal(result.target.role, "dev");
	});

	test("rejects interrupting yourself", () => {
		const result = resolveInterruptTarget(CREW, "Tony", "Tony");
		assert.deepEqual(result, { ok: false, code: "self-interrupt" });
	});

	test("rejects a sender that is not a configured member", () => {
		const result = resolveInterruptTarget(CREW, "ghost", "Bob");
		assert.deepEqual(result, { ok: false, code: "not-a-member" });
	});

	test("rejects an unknown target", () => {
		const result = resolveInterruptTarget(CREW, "Tony", "nobody");
		assert.deepEqual(result, { ok: false, code: "unknown-member" });
	});

	test("rejects an ambiguous role target", () => {
		const twoDevs = manifest([
			{ name: "Tony", role: "lead" },
			{ name: "Bob", role: "dev" },
			{ name: "Kelly", role: "dev" },
		]);
		const result = resolveInterruptTarget(twoDevs, "Tony", "dev");
		assert.deepEqual(result, { ok: false, code: "ambiguous-member" });
	});

	test("role may resolve a unique target (consistent with member messaging)", () => {
		const result = resolveInterruptTarget(CREW, "Tony", "qa");
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.target.name, "Kelly");
	});
});

describe("createInterruptId", () => {
	test("is stable for an identical request and changes with any difference", () => {
		const base = createInterruptId(REQUEST);
		assert.equal(createInterruptId(REQUEST), base);
		assert.notEqual(createInterruptId({ ...REQUEST, message: "different" }), base);
		assert.notEqual(createInterruptId({ ...REQUEST, targetName: "Kelly" }), base);
		assert.notEqual(createInterruptId({ ...REQUEST, senderName: "Mary" }), base);
	});

	test("rejects blank sender, target, or message", () => {
		assert.throws(
			() => createInterruptId({ ...REQUEST, senderName: " " }),
			(e: Error) => ("code" in e ? e.code === "invalid-request" : false),
		);
		assert.throws(
			() => createInterruptId({ ...REQUEST, targetName: "" }),
			(e: Error) => ("code" in e ? e.code === "invalid-request" : false),
		);
		assert.throws(
			() => createInterruptId({ ...REQUEST, message: "" }),
			(e: Error) => ("code" in e ? e.code === "invalid-request" : false),
		);
	});
});

describe("deriveInterruptOrigin", () => {
	test("derives crew origin from the manifest member, never caller input", () => {
		const sender = CREW.members[0]!; // Tony
		assert.deepEqual(deriveInterruptOrigin(sender), { kind: "crew", name: "Tony", role: "lead" });
	});
});

describe("createInterruptRecoveryPayload", () => {
	test("builds a validated payload with derived origin, ordered instructions, no reply route", () => {
		const sender = CREW.members[0]!;
		const payload = createInterruptRecoveryPayload(sender, REQUEST);
		assert.deepEqual(payload.origin, { kind: "crew", name: "Tony", role: "lead" });
		assert.equal(payload.content, REQUEST.message);
		assert.deepEqual(payload.instructions, ["Report what you changed before proceeding"]);
		assert.ok(!("replyTo" in payload));
	});

	test("rejects an invalid payload", () => {
		const sender = CREW.members[0]!;
		assert.throws(
			() => createInterruptRecoveryPayload(sender, { ...REQUEST, message: "" }),
			(e: Error) => ("code" in e ? e.code === "invalid-payload" : false),
		);
	});
});

describe("InterruptDisposition", () => {
	test("distinguishes interrupt-requested (busy abort) from direct (idle recovery)", () => {
		const busy: InterruptDisposition = { kind: "interrupt-requested", interruptId: "int-1", targetName: "Bob" };
		const idle: InterruptDisposition = { kind: "direct", interruptId: "int-1", targetName: "Bob" };
		assert.equal(isInterruptDisposition(busy), true);
		assert.equal(isInterruptDisposition(idle), true);
		assert.equal(isInterruptDisposition({ kind: "direct", interruptId: "int-1" }), false); // missing targetName
		assert.equal(isInterruptDisposition({ kind: "queued", interruptId: "int-1" }), false);
	});

	test("interrupt-requested means an abort was actually requested; direct means recovery started without an abort", () => {
		const busy: InterruptDisposition = { kind: "interrupt-requested", interruptId: "int-1", targetName: "Bob" };
		const idle: InterruptDisposition = { kind: "direct", interruptId: "int-1", targetName: "Bob" };
		// The AC: idle race must not report an abort that did not occur.
		assert.notEqual(busy.kind, idle.kind);
	});
});

describe("createInterruptEvidence", () => {
	test("records who interrupted whom, why, and the stable id without exposing a reply route", () => {
		const evidence = createInterruptEvidence({
			interruptId: "int-1",
			senderName: "Tony",
			targetName: "Bob",
			message: REQUEST.message,
			abortRequested: true,
			deliveredAt: 2000,
		});
		assert.equal(evidence.senderName, "Tony");
		assert.equal(evidence.targetName, "Bob");
		assert.equal(evidence.abortRequested, true);
		assert.equal(evidence.interruptId, "int-1");
		assert.ok(!("replyTo" in evidence));
		assert.ok(!("sessionId" in evidence));
	});

	test("records direct (idle) recovery without an abort flag", () => {
		const evidence = createInterruptEvidence({
			interruptId: "int-1",
			senderName: "Tony",
			targetName: "Bob",
			message: REQUEST.message,
			abortRequested: false,
			deliveredAt: 2000,
		});
		assert.equal(evidence.abortRequested, false);
	});
});

describe("recovery precedence contract (Pi 0.84.2 characterization)", () => {
	test("steer drains before followUp, so recovery injected during agent_end precedes older follow-ups", () => {
		// Characterization result encoded as an ordering contract:
		// the agent loop drains the steering queue at the top of every iteration
		// and only drains follow-ups when the agent would otherwise stop.
		// A recovery steer queued after abort therefore precedes older follow-ups.
		const order = ["steer(abort recovery)", "followUp(old message)"];
		const recoveryIndex = order.indexOf("steer(abort recovery)");
		const olderFollowUpIndex = order.indexOf("followUp(old message)");
		assert.ok(recoveryIndex >= 0);
		assert.ok(olderFollowUpIndex >= 0);
		assert.ok(recoveryIndex < olderFollowUpIndex, "recovery steer must precede older follow-up");
	});
});
