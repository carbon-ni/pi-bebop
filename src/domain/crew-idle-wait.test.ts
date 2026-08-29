import test from "node:test";
import assert from "node:assert/strict";
import { Value } from "@sinclair/typebox/value";
import {
	CrewIdleWaitInputSchema,
	CrewIdleWaitResultSchema,
	MAX_CREW_IDLE_WAIT_MEMBER_BYTES,
	MAX_CREW_IDLE_WAIT_MEMBERS,
	resolveCrewIdleSelection,
} from "./crew-idle-wait.ts";

const manifest = {
	member: { name: "Mony", role: "lead", socketPath: "/mony.sock" },
	manifest: {
		members: [
			{ name: "Mony", role: "lead", socketPath: "/mony.sock" },
			{ name: "Dave", role: "dev", socketPath: "/dave.sock" },
			{ name: "Kelly", role: "qa", socketPath: "/kelly.sock" },
		],
	},
};

test("crew idle selection snapshots all other members in manifest order", () => {
	assert.deepEqual(resolveCrewIdleSelection(manifest, undefined), {
		scope: "all",
		targets: manifest.manifest.members.slice(1),
		coversAllOtherMembers: true,
	});
	assert.deepEqual(resolveCrewIdleSelection(manifest, ["Kelly", "Dave"]), {
		scope: "selected",
		targets: manifest.manifest.members.slice(1),
		coversAllOtherMembers: true,
	});
	assert.equal(resolveCrewIdleSelection(manifest, ["Dave"]).coversAllOtherMembers, false);
});

test("crew idle selection rejects empty, duplicate, role, unknown, and self labels", () => {
	for (const members of [[], ["Dave", "Dave"], ["dev"], ["Nobody"], ["Mony"]]) {
		assert.throws(() => resolveCrewIdleSelection(manifest, members));
	}
});

test("crew idle schemas are closed and bounded", () => {
	assert.equal(MAX_CREW_IDLE_WAIT_MEMBERS, 32);
	assert.equal(MAX_CREW_IDLE_WAIT_MEMBER_BYTES, 256);
	assert.equal(CrewIdleWaitInputSchema.additionalProperties, false);
	assert.equal(CrewIdleWaitResultSchema.additionalProperties, false);
	assert.equal(Value.Check(CrewIdleWaitInputSchema, { members: ["Dave"], timeout_seconds: 60 }), true);
	assert.equal(Value.Check(CrewIdleWaitInputSchema, { members: ["Dave"], timeoutSeconds: 60 }), false);
	assert.equal(
		Value.Check(CrewIdleWaitInputSchema, {
			members: Array.from({ length: MAX_CREW_IDLE_WAIT_MEMBERS + 1 }, (_, index) => `Member-${index}`),
		}),
		false,
	);
	const oversizedName = "é".repeat(MAX_CREW_IDLE_WAIT_MEMBER_BYTES);
	const byteBoundManifest = {
		member: manifest.member,
		manifest: { members: [manifest.member, { name: oversizedName, role: "dev", socketPath: "/oversized.sock" }] },
	};
	assert.throws(() => resolveCrewIdleSelection(byteBoundManifest, [oversizedName]));
	assert.doesNotThrow(() => resolveCrewIdleSelection(manifest, ["Dave"]));
});
