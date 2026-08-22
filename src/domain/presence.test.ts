import test from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_PRESENCE_OFFLINE_FAILURE_THRESHOLD,
	createInitialPresenceState,
	parseCrewManifest,
	reducePresence,
	type PresenceEvent,
} from "./index.ts";

const members = [
	{ name: "lead", role: "lead" },
	{ name: "dev", role: "developer" },
	{ name: "qa", role: "qa" },
];

function apply(state: ReturnType<typeof createInitialPresenceState>, event: PresenceEvent) {
	return reducePresence(state, { members, currentMemberName: "lead", event });
}

test("initial state is unknown for ordered non-current members and excludes current", () => {
	const state = createInitialPresenceState(members, "lead");
	assert.deepEqual(state, {
		members: { dev: "unknown", qa: "unknown" },
		failures: { dev: 0, qa: 0 },
		initialScanComplete: false,
		config: { notifications: true },
	});
});

test("initial scan emits one ordered roster and no joined or left effects", () => {
	let result = apply(createInitialPresenceState(members, "lead"), { type: "initial-scan-complete" });
	assert.deepEqual(result.effects, [
		{
			type: "roster",
			members: [
				{ name: "dev", role: "developer", status: "unknown" },
				{ name: "qa", role: "qa", status: "unknown" },
			],
		},
	]);
	result = apply(result.state, { type: "initial-scan-complete" });
	assert.deepEqual(result.effects, []);
});

test("unknown failure becomes suspect, then offline at the named threshold", () => {
	let state = apply(createInitialPresenceState(members, "lead"), { type: "initial-scan-complete" }).state;
	let result = apply(state, { type: "observation", memberName: "dev", online: false });
	assert.equal(result.state.members.dev, "suspect");
	assert.deepEqual(result.effects, []);
	result = apply(result.state, { type: "observation", memberName: "dev", online: false });
	assert.equal(result.state.members.dev, "offline");
	assert.deepEqual(result.effects, [{ type: "left", member: { name: "dev", role: "developer" } }]);
});

test("observations before initial scan suppress effects and roster reflects final ordered statuses", () => {
	let state = createInitialPresenceState(members, "lead");
	let result = apply(state, { type: "observation", memberName: "qa", online: true });
	assert.deepEqual(result.effects, []);
	state = result.state;
	result = apply(state, { type: "observation", memberName: "dev", online: false });
	assert.deepEqual(result.effects, []);
	result = apply(result.state, { type: "initial-scan-complete" });
	assert.deepEqual(result.effects, [
		{
			type: "roster",
			members: [
				{ name: "dev", role: "developer", status: "suspect" },
				{ name: "qa", role: "qa", status: "online" },
			],
		},
	]);
});

test("online failure becomes suspect, then offline at the named threshold with one left", () => {
	let state = apply(createInitialPresenceState(members, "lead"), { type: "initial-scan-complete" }).state;
	state = apply(state, { type: "observation", memberName: "dev", online: true }).state;
	let result = apply(state, { type: "observation", memberName: "dev", online: false });
	assert.equal(result.state.members.dev, "suspect");
	assert.deepEqual(result.effects, []);
	for (let i = 1; i < DEFAULT_PRESENCE_OFFLINE_FAILURE_THRESHOLD; i += 1)
		result = apply(result.state, { type: "observation", memberName: "dev", online: false });
	assert.equal(result.state.members.dev, "offline");
	assert.deepEqual(result.effects, [{ type: "left", member: { name: "dev", role: "developer" } }]);
	result = apply(result.state, { type: "observation", memberName: "dev", online: false });
	assert.deepEqual(result.effects, []);
});

test("suspect success is silent and offline success emits one joined", () => {
	let state = apply(createInitialPresenceState(members, "lead"), { type: "initial-scan-complete" }).state;
	state = apply(state, { type: "observation", memberName: "dev", online: true }).state;
	state = apply(state, { type: "observation", memberName: "dev", online: false }).state;
	let result = apply(state, { type: "observation", memberName: "dev", online: true });
	assert.equal(result.state.members.dev, "online");
	assert.deepEqual(result.effects, []);
	state = { ...result.state, members: { ...result.state.members, dev: "offline" } };
	result = apply(state, { type: "observation", memberName: "dev", online: true });
	assert.deepEqual(result.effects, [{ type: "joined", member: { name: "dev", role: "developer" } }]);
});

