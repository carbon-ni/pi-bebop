import test from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_PRESENCE_OFFLINE_FAILURE_THRESHOLD,
	createInitialPresenceState,
	parseCrewManifest,
	reducePresence,
	type PresenceEvent,
	type PresenceMember,
} from "./index.ts";

const member = (identity: string, name: string, role: string): PresenceMember => ({ identity, name, role });
const lead = member("/crew/lead.sock", "lead", "lead");
const dev = member("/crew/dev.sock", "dev", "developer");
const qa = member("/crew/qa.sock", "qa", "qa");
const members = [lead, dev, qa] as const;
const currentMemberIdentity = lead.identity;

function apply(
	state: ReturnType<typeof createInitialPresenceState>,
	event: PresenceEvent,
	roster: readonly PresenceMember[] = members,
	current = currentMemberIdentity,
) {
	return reducePresence(state, { members: roster, currentMemberIdentity: current, event });
}

function scan(roster: readonly PresenceMember[] = members) {
	return apply(createInitialPresenceState(roster, currentMemberIdentity), { type: "initial-scan-complete" }, roster);
}

test("initial state is unknown for ordered non-current members and excludes only exact current identity", () => {
	assert.deepEqual(createInitialPresenceState(members, currentMemberIdentity), {
		members: { [dev.identity]: "unknown", [qa.identity]: "unknown" },
		failures: { [dev.identity]: 0, [qa.identity]: 0 },
		initialScanComplete: false,
		config: { notifications: true },
	});
});

test("initial scan emits one ordered roster and no joined or left effects", () => {
	const result = scan();
	assert.deepEqual(result.effects, [
		{
			type: "roster",
			members: [
				{ ...dev, status: "unknown" },
				{ ...qa, status: "unknown" },
			],
		},
	]);
});

test("pre-scan observations suppress joined and left and the roster reflects final ordered statuses", () => {
	let state = createInitialPresenceState(members, currentMemberIdentity);
	state = apply(state, { type: "observation", memberIdentity: qa.identity, online: true }).state;
	state = apply(state, { type: "observation", memberIdentity: dev.identity, online: false }).state;
	let result = apply(state, { type: "initial-scan-complete" });
	assert.deepEqual(result.effects, [
		{
			type: "roster",
			members: [
				{ ...dev, status: "suspect" },
				{ ...qa, status: "online" },
			],
		},
	]);
	assert.deepEqual(apply(result.state, { type: "initial-scan-complete" }), { state: result.state, effects: [] });
});

test("duplicate initial scan completion is an exact state/effects no-op", () => {
	const first = scan();
	const second = apply(first.state, { type: "initial-scan-complete" });
	assert.equal(second.state, first.state);
	assert.deepEqual(second.effects, []);
});

test("unknown and first online/offline failures become suspect without left effects", () => {
	let state = scan().state;
	let result = apply(state, { type: "observation", memberIdentity: dev.identity, online: false });
	assert.equal(result.state.members[dev.identity], "suspect");
	assert.deepEqual(result.effects, []);
	state = result.state;
	result = apply(state, { type: "observation", memberIdentity: qa.identity, online: true });
	assert.equal(result.state.members[qa.identity], "online");
	assert.deepEqual(result.effects, []);
	result = apply(result.state, { type: "observation", memberIdentity: qa.identity, online: false });
	assert.equal(result.state.members[qa.identity], "suspect");
	assert.deepEqual(result.effects, []);
});

test("threshold second failure becomes offline and emits exactly one left effect", () => {
	let state = scan().state;
	state = apply(state, { type: "observation", memberIdentity: dev.identity, online: false }).state;
	const result = apply(state, { type: "observation", memberIdentity: dev.identity, online: false });
	assert.equal(result.state.members[dev.identity], "offline");
	assert.deepEqual(result.effects, [{ type: "left", member: dev }]);
});

