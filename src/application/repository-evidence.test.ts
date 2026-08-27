import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalRetrospectiveEvidenceJson, type RetrospectiveEvidenceInterval } from "../domain/index.ts";
import { sha256RetrospectiveEvidenceFingerprint } from "../infra/retrospective-evidence-store.ts";
import {
	MAX_REPOSITORY_EVIDENCE_CONTENT_BYTES,
	MAX_REPOSITORY_EVIDENCE_ITEMS,
	RepositoryEvidenceAdapterError,
	collectRepositoryEvidence,
	type RepositoryEvidenceAdapter,
	type RepositoryEvidenceArtifact,
	type RepositoryEvidenceSource,
} from "./repository-evidence.ts";

const interval: RetrospectiveEvidenceInterval = {
	start: "2026-08-27T09:00:00.000Z",
	end: "2026-08-27T10:00:00.000Z",
};
const capturedAt = "2026-08-27T10:01:00.000Z";

function artifact(
	source: RepositoryEvidenceSource,
	id: string,
	overrides: Partial<RepositoryEvidenceArtifact> = {},
): RepositoryEvidenceArtifact {
	return {
		source,
		id,
		occurredAt: "2026-08-27T09:30:00.000Z",
		reference: `${source}:${id}`,
		relativePath: source === "git-commits" ? undefined : `plans/${id}.md`,
		summary: `${source} retained ${id}`,
		provenance: `snapshot:${source}:${id}`,
		...overrides,
	};
}
function adapter(
	source: RepositoryEvidenceSource,
	items: readonly RepositoryEvidenceArtifact[] = [],
): RepositoryEvidenceAdapter {
	return {
		source,
		capture: async () => ({
			status: "available",
			items,
			provenance: `adapter:${source}:v1`,
		}),
	};
}
function collect(options: {
	adapters?: readonly RepositoryEvidenceAdapter[];
	state?: Parameters<typeof collectRepositoryEvidence>[0]["state"];
	maxItems?: number;
}) {
	return collectRepositoryEvidence({
		repositoryId: "pi-bebop",
		interval,
		capturedAt,
		fingerprint: sha256RetrospectiveEvidenceFingerprint,
		adapters: options.adapters ?? [],
		state: options.state,
		maxItems: options.maxItems,
	});
}

test("collects the documented v1 source set with exact interval, identifiers, relative paths, and provenance", async () => {
	const sources: readonly RepositoryEvidenceSource[] = [
		"git-commits",
		"plan-lifecycle",
		"retained-reports",
		"verification",
	];
	const requests: Array<{ access: string; networkAccess: string }> = [];
	const adapters = sources.map((source, index) => {
		const sourceAdapter = adapter(source, [
			artifact(source, `${index}-start`, { occurredAt: interval.start }),
			artifact(source, `${index}-inside`),
			artifact(source, `${index}-end`, { occurredAt: interval.end }),
		]);
		return {
			...sourceAdapter,
			capture: async (request: Parameters<RepositoryEvidenceAdapter["capture"]>[0]) => {
				requests.push(request);
				return await sourceAdapter.capture(request);
			},
		};
	});
	const evidence = await collect({ adapters: [...adapters].reverse() });
	const captured = evidence.filter((item) => item.availability === "captured" && item.source.identity.includes(":"));
	assert.equal(captured.filter((item) => item.source.identity.includes("-end")).length, 0);
	for (const source of sources) {
		assert.equal(captured.filter((item) => item.source.identity.startsWith(`${source}:`)).length, 2);
	}
	const plan = captured.find((item) => item.source.identity === "plan-lifecycle:1-inside");
	assert.equal(plan?.source.reference, "plan-lifecycle:1-inside");
	assert.match(plan?.representation?.text ?? "", /path=plans\/1-inside\.md/);
	assert.match(plan?.capture.provenance ?? "", /snapshot:plan-lifecycle:1-inside/);
	assert.ok(evidence.every((item) => item.interval.start === interval.start && item.interval.end === interval.end));
	assert.equal(
		evidence.some((item) => item.representation?.text.includes("10:00:00.000Z")),
		false,
	);
	assert.deepEqual(
		requests.map(({ access, networkAccess }) => ({ access, networkAccess })),
		sources.map(() => ({ access: "read-only", networkAccess: "forbidden" })),
	);
});

test("emits explicit bounded outcomes for missing adapters, empty sources, timeout, failure, unsupported, and rotated retention", async () => {
	const evidence = await collect({
		adapters: [
			adapter("git-commits"),
			{
				source: "plan-lifecycle",
				capture: async () => {
					throw new RepositoryEvidenceAdapterError("timeout", "git command timed out after 1000ms");
				},
			},
			{
				source: "retained-reports",
				capture: async () => ({
					status: "rotated",
					detail: "report retention no longer covers interval",
				}),
			},
			{
				source: "verification",
				capture: async () => {
					throw new Error("verification reader failed");
				},
			},
		],
	});
	const text = canonicalRetrospectiveEvidenceJson(evidence);
	for (const expected of ["available; records=0", "timeout", "rotated", "failed"])
		assert.match(text, new RegExp(expected));
	assert.equal(evidence.filter((item) => item.source.identity.startsWith("source-outcome:")).length, 4);

	const missing = await collect({ adapters: [] });
	assert.equal(missing.length, 4);
	assert.ok(
		missing.every((item) => item.availability === "unsupported" && item.gap?.reason.includes("missing adapter")),
	);
});

