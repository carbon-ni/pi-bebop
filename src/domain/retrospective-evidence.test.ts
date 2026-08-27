import { test } from "node:test";
import assert from "node:assert/strict";
import {
	MAX_RETROSPECTIVE_EVIDENCE_TEXT_BYTES,
	RetrospectiveEvidenceConflictError,
	createRetrospectiveEvidence,
	isRetrospectiveEvidence,
	isTimestampInRetrospectiveInterval,
	orderAndDeduplicateRetrospectiveEvidence,
	redactRetrospectiveEvidenceText,
	type RetrospectiveEvidenceFingerprint,
	type RetrospectiveEvidenceInput,
	type RetrospectiveEvidenceSourceKind,
} from "./index.ts";

const deterministicFingerprint: RetrospectiveEvidenceFingerprint = (input) => {
	let value = 0n;
	for (const character of input) value = (value * 131n + BigInt(character.codePointAt(0) ?? 0)) & ((1n << 256n) - 1n);
	return value.toString(16).padStart(64, "0");
};

function capturedInput(id = "evidence-1"): RetrospectiveEvidenceInput {
	return {
		id,
		interval: { start: "2026-08-27T09:00:00.000Z", end: "2026-08-27T10:00:00.000Z" },
		source: {
			kind: "bebop-coordination",
			identity: "member-request:req-1",
			reference: "session:event-1",
		},
		availability: "captured",
		representation: { kind: "summary", text: "Dave handed work to Kelly. password=hunter2" },
		capture: {
			capturedAt: "2026-08-27T10:01:00.000Z",
			collector: "bebop-coordination-v1",
			provenance: "typed-message-details:event-1",
		},
	};
}

test("creates immutable bounded evidence, preserving ordinary Crew-visible text while redacting credentials", () => {
	const evidence = createRetrospectiveEvidence(capturedInput(), deterministicFingerprint);
	assert.equal(evidence.version, 1);
	assert.equal(evidence.kind, "retrospective-evidence");
	assert.equal(evidence.representation?.text, "Dave handed work to Kelly. password=[REDACTED:credential]");
	assert.deepEqual(evidence.redactions, [{ kind: "credential", marker: "[REDACTED:credential]", occurrences: 1 }]);
	assert.equal(evidence.fingerprint.length, 64);
	assert.equal(isRetrospectiveEvidence(evidence), true);
	assert.equal(Object.isFrozen(evidence), true);
	assert.equal(Object.isFrozen(evidence.source), true);
	assert.throws(() => {
		(evidence.source as { identity: string }).identity = "changed";
	});

	const ordinary = redactRetrospectiveEvidenceText(
		"Visible tool result: tests passed; secret handling was reviewed.",
	);
	assert.equal(ordinary.text, "Visible tool result: tests passed; secret handling was reviewed.");
	assert.deepEqual(ordinary.redactions, []);
	const credentials = redactRetrospectiveEvidenceText(
		"Authorization: Bearer abc.def.ghi\napi_key='abc123'\nhttps://alice:password@example.test/path",
	);
	assert.equal(credentials.text.includes("abc.def.ghi"), false);
	assert.equal(credentials.text.includes("abc123"), false);
	assert.equal(credentials.text.includes("alice:password"), false);
	assert.ok(credentials.redactions.reduce((sum, item) => sum + item.occurrences, 0) >= 3);
	const provenanceProtected = createRetrospectiveEvidence(
		{
			...capturedInput("protected-provenance"),
			source: {
				kind: "repository-artifact",
				identity: "commit:abc",
				reference: "https://alice:password@example.test/commit/abc",
			},
			capture: {
				capturedAt: "2026-08-27T10:01:00.000Z",
				collector: "repository-v1",
				provenance: "api_key=collector-secret",
			},
		},
		deterministicFingerprint,
	);
	assert.equal(JSON.stringify(provenanceProtected).includes("alice:password"), false);
	assert.equal(JSON.stringify(provenanceProtected).includes("hunter2"), false);
	assert.equal(JSON.stringify(provenanceProtected).includes("collector-secret"), false);
	assert.ok(provenanceProtected.redactions[0].occurrences >= 3);
});

test("supports the bounded visible source kinds without granting activation authority", () => {
	const kinds: readonly RetrospectiveEvidenceSourceKind[] = [
		"bebop-coordination",
		"repository-artifact",
		"member-retrospective-report",
		"member-observation",
	];
	for (const [index, kind] of kinds.entries()) {
		const evidence = createRetrospectiveEvidence(
			{ ...capturedInput(`source-${index}`), source: { kind, identity: `${kind}:1`, reference: `${kind}:ref` } },
			deterministicFingerprint,
		);
		assert.equal(isRetrospectiveEvidence(evidence), true);
		assert.equal(isRetrospectiveEvidence({ ...evidence, authority: "activate" }), false);
	}
	assert.equal(
		isRetrospectiveEvidence({
			...createRetrospectiveEvidence(capturedInput("hidden"), deterministicFingerprint),
			source: { kind: "hidden-model-reasoning", identity: "private", reference: "thoughts" },
		}),
		false,
	);
});

