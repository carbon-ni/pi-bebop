import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CrewRetrospectiveScheduleStoreError,
	openTrustedCrewRetrospectiveScheduleStore,
} from "./crew-retrospective-schedule-store.ts";
import { emptyRetrospectiveSchedule } from "../domain/index.ts";

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-retrospective-schedule-"));
	const layout = path.join(root, ".pi", "bebop");
	await fs.mkdir(layout, { recursive: true });
	await fs.writeFile(path.join(layout, "crew.json"), "{}", "utf8");
	return { root, projectRoot: root, manifestPath: path.join(layout, "crew.json") };
}

test("schedule store reads missing state, writes atomically, and reloads it", async () => {
	const fixtureData = await fixture();
	const store = await openTrustedCrewRetrospectiveScheduleStore({
		...fixtureData,
		isProjectTrusted: () => true,
	});
	assert.equal(await store.read(), null);
	const state = { ...emptyRetrospectiveSchedule(), configuredAt: 100 };
	await store.write(state);
	assert.deepEqual(await store.read(), state);
	await fs.rm(fixtureData.root, { recursive: true, force: true });
});

test("schedule store rejects untrusted access before creating runtime state", async () => {
	const fixtureData = await fixture();
	await assert.rejects(
		() =>
			openTrustedCrewRetrospectiveScheduleStore({
				...fixtureData,
				isProjectTrusted: () => false,
			}),
		(error: unknown) => error instanceof CrewRetrospectiveScheduleStoreError && error.code === "untrusted-project",
	);
	await assert.rejects(() => fs.stat(path.join(fixtureData.root, ".pi", "bebop", "retrospectives")), /ENOENT/);
	await fs.rm(fixtureData.root, { recursive: true, force: true });
});
