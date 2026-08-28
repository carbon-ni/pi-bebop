import assert from "node:assert/strict";
import test from "node:test";
import {
	MAX_SESSION_NAME_STATE_BYTES,
	SESSION_NAME_ENTRY_TYPE,
	getLatestSessionNameState,
	observeSessionNameChange,
	reconcileSessionName,
	sessionNameStateToEntryData,
	type SessionNameMembership,
	type SessionNameState,
} from "./session-name-ownership.ts";

const membership = (overrides: Partial<SessionNameMembership> = {}): SessionNameMembership => ({
	manifestPath: "/project/.pi/bebop/crew.json",
	socketPath: "/project/.pi/bebop/sockets/mary.sock",
	memberName: "Mary",
	memberRole: "qa",
	...overrides,
});

const inactive: SessionNameState = { ownership: "inactive" };

function auto(overrides: Partial<Extract<SessionNameState, { ownership: "auto" }>> = {}): SessionNameState {
	return { ownership: "auto", sessionName: "Mary", membership: membership(), ...overrides };
}

test("unnamed inactive session adopts exact member name", () => {
	assert.deepEqual(reconcileSessionName(inactive, membership(), undefined), {
		state: auto(),
		action: { type: "set", name: "Mary" },
	});
});

test("existing name is preserved as user-owned", () => {
	assert.deepEqual(reconcileSessionName(inactive, membership(), "My task"), {
		state: { ownership: "user", sessionName: "My task", membership: membership() },
		action: { type: "none" },
	});
});

test("same-member role change is idempotent while refreshing the snapshot", () => {
	assert.deepEqual(reconcileSessionName(auto(), membership({ memberRole: "developer" }), "Mary"), {
		state: auto({ membership: membership({ memberRole: "developer" }) }),
		action: { type: "none" },
	});
});

test("auto-owned name follows a Current Member switch", () => {
	const next = membership({
		memberName: "Kelly",
		memberRole: "developer",
		socketPath: "/project/.pi/bebop/sockets/kelly.sock",
	});
	assert.deepEqual(reconcileSessionName(auto(), next, "Mary"), {
		state: { ownership: "auto", sessionName: "Kelly", membership: next },
		action: { type: "set", name: "Kelly" },
	});
});

test("manual change, including explicit clear, relinquishes ownership", () => {
	const changed = reconcileSessionName(auto(), membership(), "Manual");
	assert.deepEqual(changed.state, { ownership: "user", sessionName: "Manual", membership: membership() });
	assert.deepEqual(observeSessionNameChange(changed.state, undefined), {
		ownership: "user",
		membership: membership(),
	});
});

test("leave clears only a matching auto-owned name", () => {
	assert.deepEqual(reconcileSessionName(auto(), null, "Mary"), {
		state: inactive,
		action: { type: "clear" },
	});
	assert.deepEqual(reconcileSessionName(auto(), null, "Manual"), {
		state: { ownership: "user", sessionName: "Manual", membership: membership() },
		action: { type: "none" },
	});
});

test("valid typed snapshots restore, while malformed or oversized entries do not", () => {
	const state = auto();
	const entry = { type: "custom", customType: SESSION_NAME_ENTRY_TYPE, data: sessionNameStateToEntryData(state) };
	assert.deepEqual(getLatestSessionNameState([entry]), state);
	assert.equal(getLatestSessionNameState([{ ...entry, data: { ...entry.data, version: 2 } }]), null);
	assert.equal(getLatestSessionNameState([{ ...entry, data: { ...entry.data, sessionName: "x\nmanual" } }]), null);
	assert.equal(
		getLatestSessionNameState([
			{ ...entry, data: { ...entry.data, sessionName: "x".repeat(MAX_SESSION_NAME_STATE_BYTES) } },
		]),
		null,
	);
});

test("oversized manual names relinquish ownership without creating oversized metadata", () => {
	const state = auto();
	const oversized = "x".repeat(257);
	assert.deepEqual(reconcileSessionName(state, membership(), oversized), {
		state: { ownership: "user", membership: membership() },
		action: { type: "none" },
	});
});

test("latest invalid typed snapshot is not replaced by text equality", () => {
	const state = auto();
	const valid = { type: "custom", customType: SESSION_NAME_ENTRY_TYPE, data: sessionNameStateToEntryData(state) };
	const invalid = {
		type: "custom",
		customType: SESSION_NAME_ENTRY_TYPE,
		data: { ownership: "auto", sessionName: "Mary" },
	};
	assert.equal(getLatestSessionNameState([valid, invalid]), null);
});
