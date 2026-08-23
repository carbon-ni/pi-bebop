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
	assert.doesNotMatch(first, /message-context|per-message|Reply with evidence/);
});

test("joined context lists manifest-order name (role): description, keeping others concise and instructions separate", () => {
	const withDescription = parseCrewManifest(
		{
			version: 1,
			members: [
				{
					name: "Bob",
					role: "developer",
					socket: "sockets/bob.sock",
					description: "Builds domain and application changes",
				},
				{ name: "Kelly", role: "qa", socket: "sockets/kelly.sock" },
				{
					name: "Dave",
					role: "developer",
					socket: "sockets/dave.sock",
					description: "Focuses on infra",
					instructions: "Secret role guidance",
				},
			],
		},
		manifestPath,
	);
	const joined: Membership = {
		manifestPath,
		socketPath: "/project/.pi/intray/sockets/bob.sock",
		globalSocketPath: "/tmp/global.sock",
		member: withDescription.members[0],
		manifest: withDescription,
	};
	const rendered = formatMembershipContext(joined);
	// Manifest order preserved; described members get ": description", others stay concise.
	assert.match(
		rendered,
		/Members: Bob \(developer\): Builds domain and application changes, Kelly \(qa\), Dave \(developer\): Focuses on infra/,
	);
	// Role instructions remain a separate section, never merged into the roster list.
	assert.doesNotMatch(rendered, /Secret role guidance/);
	assert.match(rendered, /Role: developer/);
});

test("membership context without descriptions stays byte-compatible with prior concise form", () => {
	const plain = formatMembershipContext(membership);
	assert.match(plain, /Members: dev \(developer\), qa \(reviewer\)\nRole instructions: Build it/);
	// No member gains a ": description" suffix when none is configured.
	assert.doesNotMatch(plain, /\(developer\): |\(reviewer\): /);
});
