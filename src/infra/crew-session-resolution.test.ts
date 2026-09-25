import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getLatestMembershipState } from "../domain/index.ts";
import { createCrewSessionResolutionDependencies } from "./crew-session-resolution.ts";

test("maps supported Pi sessions to narrow recovery evidence", async () => {
	const cwd = await mkdtemp(path.join("/tmp", "bebop-resolution-cwd-"));
	const root = await mkdtemp(path.join("/tmp", "bebop-resolution-root-"));
	try {
		const manager = SessionManager.create(cwd, root, { id: "session-0224-adapter" });
		const file = manager.getSessionFile();
		assert.ok(file);
		await writeFile(file, `${JSON.stringify(manager.getHeader())}\n`, { mode: 0o600 });
		SessionManager.open(file, root).appendCustomEntry("intray-membership", {
			active: true,
			socketPath: "/project/sockets/alice.sock",
			manifestPath: "/project/.pi/bebop/crew.json",
		});

		const evidence = await createCrewSessionResolutionDependencies().readSessionEvidence(file, root);

		assert.deepEqual(evidence.id, "session-0224-adapter");
		assert.equal(evidence.root, root);
		assert.equal(getLatestMembershipState(evidence.membership)?.active, true);
		assert.equal(getLatestMembershipState(evidence.membership)?.socketPath, "/project/sockets/alice.sock");
		assert.equal(getLatestMembershipState(evidence.membership)?.manifestPath, "/project/.pi/bebop/crew.json");
	} finally {
		await Promise.all([rm(cwd, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]);
	}
});
