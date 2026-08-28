import assert from "node:assert/strict";
import test from "node:test";
import { isSafeAlias } from "../domain/index.ts";
import { createSocketState, getSessionAlias } from "./control-runtime.ts";
import { createSessionNameController } from "./session-name.ts";

const membership = (name = "Mary", role = "qa") => ({
	manifestPath: "/project/.pi/bebop/crew.json",
	socketPath: `/project/.pi/bebop/sockets/${name.toLowerCase()}.sock`,
	globalSocketPath: "/home/.pi/intray/session.sock",
	member: { name, role, socketPath: `/project/.pi/bebop/sockets/${name.toLowerCase()}.sock` },
	manifest: { members: [] },
});

function host(initial?: string) {
	let name = initial;
	const setCalls: string[] = [];
	const entries: Array<{ type: string; data: unknown }> = [];
	return {
		host: {
			getSessionName: () => name,
			setSessionName: (next: string) => {
				name = next || undefined;
				setCalls.push(next);
			},
			appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
		},
		get name() {
			return name;
		},
		setExternalName: (next?: string) => {
			name = next;
		},
		setCalls,
		entries,
	};
}

test("controller sets an unnamed session and owns the exact Member name", () => {
	const h = host();
	const controller = createSessionNameController(h.host);
	controller.syncMembership(membership());
	assert.equal(h.name, "Mary");
	assert.deepEqual(h.setCalls, ["Mary"]);
	assert.equal(controller.isAutoOwned(), true);
});

test("manual session_info_changed relinquishes ownership and is never overwritten", () => {
	const h = host();
	const controller = createSessionNameController(h.host);
	controller.syncMembership(membership());
	h.setExternalName("Manual task");
	controller.observeChange("Manual task");
	controller.syncMembership(membership("Kelly", "developer"));
	assert.equal(h.name, "Manual task");
	assert.deepEqual(h.setCalls, ["Mary"]);
	assert.equal(controller.isAutoOwned(), false);
});

test("an internal setSessionName event does not look like a manual override", () => {
	const h = host();
	const controller = createSessionNameController(h.host);
	controller.syncMembership(membership());
	controller.observeChange("Mary");
	assert.equal(controller.isAutoOwned(), true);
	controller.syncMembership(membership("Kelly", "developer"));
	controller.observeChange("Kelly");
	assert.equal(controller.isAutoOwned(), true);
});

test("auto ownership clears only a matching name on membership release", () => {
	const h = host();
	const controller = createSessionNameController(h.host);
	controller.syncMembership(membership());
	controller.syncMembership(null);
	assert.equal(h.name, undefined);
	assert.deepEqual(h.setCalls, ["Mary", ""]);

	const manual = host();
	const manualController = createSessionNameController(manual.host);
	manualController.syncMembership(membership());
	manual.setExternalName("Manual");
	manualController.observeChange("Manual");
	manualController.syncMembership(null);
	assert.equal(manual.name, "Manual");
	assert.deepEqual(manual.setCalls, ["Mary"]);
});

test("valid auto ownership restores only when the current display name matches", () => {
	const first = host();
	const original = createSessionNameController(first.host);
	original.syncMembership(membership());
	const saved = first.entries.at(-1)!.data;

	const restored = host("Mary");
	const controller = createSessionNameController(restored.host);
	controller.restore([{ type: "custom", customType: first.entries.at(-1)!.type, data: saved }]);
	controller.syncMembership(membership("Kelly", "developer"));
	assert.deepEqual(restored.setCalls, ["Kelly"]);

	const mismatch = host("Manual");
	const mismatchController = createSessionNameController(mismatch.host);
	mismatchController.restore([{ type: "custom", customType: first.entries.at(-1)!.type, data: saved }]);
	mismatchController.syncMembership(membership("Kelly", "developer"));
	assert.deepEqual(mismatch.setCalls, []);
	assert.equal(mismatch.name, "Manual");
});

test("session-name API failures do not claim ownership or fail membership flow", () => {
	const entries: unknown[] = [];
	const controller = createSessionNameController({
		getSessionName: () => undefined,
		setSessionName: () => {
			throw new Error("stale Pi context");
		},
		appendEntry: (_type, data) => entries.push(data),
	});
	assert.doesNotThrow(() => controller.syncMembership(membership()));
	assert.equal(controller.isAutoOwned(), false);
	assert.deepEqual(entries, []);
});

test("auto-owned Member name is excluded from the global session alias", () => {
	const state = createSocketState();
	const ctx = { sessionManager: { getSessionName: () => "Mary" } } as never;
	assert.equal(getSessionAlias(ctx, state), "Mary");
	state.sessionNameController = { isAutoOwned: () => true } as never;
	assert.equal(getSessionAlias(ctx, state), null);
	assert.equal(isSafeAlias("Mary"), true);
});
