import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	CrewRetrospectiveFlow,
	type RoundSnapshotInput,
	buildRetrospectiveMemberRequest,
	MAX_PENDING_PROPOSAL_IDS,
} from "./crew-retrospective.ts";

const INTERVAL = { start: "2026-01-01T00:00:00.000Z", end: "2026-01-01T01:00:00.000Z" };
const RETRO = "retro-1";
const ROSTER = ["Dave", "Kelly", "Mary", "Mony"];
const RECORD_HASH = "a".repeat(64);

function snapshot(overrides: Partial<RoundSnapshotInput> = {}): RoundSnapshotInput {
	return {
		recordId: "retro-record.retro-1.2c8c5d8e",
		recordHash: RECORD_HASH,
		currentRevisionId: "rev-1",
		currentContentHash: "b".repeat(64),
		pendingProposalIds: ["prop-1", "prop-2"],
		roster: ROSTER,
		...overrides,
	};
}

function startFlow(facilitator = "Mony", snap = snapshot()): CrewRetrospectiveFlow {
	return CrewRetrospectiveFlow.start({
		retrospectiveId: RETRO,
		interval: INTERVAL,
		facilitator,
		snapshot: snap,
	});
}

describe("facilitator authority", () => {
	it("accepts an exact configured member name", () => {
		const flow = startFlow("Mony");
		assert.equal(flow.round.facilitator, "Mony");
	});

	it("rejects a name not in the roster (no fallback)", () => {
		assert.throws(() => startFlow("Unknown"), /facilitator/i);
	});

	it("rejects empty or role-shaped facilitator", () => {
		assert.throws(() => startFlow(""), /facilitator/i);
		assert.throws(() => startFlow("role:lead"), /facilitator/i);
	});
});

describe("explicit start", () => {
	it("creates one open round with frozen snapshot", () => {
		const flow = startFlow();
		assert.equal(flow.round.phase, "collecting");
		assert.equal(flow.round.snapshot.recordId, "retro-record.retro-1.2c8c5d8e");
		assert.equal(flow.round.snapshot.pendingProposalIds.length, 2);
		assert.deepEqual(flow.round.snapshot.roster, ROSTER);
	});

	it("duplicate identical start is idempotent (same round id, no duplicate)", () => {
		const first = startFlow();
		const second = startFlow();
		assert.equal(first.round.id, second.round.id);
		assert.equal(first.round.contentFingerprint, second.round.contentFingerprint);
	});

	it("different frozen roster while open is a conflict, never a second round", () => {
		const flow = startFlow();
		assert.throws(
			() =>
				CrewRetrospectiveFlow.start({
					retrospectiveId: RETRO,
					interval: INTERVAL,
					facilitator: "Mony",
					snapshot: snapshot({ roster: ["Dave", "Kelly", "Mony"] }),
					alreadyOpen: flow.round,
				}),
			/conflict/i,
		);
	});

	it("different snapshot while open is a conflict, never a second round", () => {
		const flow = startFlow();
		assert.throws(
			() =>
				CrewRetrospectiveFlow.start({
					retrospectiveId: RETRO,
					interval: INTERVAL,
					facilitator: "Mony",
					snapshot: snapshot({ recordHash: "c".repeat(64) }),
					alreadyOpen: flow.round,
				}),
			/conflict/i,
		);
	});

	it("rejects invalid interval and empty roster at start", () => {
		assert.throws(
			() =>
				CrewRetrospectiveFlow.start({
					retrospectiveId: RETRO,
					interval: { start: INTERVAL.end, end: INTERVAL.start },
					facilitator: "Mony",
					snapshot: snapshot(),
				}),
			/interval/i,
		);
		assert.throws(
			() =>
				CrewRetrospectiveFlow.start({
					retrospectiveId: RETRO,
					interval: INTERVAL,
					facilitator: "Mony",
					snapshot: snapshot({ roster: [] }),
				}),
			/roster/i,
		);
	});

	it("bounds pending proposal ids", () => {
		const many = Array.from({ length: MAX_PENDING_PROPOSAL_IDS + 1 }, (_, i) => `prop-${i}`);
		assert.throws(() => startFlow("Mony", snapshot({ pendingProposalIds: many })), /proposal/i);
	});
});

describe("member request content", () => {
	it("every member receives the same record identity and question set", () => {
		const request = buildRetrospectiveMemberRequest("retro-record.retro-1.2c8c5d8e");
		for (const topic of ["evidence correction", "interpretation challenge", "Start/Stop/Continue", "objections"]) {
			assert.ok(request.message.includes(topic), topic);
		}
		assert.ok(request.message.includes("retro-record.retro-1.2c8c5d8e"));
		assert.ok(request.instructions.length > 0);
	});

	it("is identical regardless of member identity (same bytes for all)", () => {
		const a = buildRetrospectiveMemberRequest("retro-record.retro-1.2c8c5d8e");
		const b = buildRetrospectiveMemberRequest("retro-record.retro-1.2c8c5d8e");
		assert.deepEqual(a, b);
	});
});

