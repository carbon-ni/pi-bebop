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

test("fake Pi lifecycle names rejoin/replacement and exact-match leave, stop, shutdown, and failed restore", () => {
	const first = host();
	const firstController = createSessionNameController(first.host);
	firstController.syncMembership(membership("Mary"));
	firstController.observeChange("Mary");
	firstController.syncMembership(null); // leave/stop/shutdown release
	firstController.observeChange(undefined);
	firstController.syncMembership(membership("Kelly", "developer")); // rejoin/replacement
	firstController.observeChange("Kelly");
	assert.deepEqual(first.setCalls, ["Mary", "", "Kelly"]);
	assert.equal(firstController.isAutoOwned(), true);
	assert.equal(first.entries.length, 3);

	const savedEntry = first.entries[0]!;
	const resumed = host("Mary");
	const resumedController = createSessionNameController(resumed.host);
	resumedController.restore([{ type: "custom", customType: savedEntry.type, data: savedEntry.data }]);
	resumedController.syncMembership(membership("Mary")); // reload/resume: no duplicate set
	assert.deepEqual(resumed.setCalls, []);
	assert.equal(resumedController.isAutoOwned(), true);

	const fork = host();
	const forkController = createSessionNameController(fork.host);
	forkController.restore([{ type: "custom", customType: savedEntry.type, data: savedEntry.data }]);
	forkController.syncMembership(membership("Mary")); // fork gets a new unnamed Pi session
	assert.deepEqual(fork.setCalls, ["Mary"]);

	const failedRestore = host("Mary");
	const failedController = createSessionNameController(failedRestore.host);
	failedController.restore([{ type: "custom", customType: savedEntry.type, data: savedEntry.data }]);
	failedController.syncMembership(null); // failed restore cleanup clears only exact auto name
	assert.deepEqual(failedRestore.setCalls, [""]);
	assert.equal(failedRestore.name, undefined);

	const fakePi = {
		turnCalls: 0,
		messageCalls: 0,
		networkCalls: 0,
		name: undefined as string | undefined,
		setSessionName(name: string) {
			fakePi.name = name || undefined;
		},
		sendMessage() {
			fakePi.messageCalls += 1;
		},
		requestNetwork() {
			fakePi.networkCalls += 1;
		},
		startTurn() {
			fakePi.turnCalls += 1;
		},
	};
	const noEffectController = createSessionNameController({
		getSessionName: () => fakePi.name,
		setSessionName: (name) => fakePi.setSessionName(name),
		appendEntry: () => undefined,
	});
	noEffectController.syncMembership(membership("Mary"));
	assert.equal(fakePi.turnCalls + fakePi.messageCalls + fakePi.networkCalls, 0);
});

test("fake Pi synchronous session_info_changed is reentrant-safe and metadata-only", () => {
	const log: string[] = [];
	let name: string | undefined;
	let observe: (next: string | undefined) => void = () => undefined;
	const fakePi = {
		turnCalls: 0,
		messageCalls: 0,
		networkCalls: 0,
		setSessionName(next: string) {
			log.push(`set:${next}`);
			name = next || undefined;
			observe(name);
		},
		sendMessage() {
			fakePi.messageCalls += 1;
		},
		requestNetwork() {
			fakePi.networkCalls += 1;
		},
		startTurn() {
			fakePi.turnCalls += 1;
		},
	};
	const controller = createSessionNameController({
		getSessionName: () => name,
		setSessionName: (next) => fakePi.setSessionName(next),
		appendEntry: (type) => log.push(`entry:${type}`),
	});
	observe = (next) => {
		log.push(`session_info_changed:${next ?? ""}`);
		controller.observeChange(next);
	};
	controller.syncMembership(membership("Mary"));
	assert.deepEqual(log, ["set:Mary", "session_info_changed:Mary", "entry:intray-session-name"]);
	assert.equal(fakePi.turnCalls + fakePi.messageCalls + fakePi.networkCalls, 0);
});

test("direct malformed membership injection cannot name the session", () => {
	const h = host();
	const controller = createSessionNameController(h.host);
	assert.doesNotThrow(() => controller.syncMembership(membership("Mary\nInjected")));
	assert.equal(h.name, undefined);
	assert.deepEqual(h.setCalls, []);
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
