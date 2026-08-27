import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RequestOutcome } from "../domain/member-request.ts";
import { CrewRetrospectiveFlow, type CrewRetrospectiveRoundState } from "../domain/crew-retrospective.ts";
import {
	collectRetrospectiveReviews,
	openRetrospectiveRound,
	type RetrospectiveRoundDependencies,
	type RetrospectiveRoundOpenInput,
} from "./crew-retrospective-round-flow.ts";

const INTERVAL = { start: "2026-01-01T00:00:00.000Z", end: "2026-01-01T01:00:00.000Z" };
const RETRO = "retro-1";
const ROSTER = ["Dave", "Kelly", "Mary", "Mony"];
const RECORD_HASH = "a".repeat(64);

type DepsOverrides = Partial<RetrospectiveRoundDependencies>;

function deps(overrides: DepsOverrides = {}): RetrospectiveRoundDependencies & { sentTo: string[] } {
	const sentTo: string[] = [];
	const base: RetrospectiveRoundDependencies = {
		readRecord: async () => ({ id: "retro-record.retro-1.2c8c5d8e", contentHash: RECORD_HASH }),
		readCurrentAgreementState: async () => ({ currentRevisionId: "rev-1", currentContentHash: "b".repeat(64) }),
		listPendingProposalIds: async () => ["prop-1"],
		loadOpenRound: async () => undefined,
		persistRound: async () => undefined,
		sendRequest: async (member) => {
			sentTo.push(member.name);
			return { kind: "offline", requestId: `req-${member.name}`, member } as RequestOutcome;
		},
		...overrides,
	};
	return Object.assign(base, { sentTo });
}

function openInput(): RetrospectiveRoundOpenInput {
	return {
		retrospectiveId: RETRO,
		recordId: "retro-record.retro-1.2c8c5d8e",
		interval: INTERVAL,
		facilitator: "Mony",
		manifestRoster: ROSTER,
	};
}

describe("openRetrospectiveRound — integrity pre-check", () => {
	it("fails zero-write when the record is missing/corrupt (unreadable)", async () => {
		const d = deps({
			readRecord: async () => {
				throw new Error("record not found");
			},
		});
		await assert.rejects(() => openRetrospectiveRound(openInput(), d), /record/i);
		assert.equal(d.sentTo.length, 0, "no requests sent on integrity failure");
	});

	it("rejects a facilitator argument that disagrees with trusted Membership", async () => {
		const d = deps({ configuredFacilitator: "Mony", currentMemberName: async () => "Dave" });
		await assert.rejects(() => openRetrospectiveRound(openInput(), d), /facilitator|Membership/i);
		assert.equal(d.sentTo.length, 0);
	});

	it("fails zero-write when the record identity is malformed (corrupt)", async () => {
		const d = deps({
			readRecord: async () => ({ id: "", contentHash: RECORD_HASH }),
		});
		await assert.rejects(() => openRetrospectiveRound(openInput(), d), /record/i);
		assert.equal(d.sentTo.length, 0);
	});

	it("fails zero-write when the current agreement revision is missing", async () => {
		const d = deps({
			readCurrentAgreementState: async () => {
				throw new Error("activation state unreadable");
			},
		});
		await assert.rejects(() => openRetrospectiveRound(openInput(), d), /agreement/i);
		assert.equal(d.sentTo.length, 0);
	});
});

describe("openRetrospectiveRound — snapshot and start", () => {
	it("starts one open round snapshotting record, revision, proposals, roster", async () => {
		const d = deps();
		const { round } = await openRetrospectiveRound(openInput(), d);
		assert.equal(round.phase, "collecting");
		assert.equal(round.snapshot.recordHash, RECORD_HASH);
		assert.equal(round.snapshot.currentRevisionId, "rev-1");
		assert.deepEqual(round.snapshot.pendingProposalIds, ["prop-1"]);
		assert.deepEqual(round.snapshot.roster, ROSTER);
		assert.equal(d.sentTo.length, 0, "start alone sends no requests");
	});

	it("duplicate start with same inputs returns the existing round idempotently", async () => {
		let persisted: CrewRetrospectiveRoundState | undefined;
		const d = deps({ persistRound: async (state) => (persisted = state) });
		const first = await openRetrospectiveRound(openInput(), d);
		const d2 = deps({ loadOpenRound: async () => persisted });
		const second = await openRetrospectiveRound(openInput(), d2);
		assert.equal(second.round.id, first.round.id);
		assert.equal(second.round.contentFingerprint, first.round.contentFingerprint);
	});

	it("concurrent different-snapshot start is an explicit conflict, no duplicate round", async () => {
		let persisted: CrewRetrospectiveRoundState | undefined;
		const d = deps({ persistRound: async (state) => (persisted = state) });
		await openRetrospectiveRound(openInput(), d);
		const d2 = deps({
			loadOpenRound: async () => persisted,
			readRecord: async () => ({ id: "retro-record.retro-1.2c8c5d8e", contentHash: "c".repeat(64) }),
		});
		await assert.rejects(() => openRetrospectiveRound(openInput(), d2), /conflict/i);
	});
});

describe("member request collection", () => {
	it("sends exactly one identical request per non-local frozen member", async () => {
		const requests: Array<{ member: string; requestId: string; message: string }> = [];
		const d = deps({
			sendRequest: async (member, request) => {
				requests.push({ member: member.name, requestId: request.requestId, message: request.message });
				return { kind: "offline", requestId: request.requestId, member };
			},
		});
		const { flow } = await openRetrospectiveRound(openInput(), d);
		await collectRetrospectiveReviews(
			flow,
			ROSTER.map((name) => ({ name, role: "member" })),
			d,
		);
		assert.deepEqual(
			requests.map(({ member }) => member),
			["Dave", "Kelly", "Mary"],
		);
		assert.equal(new Set(requests.map(({ requestId }) => requestId)).size, 3);
		assert.equal(new Set(requests.map(({ message }) => message)).size, 1);
	});

	it("uses a local facilitator seam instead of sending a self-request", async () => {
		const local: string[] = [];
		const d = deps({
			localReview: async (member, request) => {
				local.push(member.name);
				return {
					kind: "response",
					requestId: request.requestId,
					member,
					message: "local review",
					instructions: [],
				};
			},
		});
		const { flow } = await openRetrospectiveRound(openInput(), d);
		await collectRetrospectiveReviews(
			flow,
			ROSTER.map((name) => ({ name, role: "member" })),
			d,
		);
		assert.deepEqual(local, ["Mony"]);
		assert.deepEqual(d.sentTo, ["Dave", "Kelly", "Mary"]);
		assert.equal(flow.round.memberStates.Mony, "response-received");
	});

	it("collectResponses records explicit outcomes; offline never implies consent", async () => {
		const d = deps();
		const { flow } = await openRetrospectiveRound(openInput(), d);
		const result = flow.recordOutcome("Dave", "offline");
		void result;
		assert.equal(flow.round.memberStates["Dave"], "offline");
	});
});

describe("no redirect/interrupt/candidate-activation surface", () => {
	it("application module has no redirect/interrupt/activation imports", async () => {
		const fs = await import("node:fs");
		const source = fs.readFileSync("src/application/crew-retrospective-round-flow.ts", "utf8");
		assert.ok(!source.includes("interrupt"));
		assert.ok(!source.includes("redirect"));
		assert.ok(!source.includes("activateAgreement"));
	});
});