test("repeated offline is a state-identity and effects no-op", () => {
	let state = scan().state;
	state = apply(state, { type: "observation", memberIdentity: dev.identity, online: false }).state;
	state = apply(state, { type: "observation", memberIdentity: dev.identity, online: false }).state;
	const result = apply(state, { type: "observation", memberIdentity: dev.identity, online: false });
	assert.equal(result.state, state);
	assert.deepEqual(result.effects, []);
});

test("suspect to online is silent and resets failure count", () => {
	let state = scan().state;
	state = apply(state, { type: "observation", memberIdentity: dev.identity, online: false }).state;
	const result = apply(state, { type: "observation", memberIdentity: dev.identity, online: true });
	assert.equal(result.state.members[dev.identity], "online");
	assert.equal(result.state.failures[dev.identity], 0);
	assert.deepEqual(result.effects, []);
});

test("offline to online emits exactly one joined and repeated success is a no-op", () => {
	let state = scan().state;
	state = apply(state, { type: "observation", memberIdentity: dev.identity, online: false }).state;
	state = apply(state, { type: "observation", memberIdentity: dev.identity, online: false }).state;
	const joined = apply(state, { type: "observation", memberIdentity: dev.identity, online: true });
	assert.deepEqual(joined.effects, [{ type: "joined", member: dev }]);
	const repeated = apply(joined.state, { type: "observation", memberIdentity: dev.identity, online: true });
	assert.equal(repeated.state, joined.state);
	assert.deepEqual(repeated.effects, []);
});

test("out-of-order identity observations preserve manifest order in the roster", () => {
	let state = createInitialPresenceState(members, currentMemberIdentity);
	state = apply(state, { type: "observation", memberIdentity: qa.identity, online: true }).state;
	state = apply(state, { type: "observation", memberIdentity: dev.identity, online: true }).state;
	const result = apply(state, { type: "initial-scan-complete" });
	assert.deepEqual(
		(result.effects[0] as { members: PresenceMember[] }).members.map((item) => item.identity),
		[dev.identity, qa.identity],
	);
});

test("current exact identity is ignored even when display name and role match another member", () => {
	const sameDisplay = [lead, member("/crew/other.sock", "lead", "lead"), qa];
	const state = createInitialPresenceState(sameDisplay, lead.identity);
	assert.deepEqual(Object.keys(state.members), ["/crew/other.sock", qa.identity]);
	const result = reducePresence(state, {
		members: sameDisplay,
		currentMemberIdentity: lead.identity,
		event: { type: "observation", memberIdentity: lead.identity, online: false },
	});
	assert.equal(result.state, state);
	assert.deepEqual(result.effects, []);
});

test("unknown identity is an immutable no-op", () => {
	const state = scan().state;
	const result = apply(state, { type: "observation", memberIdentity: "/crew/missing.sock", online: true });
	assert.equal(result.state, state);
	assert.deepEqual(result.effects, []);
});

test("same display name with different identities routes each observation independently", () => {
	const first = member("/a.sock", "same", "role-a");
	const second = member("/b.sock", "same", "role-b");
	let state = createInitialPresenceState([first, second]);
	state = reducePresence(state, {
		members: [first, second],
		event: { type: "observation", memberIdentity: second.identity, online: true },
	}).state;
	assert.equal(state.members[first.identity], "unknown");
	assert.equal(state.members[second.identity], "online");
});