test("redacts credentials and unsafe absolute paths, truncates deterministically, and never hides ordinary repository facts", async () => {
	const rawSecret = "super-secret-value";
	const long = `ordinary shared diff ${"x".repeat(MAX_REPOSITORY_EVIDENCE_CONTENT_BYTES)} token=${rawSecret}`;
	const evidence = await collect({
		adapters: [
			adapter("git-commits", [
				artifact("git-commits", "secret", {
					summary: `local=/Users/cristian/private/repo/file.ts\nwindows=C:\\Users\\Cristian\\secret.txt\n${long}`,
					provenance: `git-log api_key=${rawSecret}`,
				}),
			]),
		],
	});
	const bytes = canonicalRetrospectiveEvidenceJson(evidence);
	assert.equal(bytes.includes(rawSecret), false);
	assert.equal(bytes.includes("/Users/cristian"), false);
	assert.equal(bytes.includes("C:\\Users\\Cristian"), false);
	assert.match(bytes, /\[REDACTED:credential\]/);
	assert.match(bytes, /\[REDACTED:path\]/);
	assert.match(bytes, /\[TRUNCATED:[0-9]+-bytes\]/);
	assert.match(bytes, /ordinary shared diff/);
	assert.ok(
		Buffer.byteLength(
			evidence.find((item) => item.source.identity === "git-commits:secret")?.representation?.text ?? "",
		) <= MAX_REPOSITORY_EVIDENCE_CONTENT_BYTES,
	);
});

test("cross-links one task across commit, plan, and report without erasing distinct provenance", async () => {
	const common = "TASK-0111";
	const evidence = await collect({
		adapters: [
			adapter("git-commits", [artifact("git-commits", "commit-a", { correlationId: common })]),
			adapter("plan-lifecycle", [artifact("plan-lifecycle", "plan-a", { correlationId: common })]),
			adapter("retained-reports", [artifact("retained-reports", "report-a", { correlationId: common })]),
			adapter("verification"),
		],
	});
	const linked = evidence.filter((item) => item.source.reference === common);
	assert.deepEqual(
		linked.map((item) => item.source.identity),
		["git-commits:commit-a", "plan-lifecycle:plan-a", "retained-reports:report-a"],
	);
	assert.equal(new Set(linked.map((item) => item.capture.provenance)).size, 3);
});

test("records dirty, detached, and rewritten history only as mechanical state and never infers quality or progress", async () => {
	const evidence = await collect({
		adapters: [
			adapter("git-commits"),
			adapter("plan-lifecycle"),
			adapter("retained-reports"),
			adapter("verification"),
		],
		state: async () => ({
			head: "abc123",
			branch: null,
			dirty: true,
			rewritten: true,
			provenance: "git-status+symbolic-ref+reflog",
		}),
	});
	const state = evidence.find((item) => item.source.identity === "repository-state:abc123");
	assert.match(state?.representation?.text ?? "", /dirty=true; detached=true; rewritten=true/);
	const bytes = canonicalRetrospectiveEvidenceJson(evidence).toLowerCase();
	for (const forbidden of ["productive", "quality improved", "regression", "cause", "completed work"]) {
		assert.equal(bytes.includes(forbidden), false);
	}
	assert.equal("authority" in (state ?? {}), false);
});

test("is deterministic across adapter arrival order, repeated snapshots, and item overflow", async () => {
	const items = Array.from({ length: MAX_REPOSITORY_EVIDENCE_ITEMS + 3 }, (_, index) =>
		artifact("git-commits", `commit-${String(index).padStart(4, "0")}`, {
			occurredAt: `2026-08-27T09:${String(index % 60).padStart(2, "0")}:00.000Z`,
		}),
	).reverse();
	const slow: RepositoryEvidenceAdapter = {
		source: "git-commits",
		capture: async () => ({
			status: "available",
			items,
			provenance: "git-log:v1",
		}),
	};
	const first = await collect({ adapters: [slow], maxItems: 5 });
	const second = await collect({ adapters: [slow], maxItems: 5 });
	assert.equal(canonicalRetrospectiveEvidenceJson(first), canonicalRetrospectiveEvidenceJson(second));
	assert.equal(first.filter((item) => item.source.identity.startsWith("git-commits:commit-")).length, 5);
	assert.ok(first.some((item) => item.gap?.reason.includes("truncated; omitted=")));
});

test("rejects unsafe paths and duplicate adapters explicitly without collecting or mutating repository state", async () => {
	let captures = 0;
	const unsafe = adapter("retained-reports", [
		artifact("retained-reports", "unsafe", {
			relativePath: "../../private.txt",
		}),
	]);
	const counting: RepositoryEvidenceAdapter = {
		source: "git-commits",
		capture: async () => {
			captures += 1;
			return { status: "available", items: [], provenance: "read-only" };
		},
	};
	const evidence = await collect({ adapters: [unsafe, counting] });
	assert.ok(evidence.some((item) => item.gap?.reason.includes("unsafe repository-relative path")));
	assert.equal(captures, 1);
	await assert.rejects(
		() => collect({ adapters: [counting, counting] }),
		(error: unknown) =>
			error instanceof TypeError && error.message.includes("duplicate repository evidence adapter"),
	);
});
