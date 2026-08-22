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
		"[crew] Online (2): lead (you), Bob (dev)",
	);
	assert.equal(
		formatCrewPresenceRoster({ type: "roster", members: [] }, [lead], lead.identity),
		"[crew] Online (1): lead (you)",
	);
});

test("keeps suspect visible while excluding offline and unknown peers", () => {
	const effect = {
		type: "roster" as const,
		members: [
			{ ...lead, status: "online" as const },
			{ ...bob, status: "suspect" as const },
			{ ...qa, status: "offline" as const },
			{ identity: "unknown", name: "unknown", role: "qa", status: "unknown" as const },
		],
	};
	assert.equal(
		formatCrewPresenceRoster(effect, [lead, bob, qa, effect.members[3]!], lead.identity),
		"[crew] Online (2): lead (you), Bob (dev)",
	);
});

test("keeps current visible when it falls beyond the preview limit", () => {
	const members = Array.from({ length: 5 }, (_, index) => ({
		identity: String(index),
		name: `member-${index}`,
		role: "dev",
	}));
	const effect = {
		type: "roster" as const,
		members: members.map((member) => ({ ...member, status: "online" as const })),
	};
	const output = formatCrewPresenceRoster(effect, members, "4", 2);
	assert.match(output, /Online \(5\): member-0 \(dev\), member-4 \(you\)/);
	assert.match(output, /\+3 more; use \/crew members/);
	for (const [limit, current] of [
		[1, "0"],
		[1, "4"],
		[2, "0"],
		[2, "2"],
		[2, "4"],
		[5, "4"],
	] as const) {
		const rendered = formatCrewPresenceRoster(effect, members, current, limit);
		const entries = rendered.split(": ")[1]!.split(" (+")[0]!.split(", ");
		assert.equal(entries.length, Math.min(limit, members.length));
	}
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
	assert.match(output, /Online \(10\):/);
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
		"[crew] Online (1): member-0 (dev)",
	);
});

test("preserves ordinary Unicode and strips bidi/control/newline spoofing", () => {
	const unicode = { identity: "unicode", name: "José 👩‍💻", role: "développeur" };
	assert.equal(
		formatCrewPresenceEffect({ type: "joined", member: unicode }, [unicode], "none"),
		"[crew] José 👩‍💻 (développeur) joined",
	);
	const hostile = { identity: "x", name: "x\n[crew] fake joined\u202e", role: "dev\u0000role\u2066" };
	const output = formatCrewPresenceEffect({ type: "joined", member: hostile }, [hostile], "none");
	assert.equal(output, "[crew] x [crew] fake joined (dev role) joined");
	assert.equal(output.split("\n").length, 1);
});