describe("participation outcomes", () => {
	it("records explicit outcomes per member; none implies consent", () => {
		const flow = startFlow();
		flow.recordOutcome("Dave", "offline");
		flow.recordOutcome("Kelly", "timeout-max-wait");
		flow.recordOutcome("Mary", "late");
		assert.equal(flow.round.memberStates["Dave"], "offline");
		assert.equal(flow.round.memberStates["Kelly"], "timeout-max-wait");
		assert.equal(flow.round.memberStates["Mary"], "late");
	});

	it("response with review material is attributed and appended, never mutating the snapshot", () => {
		const flow = startFlow();
		const before = JSON.stringify(flow.round.snapshot);
		flow.appendCorrection("Dave", "coord.evt-1.response", "wrong commit hash");
		flow.appendChallenge("Mary", "sit-1", "disputed: timing claim unsupported");
		flow.appendObjection("Kelly", "I object to the interpretation label");
		const after = JSON.stringify(flow.round.snapshot);
		assert.equal(before, after);
		assert.equal(flow.round.reviewMaterial.length, 3);
		assert.ok(flow.round.reviewMaterial.every((item) => ROSTER.includes(item.member)));
	});

	it("rejects review material from non-roster members", () => {
		const flow = startFlow();
		assert.throws(() => flow.appendCorrection("Ghost", "coord.evt-1", "note"), /member/i);
	});

	it("missing members become explicit at completion", () => {
		const flow = startFlow();
		flow.recordOutcome("Dave", "response-received");
		const completed = flow.complete();
		assert.equal(completed.memberStates["Dave"], "response-received");
		assert.equal(completed.memberStates["Kelly"], "missing");
		assert.equal(completed.memberStates["Mary"], "missing");
		assert.equal(completed.memberStates["Mony"], "missing");
	});
});

describe("candidate revision synthesis", () => {
	it("facilitator can synthesize one candidate with the exact snapshot base", () => {
		const flow = startFlow();
		flow.synthesizeCandidate({ baseRevisionId: "rev-1", baseRecordHash: RECORD_HASH, operations: [] });
		assert.equal(flow.round.candidate?.status, "candidate");
		assert.equal(flow.round.candidate?.baseRevisionId, "rev-1");
	});

	it("no-op revision is allowed", () => {
		const flow = startFlow();
		flow.synthesizeCandidate({ baseRevisionId: "rev-1", baseRecordHash: RECORD_HASH, operations: [] });
		assert.ok(flow.round.candidate !== undefined);
	});

	it("stale base (changed revision or record) yields stale status, never merges", () => {
		const flow = startFlow();
		flow.synthesizeCandidate({ baseRevisionId: "rev-2", baseRecordHash: RECORD_HASH, operations: [] });
		assert.equal(flow.round.candidate?.status, "stale");
		flow.synthesizeCandidate({ baseRevisionId: "rev-1", baseRecordHash: "f".repeat(64), operations: [] });
		assert.equal(flow.round.candidate?.status, "stale");
	});

	it("candidate is never an activation (status vocabulary excludes activation)", () => {
		const flow = startFlow();
		flow.synthesizeCandidate({ baseRevisionId: "rev-1", baseRecordHash: RECORD_HASH, operations: [] });
		assert.notEqual(flow.round.candidate?.status, "active");
		assert.notEqual(flow.round.candidate?.status, "activated");
	});
});

describe("takeover and completion", () => {
	it("explicit takeover names an exact configured replacement with reason", () => {
		const flow = startFlow();
		flow.takeover("Mary", "facilitator unavailable");
		assert.equal(flow.round.facilitator, "Mary");
		assert.equal(flow.round.facilitatorTakeover?.reason, "facilitator unavailable");
		assert.equal(flow.round.facilitatorTakeover?.from, "Mony");
	});

	it("takeover rejects non-roster replacements (no role inference)", () => {
		const flow = startFlow();
		assert.throws(() => flow.takeover("Ghost", "reason"), /facilitator/i);
	});

	it("completion is deterministic and terminal", () => {
		const flow = startFlow();
		const completed = flow.complete();
		assert.equal(completed.phase, "completed");
		assert.throws(() => flow.complete(), /terminal/i);
	});

	it("resume/replay of the same round state produces the same completion", () => {
		const flow = startFlow();
		flow.recordOutcome("Dave", "response-received");
		const state = flow.serialize();
		const resumed = CrewRetrospectiveFlow.resume(state);
		const a = resumed.complete();
		const b = CrewRetrospectiveFlow.resume(flow.serialize()).complete();
		assert.equal(JSON.stringify(a.memberStates), JSON.stringify(b.memberStates));
		void a;
	});
});

describe("restart persistence shape", () => {
	it("serializes and resumes preserving phase, ids, and member states", () => {
		const flow = startFlow();
		flow.recordOutcome("Dave", "response-received");
		flow.appendObjection("Kelly", "objection text");
		const serialized = flow.serialize();
		const resumed = CrewRetrospectiveFlow.resume(serialized);
		assert.equal(resumed.round.phase, "collecting");
		assert.equal(resumed.round.id, flow.round.id);
		assert.equal(resumed.round.memberStates["Dave"], "response-received");
		assert.equal(resumed.round.reviewMaterial.length, 1);
	});
});

describe("no redirect/interrupt/activation surface", () => {
	it("module source has no redirect/interrupt/activation imports", async () => {
		const fs = await import("node:fs");
		const source = fs.readFileSync("src/domain/crew-retrospective.ts", "utf8");
		assert.ok(!source.includes("interrupt"));
		assert.ok(!source.includes("redirect"));
		assert.ok(!source.includes("activateAgreement"));
	});
});