test("leave and rejoin role-switch table preserves old-role left/new-role joined for one identity", () => {
	const identity = "/crew/dev.sock";
	const oldRole = member(identity, "dev", "developer");
	const newRole = member(identity, "dev", "reviewer");
	let state = createInitialPresenceState([oldRole]);
	state = reducePresence(state, { members: [oldRole], event: { type: "initial-scan-complete" } }).state;
	state = reducePresence(state, {
		members: [oldRole],
		event: { type: "observation", memberIdentity: identity, online: true },
	}).state;
	state = reducePresence(state, {
		members: [oldRole],
		event: { type: "observation", memberIdentity: identity, online: false },
	}).state;
	state = reducePresence(state, {
		members: [oldRole],
		event: { type: "observation", memberIdentity: identity, online: false },
	}).state;
	assert.deepEqual(
		reducePresence(state, {
			members: [oldRole],
			event: { type: "observation", memberIdentity: identity, online: true },
		}).effects,
		[{ type: "joined", member: oldRole }],
	);
	let switched = createInitialPresenceState([oldRole]);
	switched = reducePresence(switched, { members: [oldRole], event: { type: "initial-scan-complete" } }).state;
	switched = reducePresence(switched, {
		members: [oldRole],
		event: { type: "observation", memberIdentity: identity, online: true },
	}).state;
	switched = reducePresence(switched, {
		members: [oldRole],
		event: { type: "observation", memberIdentity: identity, online: false },
	}).state;
	switched = reducePresence(switched, {
		members: [oldRole],
		event: { type: "observation", memberIdentity: identity, online: false },
	}).state;
	assert.deepEqual(
		reducePresence(switched, {
			members: [newRole],
			event: { type: "observation", memberIdentity: identity, online: true },
		}).effects,
		[{ type: "joined", member: newRole }],
	);
	const changedIdentity = "/crew/dev-new.sock";
	const newIdentityRole = member(changedIdentity, "dev", "reviewer");
	const fresh = createInitialPresenceState([newIdentityRole]);
	assert.deepEqual(
		reducePresence(fresh, {
			members: [newIdentityRole],
			event: { type: "observation", memberIdentity: identity, online: false },
		}),
		{ state: fresh, effects: [] },
	);
	assert.deepEqual(
		reducePresence(fresh, {
			members: [newIdentityRole],
			event: { type: "observation", memberIdentity: changedIdentity, online: true },
		}).state.members[changedIdentity],
		"online",
	);
});

test("strict manifest presence config defaults true, accepts false, and rejects wrong or unknown fields", () => {
	assert.equal(
		parseCrewManifest({ version: 1, members: [{ name: "dev", role: "dev", socket: "sockets/dev.sock" }] }).presence
			?.notifications,
		true,
	);
	assert.equal(
		parseCrewManifest({
			version: 1,
			presence: { notifications: false },
			members: [{ name: "dev", role: "dev", socket: "sockets/dev.sock" }],
		}).presence?.notifications,
		false,
	);
	assert.throws(() =>
		parseCrewManifest({
			version: 1,
			presence: { notifications: "yes" },
			members: [{ name: "dev", role: "dev", socket: "sockets/dev.sock" }],
		}),
	);
	assert.throws(() =>
		parseCrewManifest({
			version: 1,
			presence: { notifications: true, extra: false },
			members: [{ name: "dev", role: "dev", socket: "sockets/dev.sock" }],
		}),
	);
});

test("disabled notifications suppress observations, scan, and effects while preserving exact state", () => {
	const state = createInitialPresenceState(members, currentMemberIdentity, { notifications: false });
	assert.deepEqual(apply(state, { type: "observation", memberIdentity: dev.identity, online: true }), {
		state,
		effects: [],
	});
	assert.deepEqual(apply(state, { type: "initial-scan-complete" }), { state, effects: [] });
});

test("initial inputs are snapshotted against later member/config mutation", () => {
	const mutableMember = { identity: "/mutable.sock", name: "mutable", role: "old" };
	const config = { notifications: true };
	const state = createInitialPresenceState([mutableMember], undefined, config);
	mutableMember.identity = "/changed.sock";
	mutableMember.name = "changed";
	config.notifications = false;
	assert.deepEqual(state.members, { "/mutable.sock": "unknown" });
	assert.deepEqual(state.failures, { "/mutable.sock": 0 });
	assert.equal(state.config.notifications, true);
});
