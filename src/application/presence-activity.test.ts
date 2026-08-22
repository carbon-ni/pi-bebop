import test from "node:test";
import assert from "node:assert/strict";
import { emitCrewPresenceActivity } from "./presence-activity.ts";

const members = [
	{ identity: "lead", name: "lead", role: "lead" },
	{ identity: "dev", name: "dev", role: "developer" },
] as const;

test("presence effects become visible chat-only messages without turns", () => {
	const sent: unknown[] = [];
	emitCrewPresenceActivity(
		[
			{ type: "roster", members: [{ ...members[1], status: "online" }] },
			{ type: "joined", member: members[1] },
			{ type: "left", member: members[1] },
		],
		{ members, currentIdentity: "lead", notifications: true },
		(message, options) => sent.push({ message, options }),
	);
	assert.equal(sent.length, 3);
	assert.deepEqual((sent[0] as { message: { customType: string; display: boolean }; options: unknown }).message, {
		customType: "crew-presence",
		content: "[crew] Online (2): lead (you), dev (developer)",
		display: true,
	});
	assert.deepEqual((sent[0] as { options: unknown }).options, { triggerTurn: false });
});

test("spoofed transition labels are rejected against the local manifest", () => {
	let sends = 0;
	emitCrewPresenceActivity(
		[{ type: "joined", member: { identity: "dev", name: "spoof", role: "admin" } }],
		{ members, currentIdentity: "lead", notifications: true },
		() => {
			sends++;
		},
	);
	assert.equal(sends, 0);
});

test("disabled or absent membership produces zero activity", () => {
	let sends = 0;
	const effects = [{ type: "joined" as const, member: members[1] }];
	emitCrewPresenceActivity(effects, null, () => {
		sends++;
	});
	emitCrewPresenceActivity(effects, { members, currentIdentity: "lead", notifications: false }, () => {
		sends++;
	});
	assert.equal(sends, 0);
});
