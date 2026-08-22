import test from "node:test";
import assert from "node:assert/strict";
import { chooseMembershipServerMode, prepareMembershipServer, releaseMembershipBeforeCleanup, restorePersistedMembership } from "./membership-lifecycle.ts";
import { MEMBERSHIP_ENTRY_TYPE, getLatestMembershipState } from "./membership-context.ts";

const membership = { member: { name: "dev", role: "developer" }, socketPath: "/crew/dev.sock" } as never;

function persisted(active: boolean) {
	return { active, socketPath: "/crew/dev.sock", manifestPath: "/crew/crew.json" };
}

test("persisted restore and explicit startup selection use ensure-only server mode", async () => {
	assert.equal(chooseMembershipServerMode({ controlRequested: false, configEnabled: false, startupSocketSelected: false, persistedMembershipActive: true }), "ensure");
	assert.equal(chooseMembershipServerMode({ controlRequested: false, configEnabled: false, startupSocketSelected: true, persistedMembershipActive: false }), "ensure");
	assert.equal(chooseMembershipServerMode({ controlRequested: true, configEnabled: false, startupSocketSelected: false, persistedMembershipActive: false }), "enable");
	assert.equal(chooseMembershipServerMode({ controlRequested: false, configEnabled: false, startupSocketSelected: false, persistedMembershipActive: false }), "disable");
	let ensured = false;
	let enabled = false;
	await prepareMembershipServer("ensure", { ensure: async () => { ensured = true; }, enable: async () => { enabled = true; }, disable: async () => undefined });
	assert.equal(ensured, true);
	assert.equal(enabled, false);
});

test("latest branch state supports active restore and inactive resume/fork state", () => {
	const active = getLatestMembershipState([
		{ type: "custom", customType: MEMBERSHIP_ENTRY_TYPE, data: persisted(true) },
	]);
	assert.deepEqual(active, persisted(true));
	const inactive = getLatestMembershipState([
		{ type: "custom", customType: MEMBERSHIP_ENTRY_TYPE, data: persisted(true) },
		{ type: "custom", customType: MEMBERSHIP_ENTRY_TYPE, data: persisted(false) },
	]);
	assert.deepEqual(inactive, persisted(false));
});

test("restores active membership, skips inactive and startup-overridden selections", async () => {
	let joins = 0;
	const announcements: string[] = [];
	const failures: string[] = [];
	const deps = {
		runtime: { join: async () => { joins += 1; return { ok: true, membership }; } },
		globalSocketPath: "/crew/global.sock",
		manifestPathForSocket: () => "/crew/crew.json",
		announce: (message: string) => announcements.push(message),
		reportFailure: (message: string) => failures.push(message),
	};
	assert.equal(await restorePersistedMembership({ ...deps, persisted: persisted(true), startupSocketSelected: false }), true);
	assert.equal(await restorePersistedMembership({ ...deps, persisted: persisted(false), startupSocketSelected: false }), false);
	assert.equal(await restorePersistedMembership({ ...deps, persisted: persisted(true), startupSocketSelected: true }), false);
	assert.equal(joins, 1);
	assert.equal(announcements.length, 1);
	assert.deepEqual(failures, []);
});

test("failed or unavailable restore reports failure without creating identity", async () => {
	let joins = 0;
	const failures: string[] = [];
	const restored = await restorePersistedMembership({
		runtime: { join: async () => { joins += 1; return { ok: false, error: new Error("endpoint is occupied") }; } },
		persisted: persisted(true),
		startupSocketSelected: false,
		globalSocketPath: "/crew/global.sock",
		manifestPathForSocket: () => "/crew/crew.json",
		announce: () => assert.fail("failed restore must not announce identity"),
		reportFailure: (message) => failures.push(message),
	});
	assert.equal(restored, false);
	assert.equal(joins, 1);
	assert.deepEqual(failures, ["endpoint is occupied"]);
});

test("shutdown cleanup runs even when membership release fails and reports the failure", async () => {
	let cleanup = 0;
	const failures: string[] = [];
	await releaseMembershipBeforeCleanup({
		hasMembership: true,
		leave: async () => ({ ok: false, error: new Error("release failed") }),
		cleanup: async () => { cleanup += 1; },
		reportFailure: (message) => failures.push(message),
	});
	assert.equal(cleanup, 1);
	assert.deepEqual(failures, ["Intray membership release failed: release failed"]);
});

test("shutdown cleanup reports thrown release failures and still cleans up", async () => {
	let cleanup = 0;
	const failures: string[] = [];
	await releaseMembershipBeforeCleanup({
		hasMembership: true,
		leave: async () => { throw new Error("release threw"); },
		cleanup: async () => { cleanup += 1; },
		reportFailure: (message) => failures.push(message),
	});
	assert.equal(cleanup, 1);
	assert.deepEqual(failures, ["Intray membership release failed: release threw"]);
});
