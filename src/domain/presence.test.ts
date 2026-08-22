import test from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_PRESENCE_OFFLINE_FAILURE_THRESHOLD,
	createInitialPresenceState,
	reducePresence,
	type PresenceEvent,
	type PresenceMember,
} from "./index.ts";

const lead = (identity: string, name = "lead", role = "lead"): PresenceMember => ({ identity, name, role });
const members = [
	lead("/crew/lead.sock"),
	lead("/crew/dev.sock", "dev", "developer"),
	lead("/crew/qa.sock", "qa", "qa"),
];
const apply = (state: ReturnType<typeof createInitialPresenceState>, event: PresenceEvent, roster = members) =>
	reducePresence(state, { members: roster, currentMemberIdentity: "/crew/lead.sock", event });

test("initial state excludes only exact current identity and preserves manifest order", () => {
	assert.deepEqual(createInitialPresenceState(members, "/crew/lead.sock"), {
		members: { "/crew/dev.sock": "unknown", "/crew/qa.sock": "unknown" },
		failures: { "/crew/dev.sock": 0, "/crew/qa.sock": 0 },
		initialScanComplete: false,
		config: { notifications: true },
	});
});

test("roster output retains manifest order and descriptive fields", () => {
	const result = apply(createInitialPresenceState(members, "/crew/lead.sock"), { type: "initial-scan-complete" });
	assert.deepEqual(result.effects, [
		{
			type: "roster",
			members: [members[1] && { ...members[1], status: "unknown" }, { ...members[2]!, status: "unknown" }],
		},
	]);
});

test("observations address identity, not name or role heuristics", () => {
	const sameDisplay = [lead("/a.sock", "same", "role-a"), lead("/b.sock", "same", "role-b")];
	let state = createInitialPresenceState(sameDisplay, "/a.sock");
	assert.deepEqual(state.members, { "/b.sock": "unknown" });
	const unknown = reducePresence(state, {
		members: sameDisplay,
		currentMemberIdentity: "/a.sock",
		event: { type: "observation", memberIdentity: "same", online: true },
	});
	assert.equal(unknown.state, state);
	state = reducePresence(state, {
		members: sameDisplay,
		currentMemberIdentity: "/a.sock",
		event: { type: "observation", memberIdentity: "/b.sock", online: true },
	}).state;
	assert.equal(state.members["/b.sock"], "online");
	assert.deepEqual(
		reducePresence(state, {
			members: sameDisplay,
			currentMemberIdentity: "/a.sock",
			event: { type: "observation", memberIdentity: "/a.sock", online: false },
		}),
		{ state, effects: [] },
	);
});

test("offline threshold and rejoin effects preserve exact member identity", () => {
	let state = createInitialPresenceState(members, "/crew/lead.sock");
	state = apply(state, { type: "initial-scan-complete" }).state;
	state = apply(state, { type: "observation", memberIdentity: "/crew/dev.sock", online: true }).state;
	let result = apply(state, { type: "observation", memberIdentity: "/crew/dev.sock", online: false });
	result = apply(result.state, { type: "observation", memberIdentity: "/crew/dev.sock", online: false });
	assert.equal(result.state.members["/crew/dev.sock"], "offline");
	assert.deepEqual(result.effects, [{ type: "left", member: members[1] }]);
	result = apply(result.state, { type: "observation", memberIdentity: "/crew/dev.sock", online: true });
	assert.deepEqual(result.effects, [{ type: "joined", member: members[1] }]);
});

test("duplicate observations and unknown identities are immutable no-ops", () => {
	let state = createInitialPresenceState(members, "/crew/lead.sock");
	state = apply(state, { type: "observation", memberIdentity: "/crew/qa.sock", online: true }).state;
	assert.equal(apply(state, { type: "observation", memberIdentity: "/crew/qa.sock", online: true }).state, state);
	assert.deepEqual(apply(state, { type: "observation", memberIdentity: "/missing.sock", online: false }), {
		state,
		effects: [],
	});
	assert.equal(apply(state, { type: "initial-scan-complete" }).state.initialScanComplete, true);
	assert.equal(DEFAULT_PRESENCE_OFFLINE_FAILURE_THRESHOLD, 2);
});

test("notifications disabled is immutable and silent", () => {
	const state = createInitialPresenceState(members, "/crew/lead.sock", { notifications: false });
	assert.deepEqual(apply(state, { type: "initial-scan-complete" }), { state, effects: [] });
});