test("uses exact half-open intervals and rejects reversed or non-canonical UTC timestamps", () => {
	const interval = { start: "2026-08-27T09:00:00.000Z", end: "2026-08-27T10:00:00.000Z" };
	assert.equal(isTimestampInRetrospectiveInterval(interval.start, interval), true);
	assert.equal(isTimestampInRetrospectiveInterval("2026-08-27T09:59:59.999Z", interval), true);
	assert.equal(isTimestampInRetrospectiveInterval(interval.end, interval), false);
	assert.equal(isTimestampInRetrospectiveInterval("2026-08-27T08:59:59.999Z", interval), false);
	assert.throws(() =>
		createRetrospectiveEvidence(
			{ ...capturedInput("reversed"), interval: { start: interval.end, end: interval.start } },
			deterministicFingerprint,
		),
	);
	assert.throws(() =>
		createRetrospectiveEvidence(
			{ ...capturedInput("offset"), interval: { start: "2026-08-27T11:00:00+02:00", end: interval.end } },
			deterministicFingerprint,
		),
	);
});

test("deduplicates canonical shared events across collectors and orders identical inputs stably", () => {
	const first = createRetrospectiveEvidence(capturedInput("z-collector"), deterministicFingerprint);
	const second = createRetrospectiveEvidence(
		{
			...capturedInput("a-collector"),
			capture: {
				capturedAt: "2026-08-27T10:02:00.000Z",
				collector: "repository-cross-reference-v1",
				provenance: "repository:commit-1",
			},
		},
		deterministicFingerprint,
	);
	assert.equal(first.fingerprint, second.fingerprint);
	assert.deepEqual(
		orderAndDeduplicateRetrospectiveEvidence([first, second]).map(({ id }) => id),
		["a-collector"],
	);
	assert.deepEqual(
		orderAndDeduplicateRetrospectiveEvidence([second, first]).map(({ id }) => id),
		["a-collector"],
	);
});

test("fails explicitly for fingerprint collisions and conflicting stable ID reuse", () => {
	const collision: RetrospectiveEvidenceFingerprint = () => "0".repeat(64);
	const first = createRetrospectiveEvidence(capturedInput("collision-a"), collision);
	const different = createRetrospectiveEvidence(
		{
			...capturedInput("collision-b"),
			source: { kind: "repository-artifact", identity: "commit:abc", reference: "git:abc" },
		},
		collision,
	);
	assert.throws(
		() => orderAndDeduplicateRetrospectiveEvidence([first, different]),
		(error: unknown) =>
			error instanceof RetrospectiveEvidenceConflictError && error.code === "fingerprint-conflict",
	);
	const reusedId = createRetrospectiveEvidence(
		{ ...capturedInput(first.id), representation: { kind: "summary", text: "different event" } },
		deterministicFingerprint,
	);
	assert.throws(
		() => orderAndDeduplicateRetrospectiveEvidence([first, reusedId]),
		(error: unknown) => error instanceof RetrospectiveEvidenceConflictError && error.code === "id-conflict",
	);
});

test("requires explicit unavailable/unsupported gaps and fails closed for malformed, NUL, unknown, and oversized input", () => {
	const unavailable = createRetrospectiveEvidence(
		{
			...capturedInput("unavailable"),
			availability: "unavailable",
			representation: undefined,
			gap: { reason: "Member request timed out; token=private-value" },
		},
		deterministicFingerprint,
	);
	assert.equal(unavailable.gap?.reason, "Member request timed out; token=[REDACTED:credential]");
	assert.equal(unavailable.representation, undefined);
	const unsupported = createRetrospectiveEvidence(
		{
			...capturedInput("unsupported"),
			availability: "unsupported",
			representation: undefined,
			gap: { reason: "Collector version does not support this artifact." },
		},
		deterministicFingerprint,
	);
	assert.equal(isRetrospectiveEvidence(unsupported), true);
	assert.throws(() =>
		createRetrospectiveEvidence(
			{ ...capturedInput("missing-content"), representation: undefined },
			deterministicFingerprint,
		),
	);
	assert.throws(() =>
		createRetrospectiveEvidence(
			{ ...capturedInput("gap-with-content"), availability: "unavailable", gap: { reason: "offline" } },
			deterministicFingerprint,
		),
	);
	assert.throws(() =>
		createRetrospectiveEvidence(
			{ ...capturedInput("nul"), capture: { ...capturedInput().capture, provenance: "bad\0value" } },
			deterministicFingerprint,
		),
	);
	assert.throws(() =>
		createRetrospectiveEvidence(
			{
				...capturedInput("oversized"),
				representation: { kind: "content", text: "x".repeat(MAX_RETROSPECTIVE_EVIDENCE_TEXT_BYTES + 1) },
			},
			deterministicFingerprint,
		),
	);
	const valid = createRetrospectiveEvidence(capturedInput("unknown"), deterministicFingerprint);
	assert.equal(isRetrospectiveEvidence({ ...valid, interpretation: "the Crew should activate this" }), false);
});
