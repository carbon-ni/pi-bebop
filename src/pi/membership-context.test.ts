import test from "node:test";
import assert from "node:assert/strict";
import { parseCrewManifest } from "../domain/index.ts";
import type { Membership } from "../infra/membership-runtime.ts";
import { createGuestMembershipRuntime } from "../infra/guest-membership-runtime.ts";
import {
	appendMembershipContext,
	formatMembershipContext,
	getLatestMembershipState,
	MEMBERSHIP_ENTRY_TYPE,
	membershipStateFromRuntime,
	appendGuestMembershipContext,
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

test("Guest context separates approved admission from presence and hides routes/capabilities", () => {
	const runtime = createGuestMembershipRuntime({
		guestIdentity: "guest-session",
		callbackEndpoint: "/private/callback.sock",
		createRequestId: () => "request-1",
		submitJoinRequest: async () => undefined,
	});
	runtime.track(
		{
			crew: { id: "alpha", displayName: "Alpha" },
			guestName: "Alex",
			memberSocket: "/private/member.sock",
			submittedByMember: "lead",
		},
		"request-1",
		"approved",
		"secret-capability",
	);
	const rendered = appendGuestMembershipContext("Base system", runtime);
	assert.match(rendered, /alpha \(Alpha\) — approved/);
	assert.match(rendered, /Presence is separate from approval/);
	assert.doesNotMatch(rendered, /private\/(callback|member)\.sock|secret-capability/);
	assert.equal(appendGuestMembershipContext(rendered, runtime), rendered);
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

test("common crew instructions precede role instructions exactly once", () => {
	const parsed = parseCrewManifest(
		{
			version: 2,
			commonInstructionsFile: "instructions/common.md",
			members: [
				{ name: "dev", role: "developer", socket: "sockets/dev.sock", instructions: "Role rules" },
				{ name: "qa", role: "reviewer", socket: "sockets/qa.sock" },
			],
		},
		manifestPath,
	);
	const joined: Membership = {
		manifestPath,
		socketPath: "/project/.pi/intray/sockets/dev.sock",
		globalSocketPath: "/tmp/global.sock",
		member: parsed.members[0],
		manifest: { ...parsed, commonInstructions: "Common crew rules" },
	};
	const first = appendMembershipContext("Base system", joined);
	const second = appendMembershipContext(first, joined);
	assert.equal(first, second);
	assert.equal(
		first.indexOf("Common crew instructions: Common crew rules"),
		first.lastIndexOf("Common crew instructions: Common crew rules"),
	);
	assert.ok(first.indexOf("Common crew instructions:") < first.indexOf("Role instructions:"));
	assert.match(first, /Common crew instructions: Common crew rules/);
	assert.match(first, /Role instructions: Role rules/);
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
	assert.match(
		plain,
		/Members: dev \(developer\), qa \(reviewer\)\nCrew contact: none \(Crew Intake disabled\)\nCoordination: use send_member_request.*\nRole instructions: Build it/,
	);
	// No member gains a ": description" suffix when none is configured.
	assert.doesNotMatch(plain, /\(developer\): |\(reviewer\): /);
});

test("TASK-0076: coordination rule is one non-contradictory requester->wait / responder->respond rule", () => {
	const rendered = formatMembershipContext(membership);
	const coordination = rendered.split("\n").find((line) => line.startsWith("Coordination: ")) ?? "";
	// Requester sends and alone waits; Responder receives and alone responds.
	assert.match(coordination, /Requester/i);
	assert.match(coordination, /wait_for_request_outcome/i);
	assert.match(coordination, /Responder/i);
	assert.match(coordination, /respond_to_member_request/i);
	// Ordinary Follow-up stays information-only with no correlated Response expected.
	assert.match(coordination, /send_follow_up for information only/i);
	assert.match(coordination, /no correlated Response is expected/i);
	// The rule never relies on a Crew role such as lead/QA.
	assert.doesNotMatch(coordination, /\blead\b|\bqa\b|\bpo\b|\bdev\b/i);
});

test("joined context includes exactly one trusted Crew contact line when intake.contact is configured", () => {
	const configured = parseCrewManifest(
		{
			version: 1,
			intake: { contact: "Mary" },
			members: [
				{ name: "Bob", role: "developer", socket: "sockets/bob.sock" },
				{ name: "Mary", role: "product", socket: "sockets/mary.sock" },
				{ name: "Kelly", role: "qa", socket: "sockets/kelly.sock" },
			],
		},
		manifestPath,
	);
	const joined: Membership = {
		manifestPath,
		socketPath: "/project/.pi/intray/sockets/bob.sock",
		globalSocketPath: "/tmp/global.sock",
		member: configured.members[0],
		manifest: configured,
	};
	const rendered = formatMembershipContext(joined);
	// Exactly one contact line, matching configured member name and role.
	assert.equal(rendered.match(/Crew contact:/g)?.length, 1);
	assert.match(rendered, /Crew contact: Mary \(product\) — external Intake triage/);
	// Contact does not replace the roster or current identity.
	assert.match(rendered, /Member: Bob/);
	assert.match(rendered, /Members: Bob \(developer\), Mary \(product\), Kelly \(qa\)/);
});

test("joined context without intake shows the disabled line with no fallback", () => {
	const rendered = formatMembershipContext(membership);
	assert.equal(rendered.match(/Crew contact:/g)?.length, 1);
	assert.match(rendered, /Crew contact: none \(Crew Intake disabled\)/);
	// No lead/product/first/online member is inferred.
	assert.doesNotMatch(rendered, /Crew contact: dev|Crew contact: qa/);
});

test("same contact line renders whether current member is contact or another member", () => {
	const configured = parseCrewManifest(
		{
			version: 1,
			intake: { contact: "Mary" },
			members: [
				{ name: "Bob", role: "developer", socket: "sockets/bob.sock" },
				{ name: "Mary", role: "product", socket: "sockets/mary.sock" },
			],
		},
		manifestPath,
	);
	const asBob: Membership = {
		manifestPath,
		socketPath: "/project/.pi/intray/sockets/bob.sock",
		globalSocketPath: "/tmp/global.sock",
		member: configured.members[0],
		manifest: configured,
	};
	const asMary: Membership = {
		manifestPath,
		socketPath: "/project/.pi/intray/sockets/mary.sock",
		globalSocketPath: "/tmp/global.sock",
		member: configured.members[1],
		manifest: configured,
	};
	const bobLine = formatMembershipContext(asBob)
		.split("\n")
		.find((line) => line.startsWith("Crew contact:"));
	const maryLine = formatMembershipContext(asMary)
		.split("\n")
		.find((line) => line.startsWith("Crew contact:"));
	assert.equal(bobLine, "Crew contact: Mary (product) — external Intake triage");
	assert.equal(maryLine, "Crew contact: Mary (product) — external Intake triage");
});

test("contact line appears once per built system prompt and marker still prevents duplicate append", () => {
	const configured = parseCrewManifest(
		{
			version: 1,
			intake: { contact: "Mary" },
			members: [
				{ name: "Bob", role: "developer", socket: "sockets/bob.sock" },
				{ name: "Mary", role: "product", socket: "sockets/mary.sock" },
			],
		},
		manifestPath,
	);
	const joined: Membership = {
		manifestPath,
		socketPath: "/project/.pi/intray/sockets/bob.sock",
		globalSocketPath: "/tmp/global.sock",
		member: configured.members[0],
		manifest: configured,
	};
	const first = appendMembershipContext("Base system", joined);
	const second = appendMembershipContext(first, joined);
	assert.equal(first, second);
	assert.equal(first.match(/Crew contact:/g)?.length, 1);
});

test("contact line derives from the trusted manifest snapshot, not a duplicated role/name field or fallback", () => {
	// The contact name resolves through manifest.members; the rendered role comes
	// from that member's configured role, never from an inferred product/lead role.
	const configured = parseCrewManifest(
		{
			version: 1,
			intake: { contact: "Kelly" },
			members: [
				{ name: "Bob", role: "developer", socket: "sockets/bob.sock" },
				{ name: "Kelly", role: "reviewer", socket: "sockets/kelly.sock" },
			],
		},
		manifestPath,
	);
	const joined: Membership = {
		manifestPath,
		socketPath: "/project/.pi/intray/sockets/bob.sock",
		globalSocketPath: "/tmp/global.sock",
		member: configured.members[0],
		manifest: configured,
	};
	const rendered = formatMembershipContext(joined);
	assert.match(rendered, /Crew contact: Kelly \(reviewer\) — external Intake triage/);
});
