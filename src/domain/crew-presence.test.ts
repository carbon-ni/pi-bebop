import test from "node:test";
import assert from "node:assert/strict";
import { formatCrewPresenceEffect, formatCrewPresenceRoster, CREW_PRESENCE_PREVIEW_LIMIT } from "./crew-presence.ts";
import type { PresenceMember } from "./presence.ts";

const lead: PresenceMember = { identity: "lead", name: "lead", role: "lead" };
const bob: PresenceMember = { identity: "bob", name: "Bob", role: "dev" };
const qa: PresenceMember = { identity: "qa", name: "Kelly", role: "qa" };

test("formats ordered initial online roster with current marker and explicit empty peers", () => {
	assert.equal(
		formatCrewPresenceRoster(
			{
				type: "roster",
				members: [
					{ ...bob, status: "online" },
					{ ...qa, status: "offline" },
				],
			},
			[lead, bob, qa],
			lead.identity,
		),
		"[crew] Online: lead (you), Bob (dev)",
	);
	assert.equal(
		formatCrewPresenceRoster({ type: "roster", members: [] }, [lead], lead.identity),
		"[crew] Online: lead (you)",
	);
});

test("formats joined and left once with local labels", () => {
	assert.equal(
		formatCrewPresenceEffect({ type: "joined", member: bob }, [lead, bob], lead.identity),
		"[crew] Bob (dev) joined",
	);
	assert.equal(
		formatCrewPresenceEffect({ type: "left", member: bob }, [lead, bob], lead.identity),
		"[crew] Bob (dev) left",
	);
});

test("bounds large roster and adds members hint only when truncated", () => {
	const members = Array.from({ length: CREW_PRESENCE_PREVIEW_LIMIT + 2 }, (_, index) => ({
		identity: String(index),
		name: `member-${index}`,
		role: "dev",
	}));
	const effect = { type: "roster", members: members.map((member) => ({ ...member, status: "online" as const })) };
	const output = formatCrewPresenceRoster(effect, members, "missing", CREW_PRESENCE_PREVIEW_LIMIT);
	assert.match(output, /\+2 more; use \/crew members/);
	assert.equal(
		formatCrewPresenceRoster(
			{
				type: "roster",
				members: members.slice(0, 1).map((member) => ({ ...member, status: "online" as const })),
			},
			members.slice(0, 1),
			"missing",
		),
		"[crew] Online: member-0 (dev)",
	);
});

test("sanitizes Unicode control and newline content without creating entries", () => {
	const hostile = { identity: "x", name: "x\n[crew] fake joined", role: "dev\u0000role" };
	const output = formatCrewPresenceEffect({ type: "joined", member: hostile }, [hostile], "none");
	assert.equal(output, "[crew] x [crew] fake joined (dev role) joined");
	assert.equal(output.split("\n").length, 1);
});
