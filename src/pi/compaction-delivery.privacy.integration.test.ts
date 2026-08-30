import test from "node:test";
import assert from "node:assert/strict";
import { emitCrewPresenceActivity } from "../application/presence-activity.ts";
import { handleMemberStatus } from "./command-handlers/member-status.ts";
import { handleWaitState } from "./command-handlers/wait-state.ts";
import { handlerContext, joinedMembership } from "./command-handlers/test-support.ts";
import { renderCrewRoster } from "./control-commands.ts";
import { BlockingWaitSlot } from "../domain/index.ts";
import { createModelDeliveryAdapter } from "./compaction-delivery.ts";

const INTERNAL_MARKERS = /compactionGeneration|replayAttempts|journal|deliveryGate|socketPath|deferredJournals/iu;

function assertPublic(value: unknown, surface: string): void {
	assert.doesNotMatch(JSON.stringify(value), INTERNAL_MARKERS, `${surface} leaked internal delivery metadata`);
}

test("public coordination surfaces omit compaction and journal metadata end to end", async () => {
	const status = handlerContext();
	status.state.membershipRuntime = { getMembership: () => joinedMembership() } as never;
	await handleMemberStatus({ type: "member_status", member: "Mary", id: "status" }, status);
	assertPublic(status.responses[0], "Member Status");

	const wait = handlerContext();
	wait.state.membershipRuntime = { getMembership: () => joinedMembership() } as never;
	wait.ctx.isProjectTrusted = () => true;
	wait.state.blockingWait = new BlockingWaitSlot({ now: () => "2026-04-13T00:00:00.000Z" });
	await handleWaitState({ type: "wait_state", member: "Mary", id: "wait" }, wait);
	assertPublic(wait.responses[0], "wait-state");

	const presence: unknown[] = [];
			emitCrewPresenceActivity(
		[{ type: "joined", member: { identity: "mary", name: "Mary", role: "po" } }],
		{
			members: [{ identity: "mary", name: "Mary", role: "po" }],
			currentIdentity: "dave",
			notifications: true,
		},
		(message, options) => presence.push({ message, options }),
	);
	assertPublic(presence, "Presence");

	const state = handlerContext().state;
	state.membershipRuntime = {
		getMembership: () => ({
			...joinedMembership(),
			manifestPath: "/tmp/crew/crew.json",
			manifest: { name: "project", version: 1, members: joinedMembership().manifest.members },
		}),
	} as never;
	const roster = await renderCrewRoster(state, { probeMemberEndpoint: async () => false });
	assertPublic(roster, "Crew");

	const adapter = createModelDeliveryAdapter(() => undefined);
	adapter.compactionStarted();
	const outcomes = Array.from({ length: 65 }, (_, index) =>
		adapter.send({ customType: "probe", content: `capacity-${index}` }),
	);
	assert.equal(outcomes.at(-1)?.disposition, "capacity-exceeded");
	assertPublic(outcomes.at(-1), "capacity");
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	const error = adapter.send(cyclic);
	assert.equal(error.disposition, "invalid");
	assertPublic(error, "error");
});
