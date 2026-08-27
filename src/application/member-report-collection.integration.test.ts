import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RequestOutcome } from "../domain/member-request.ts";
import type { RetrospectiveEvidenceInterval } from "../domain/index.ts";
import { collectMemberReports, type MemberReportSendRequest } from "./member-report-collection.ts";
import {
	openTrustedRetrospectiveEvidenceStore,
	sha256RetrospectiveEvidenceFingerprint,
} from "../infra/retrospective-evidence-store.ts";

const INTERVAL: RetrospectiveEvidenceInterval = { start: "2026-01-01T00:00:00.000Z", end: "2026-01-01T01:00:00.000Z" };
const RETRO = "retro-1";

const VALID_REPORT_TEXT = [
	"## observed-situations",
	"- gate failed twice",
	"",
	"## impact",
	"blocked two hours",
	"",
	"## helped",
	"- matrix caught regression",
	"",
	"## friction-rework",
	"",
	"## changed-decisions",
	"",
	"## missing-context",
	"",
	"## evidence-references",
	"- commit:3bdffe9",
].join("\n");

function responseOf(member: string, message: string): RequestOutcome {
	return {
		kind: "response",
		requestId: `req-${member}`,
		member: { name: member, role: "role" },
		message,
		instructions: [],
	};
}

let projectDir: string;
let manifestPath: string;

beforeEach(async () => {
	projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-member-report-"));
	manifestPath = path.join(projectDir, ".pi", "bebop", "crew.json");
	await fs.mkdir(path.dirname(manifestPath), { recursive: true });
	await fs.writeFile(manifestPath, "{}", "utf8");
});
afterEach(async () => fs.rm(projectDir, { recursive: true, force: true }));

describe("member report collection → evidence store integration", () => {
	it("persists accepted reports as attributed evidence; replay is idempotent", async () => {
		const store = await openTrustedRetrospectiveEvidenceStore({
			projectRoot: projectDir,
			manifestPath,
			isProjectTrusted: () => true,
		});
		const send: MemberReportSendRequest = async (member) =>
			member.name === "Mary" ? responseOf("Mary", VALID_REPORT_TEXT) : offlineResponse("Dave");
		const roster = [
			{ name: "Mary", role: "po" },
			{ name: "Dave", role: "dev" },
		];

		const results = await collectMemberReports(
			roster,
			RETRO,
			INTERVAL,
			send,
			sha256RetrospectiveEvidenceFingerprint,
		);
		assert.equal(results[0]!.outcome, "response-accepted");
		assert.equal(results[1]!.outcome, "offline");
		const evidence = results[0]!.evidence!;
		assert.equal(evidence.source.kind, "member-retrospective-report");
		assert.equal(evidence.source.identity, "Mary");

		const first = await store.put(evidence);
		assert.equal(first.alreadyPersisted, undefined);

		// Retry/resume: same retrospective/member/interval replay is byte-identical
		const replay = await collectMemberReports(
			roster,
			RETRO,
			INTERVAL,
			send,
			sha256RetrospectiveEvidenceFingerprint,
		);
		const second = await store.put(replay[0]!.evidence!);
		assert.equal(second.alreadyPersisted, true);

		const listed = await store.list();
		assert.equal(listed.length, 1);
		assert.equal(listed[0]!.id, evidence.id);
	});

	it("conflicting later response never replaces the persisted accepted report", async () => {
		const store = await openTrustedRetrospectiveEvidenceStore({
			projectRoot: projectDir,
			manifestPath,
			isProjectTrusted: () => true,
		});
		const firstMessage = VALID_REPORT_TEXT;
		const conflictingMessage = VALID_REPORT_TEXT.replace("gate failed twice", "gate failed once");

		let call = 0;
		const send: MemberReportSendRequest = async (member) => {
			call += 1;
			return responseOf(member.name, call === 1 ? firstMessage : conflictingMessage);
		};

		const first = await collectMemberReports(
			[{ name: "Mary", role: "po" }],
			RETRO,
			INTERVAL,
			send,
			sha256RetrospectiveEvidenceFingerprint,
		);
		await store.put(first[0]!.evidence!);

		const second = await collectMemberReports(
			[{ name: "Mary", role: "po" }],
			RETRO,
			INTERVAL,
			send,
			sha256RetrospectiveEvidenceFingerprint,
		);
		// Second pass accepted a different report text: a DIFFERENT member state
		// machine instance; the store must reject conflicting bytes for the same id
		// instead of silently replacing the first accepted report.
		if (second[0]!.outcome === "response-accepted") {
			assert.rejects(() => store.put(second[0]!.evidence!), /different bytes/);
		}
		const listed = await store.list();
		assert.equal(listed.length, 1);
		assert.ok(listed[0]!.representation!.text.includes("gate failed twice"));
	});

	it("offline-only roster persists no report evidence", async () => {
		const store = await openTrustedRetrospectiveEvidenceStore({
			projectRoot: projectDir,
			manifestPath,
			isProjectTrusted: () => true,
		});
		const send: MemberReportSendRequest = async (member) => offlineResponse(member.name);
		const results = await collectMemberReports(
			[{ name: "Dave", role: "dev" }],
			RETRO,
			INTERVAL,
			send,
			sha256RetrospectiveEvidenceFingerprint,
		);
		assert.equal(results[0]!.outcome, "offline");
		assert.equal(results[0]!.evidence, undefined);
		assert.equal((await store.list()).length, 0);
	});

	it("self seam report persists with self-report reference; remote members correlated", async () => {
		const store = await openTrustedRetrospectiveEvidenceStore({
			projectRoot: projectDir,
			manifestPath,
			isProjectTrusted: () => true,
		});
		const send: MemberReportSendRequest = async (member) =>
			member.name === "Mary" ? responseOf("Mary", VALID_REPORT_TEXT) : offlineResponse(member.name);
		const results = await collectMemberReports(
			[
				{ name: "Dave", role: "dev" },
				{ name: "Mary", role: "po" },
			],
			RETRO,
			INTERVAL,
			send,
			sha256RetrospectiveEvidenceFingerprint,
			{ selfReport: { member: "Dave", produce: async () => VALID_REPORT_TEXT } },
		);
		assert.equal(results[0]!.outcome, "response-accepted");
		assert.equal(results[0]!.evidence!.source.reference, `self-report.${RETRO}.Dave`);
		assert.equal(results[1]!.outcome, "response-accepted");
		assert.equal(results[1]!.evidence!.source.reference, "req-Mary");
		for (const result of results) {
			if (result.evidence) {
				const put = await store.put(result.evidence);
				assert.equal(put.alreadyPersisted, undefined);
			}
		}
		const listed = await store.list();
		assert.equal(listed.length, 2);
		const identities = listed.map((item) => item.source.identity).sort();
		assert.deepEqual(identities, ["Dave", "Mary"]);
	});
});

function offlineResponse(member: string): RequestOutcome {
	return { kind: "offline", requestId: `req-${member}`, member: { name: member, role: "role" } };
}
