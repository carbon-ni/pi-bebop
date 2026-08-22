import test from "node:test";
import assert from "node:assert/strict";
import { parseCrewManifest } from "../domain/index.ts";
import type { Membership } from "../infra/membership-runtime.ts";
import {
	appendMembershipContext,
	formatMembershipContext,
	getLatestMembershipState,
	MEMBERSHIP_ENTRY_TYPE,
	membershipStateFromRuntime,
} from "./membership-context.ts";

const manifestPath = "/project/.pi/intray/crew.json";
const manifest = parseCrewManifest(
	{
		version: 1,
		members: [
			{ name: "dev", role: "developer", socket: "sockets/dev.sock", instructions: "Build it" },
			{ name: "qa", role: "reviewer", socket: "sockets/qa.sock" },
		],
	},
	manifestPath,
);
const membership: Membership = {
	manifestPath,
	socketPath: "/project/.pi/intray/sockets/dev.sock",
	globalSocketPath: "/tmp/global.sock",
	member: manifest.members[0],
	manifest,
};

test("restores latest branch-aware active or inactive membership state", () => {
	const entries = [
		{ type: "custom", customType: MEMBERSHIP_ENTRY_TYPE, data: { active: true, socketPath: "/old.sock" } },
		{ type: "custom", customType: MEMBERSHIP_ENTRY_TYPE, data: { active: false, socketPath: "/old.sock" } },
		{
			type: "custom",
			customType: MEMBERSHIP_ENTRY_TYPE,
			data: { active: true, socketPath: membership.socketPath, manifestPath },
		},
	];
	assert.deepEqual(getLatestMembershipState(entries), {
		active: true,
		socketPath: membership.socketPath,
		manifestPath,
	});
	assert.deepEqual(membershipStateFromRuntime(membership), {
		active: true,
		socketPath: membership.socketPath,
		manifestPath,
	});
});

test("injects concise identity exactly once per system prompt", () => {
	const first = appendMembershipContext("Base system", membership);
	const second = appendMembershipContext(first, membership);
	assert.equal(first, second);
	assert.match(first, /Member: dev/);
	assert.match(first, /Role instructions: Build it/);
	assert.match(first, /Members: dev \(developer\), qa \(reviewer\)/);
});