test("offline and online duplicates are no-ops and out-of-order probes retain manifest order", () => {
	let state = createInitialPresenceState(members, "lead");
	state = apply(state, { type: "observation", memberName: "qa", online: true }).state;
	state = apply(state, { type: "observation", memberName: "dev", online: true }).state;
	const duplicateOnline = apply(state, { type: "observation", memberName: "dev", online: true });
	assert.equal(duplicateOnline.state, state);
	state = {
		...state,
		members: { ...state.members, dev: "offline" },
		failures: { ...state.failures, dev: DEFAULT_PRESENCE_OFFLINE_FAILURE_THRESHOLD },
	};
	const duplicateOffline = apply(state, { type: "observation", memberName: "dev", online: false });
	assert.equal(duplicateOffline.state, state);
	assert.deepEqual(duplicateOffline.effects, []);
	const scanned = apply(state, { type: "initial-scan-complete" });
	assert.deepEqual(scanned.effects[0], {
		type: "roster",
		members: [
			{ name: "dev", role: "developer", status: "offline" },
			{ name: "qa", role: "qa", status: "online" },
		],
	});
});

test("observations are immutable, ordered, and current identity is ignored", () => {
	const initial = createInitialPresenceState(members, "lead");
	const result = apply(initial, { type: "observation", memberName: "qa", online: true });
	assert.notEqual(result.state, initial);
	assert.deepEqual(Object.keys(result.state.members), ["dev", "qa"]);
	assert.deepEqual(apply(initial, { type: "observation", memberName: "lead", online: false }), {
		state: initial,
		effects: [],
	});
});

test("strict optional presence notifications config defaults true and rejects unknown fields", () => {
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

test("leave and rejoin effects are deterministic across a role switch table", () => {
	const cases = [
		{ name: "dev", role: "developer", expected: { type: "left", member: { name: "dev", role: "developer" } } },
		{ name: "qa", role: "reviewer", expected: { type: "left", member: { name: "qa", role: "reviewer" } } },
	] as const;
	for (const row of cases) {
		let state = reducePresence(createInitialPresenceState([{ name: row.name, role: row.role }], "lead"), {
			members: [{ name: row.name, role: row.role }],
			currentMemberName: "lead",
			event: { type: "initial-scan-complete" },
		}).state;
		state = reducePresence(state, {
			members: [{ name: row.name, role: row.role }],
			currentMemberName: "lead",
			event: { type: "observation", memberName: row.name, online: true },
		}).state;
		state = reducePresence(state, {
			members: [{ name: row.name, role: row.role }],
			currentMemberName: "lead",
			event: { type: "observation", memberName: row.name, online: false },
		}).state;
		const left = reducePresence(state, {
			members: [{ name: row.name, role: row.role }],
			currentMemberName: "lead",
			event: { type: "observation", memberName: row.name, online: false },
		});
		assert.deepEqual(left.effects, [row.expected]);
		const rejoined = reducePresence(left.state, {
			members: [{ name: row.name, role: `${row.role}-new` }],
			currentMemberName: "lead",
			event: { type: "observation", memberName: row.name, online: true },
		});
		assert.deepEqual(rejoined.effects, [{ type: "joined", member: { name: row.name, role: `${row.role}-new` } }]);
	}
});

test("initial state snapshots inputs and cannot be changed through config mutation", () => {
	const inputMembers = [{ name: "dev", role: "developer" }];
	const inputConfig = { notifications: true };
	const state = createInitialPresenceState(inputMembers, "lead", inputConfig);
	inputMembers[0]!.name = "changed";
	inputConfig.notifications = false;
	assert.deepEqual(state.members, { dev: "unknown" });
	const result = reducePresence(state, {
		members: [{ name: "dev", role: "developer" }],
		currentMemberName: "lead",
		event: { type: "observation", memberName: "dev", online: false },
	});
	assert.equal(result.state.members.dev, "suspect");
});

test("disabled notifications preserve membership state while suppressing observations and effects", () => {
	const initial = createInitialPresenceState(members, "lead", { notifications: false });
	const result = apply(initial, { type: "observation", memberName: "dev", online: true });
	assert.deepEqual(result, { state: initial, effects: [] });
});
