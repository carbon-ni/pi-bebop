import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { publishIntakeFile, renderIntakeMessage, runUpstreamCiCheck, toExitCode } from "./upstream-ci-check.mjs";

const FAILING_RUN = {
	databaseId: 35743729345,
	status: "completed",
	conclusion: "failure",
	displayTitle: "chore: update bebop quality doc",
	headSha: "a412ab58d97b073162babf0deb231d4170802a5e",
	url: "https://github.com/carbon-ni/pi-bebop/actions/runs/35743729345",
	workflowName: "CI",
};
const SUCCESS_RUN = { ...FAILING_RUN, databaseId: 35602570857, conclusion: "success" };

function trackingPublish() {
	const published = [];
	return { published, publish: async (message) => (published.push(message), { filename: "upstream-ci.md" }) };
}

function memoryState(notified = []) {
	const ids = new Set(notified);
	return { ids, getNotified: async () => [...ids], setNotified: async (next) => next.forEach((id) => ids.add(id)) };
}

test("failing upstream main notifies the crew once with the run evidence", async () => {
	const { published, publish } = trackingPublish();
	const state = memoryState();
	const { outcome } = await runUpstreamCiCheck({
		listRuns: async () => [FAILING_RUN],
		publish,
		...state,
		now: () => 1_700_000_000_000,
	});

	assert.equal(outcome.kind, "notified");
	assert.equal(outcome.run.databaseId, FAILING_RUN.databaseId);
	assert.equal(published.length, 1);
	assert.match(published[0].content, /carbon-ni\/pi-bebop/);
	assert.match(published[0].content, /main/);
	assert.match(published[0].content, /35743729345/);
	assert.match(published[0].content, /a412ab58d97b073162babf0deb231d4170802a5e/);
	assert.match(published[0].content, /chore: update bebop quality doc/);
	assert.equal(outcome.publication.filename, "upstream-ci.md");
});

test("the same failing run is never published twice", async () => {
	const { published, publish } = trackingPublish();
	const first = await runUpstreamCiCheck({
		listRuns: async () => [FAILING_RUN],
		publish,
		...memoryState(),
	});
	const second = await runUpstreamCiCheck({
		listRuns: async () => [FAILING_RUN],
		publish,
		...memoryState([FAILING_RUN.databaseId]),
	});

	assert.equal(first.outcome.kind, "notified");
	assert.equal(second.outcome.kind, "already-notified");
	assert.equal(published.length, 1);
});

test("a healthy upstream main publishes nothing", async () => {
	const { published, publish } = trackingPublish();
	const { outcome } = await runUpstreamCiCheck({ listRuns: async () => [SUCCESS_RUN], publish, ...memoryState() });

	assert.equal(outcome.kind, "healthy");
	assert.equal(outcome.run.conclusion, "success");
	assert.deepEqual(published, []);
});

test("in-progress runs are skipped in favor of the latest completed run", async () => {
	const pending = { ...FAILING_RUN, databaseId: 999, status: "in_progress", conclusion: null };
	const { published, publish } = trackingPublish();
	const { outcome } = await runUpstreamCiCheck({
		listRuns: async () => [pending, SUCCESS_RUN],
		publish,
		...memoryState(),
	});

	assert.equal(outcome.kind, "healthy");
	assert.equal(outcome.run.databaseId, SUCCESS_RUN.databaseId);
	assert.deepEqual(published, []);
});

test("a cancelled run is not reported as a failure", async () => {
	const cancelled = { ...FAILING_RUN, databaseId: 35691827197, conclusion: "cancelled" };
	const { published, publish } = trackingPublish();
	const { outcome } = await runUpstreamCiCheck({ listRuns: async () => [cancelled], publish, ...memoryState() });

	assert.equal(outcome.kind, "healthy");
	assert.deepEqual(published, []);
});

test("github unavailability is reported as unknown evidence and never fails the gate", async () => {
	const { published, publish } = trackingPublish();
	const { outcome } = await runUpstreamCiCheck({
		listRuns: async () => {
			throw new Error("gh: not authenticated");
		},
		publish,
		...memoryState(),
	});

	assert.equal(outcome.kind, "unknown");
	assert.match(outcome.evidence, /not authenticated/);
	assert.deepEqual(published, []);
	assert.equal(toExitCode(outcome), 0);
});

test("no completed run for main is unknown, not a failure", async () => {
	const { published, publish } = trackingPublish();
	const { outcome } = await runUpstreamCiCheck({ listRuns: async () => [], publish, ...memoryState() });

	assert.equal(outcome.kind, "unknown");
	assert.deepEqual(published, []);
});

test("the published message states the source and the missing evidence boundary", () => {
	const message = renderIntakeMessage(FAILING_RUN, () => 1_700_000_000_000);

	assert.match(message, /^# Upstream CI failure/m);
	assert.match(message, /carbon-ni\/pi-bebop main/);
	assert.match(message, /CI/);
	assert.match(message, /automated/);
});

test("publishIntakeFile never overwrites an existing publication name", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "upstream-ci-"));
	try {
		await publishIntakeFile({ dir, filename: "upstream-ci-main-1.md", content: "first\n" });

		await assert.rejects(
			() => publishIntakeFile({ dir, filename: "upstream-ci-main-1.md", content: "second\n" }),
			/refusing to overwrite/,
		);
		assert.equal(await readFile(path.join(dir, "upstream-ci-main-1.md"), "utf8"), "first\n");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("an empty Intake message is refused", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "upstream-ci-"));
	try {
		await assert.rejects(
			() => publishIntakeFile({ dir, filename: "empty.md", content: "   \n" }),
			/refusing to publish an empty Intake message/,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("publishIntakeFile writes one atomic file and leaves no draft behind", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "upstream-ci-"));
	try {
		const publication = await publishIntakeFile({
			dir,
			filename: "upstream-ci-main-35743729345.md",
			content: "# Upstream CI failure\n",
		});

		assert.equal(publication.filename, "upstream-ci-main-35743729345.md");
		assert.deepEqual(await readdir(dir), ["upstream-ci-main-35743729345.md"]);
		assert.equal(await readFile(path.join(dir, publication.filename), "utf8"), "# Upstream CI failure\n");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
