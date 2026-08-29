import test from "node:test";
import assert from "node:assert/strict";
import { createSocketState } from "./control-runtime.ts";
import { handleMessageEndQueuedFollowUp } from "./queued-follow-up-handoff.ts";
import { QueuedFollowUpAcceptanceRegistry, SESSION_MESSAGE_TYPE } from "../domain/index.ts";

function queuedMessage(details: Record<string, unknown>) {
	return {
		role: "custom" as const,
		customType: SESSION_MESSAGE_TYPE,
		content: "[follow-up] information only; no correlated Response expected.\n{}",
		display: true,
		details,
		timestamp: 1,
	};
}

const payload = {
	content: "old TASK-0011 update",
	origin: { kind: "crew" as const, name: "Dave", role: "dev" },
};

function stateWithPending(deliveryId: string, acceptedAt: number, handoffAt: number) {
	let now = acceptedAt;
	const registry = new QueuedFollowUpAcceptanceRegistry({ now: () => now });
	const state = createSocketState();
	state.queuedFollowUps = registry;
	registry.record(deliveryId);
	now = handoffAt;
	return state;
}

test("message_end replaces a pending queued follow-up with immutable handoff provenance", () => {
	const state = stateWithPending("delivery-7", 1_000, 1_000 + 14 * 60_000);
	const original = queuedMessage({ messagePayload: payload, deliveryId: "delivery-7" });
	const replacement = handleMessageEndQueuedFollowUp(state, original);
	assert.ok(replacement, "queued follow-up must be replaced at handoff");
	assert.equal(replacement.role, "custom");
	assert.equal(replacement.customType, SESSION_MESSAGE_TYPE);
	assert.ok(replacement.content.startsWith("[follow-up · queued 14m before delivery · uncorrelated]"));
	assert.match(replacement.content, /may predate newer coordination/);
	const provenance = (replacement.details as Record<string, unknown>).deliveryProvenance;
	assert.deepEqual(provenance, {
		deliveryId: "delivery-7",
		acceptedAt: 1_000,
		handoffAt: 1_000 + 14 * 60_000,
		queueDelay: "14m",
		disposition: "queued",
	});
	// Original object identity/content is untouched; the replacement is a new message.
	assert.ok(original.content.startsWith("[follow-up] information only"));
	assert.equal((original.details as Record<string, unknown>).deliveryProvenance, undefined);
});

test("message_end replacement is claimed exactly once", () => {
	const state = stateWithPending("delivery-7", 1_000, 2_000);
	const first = handleMessageEndQueuedFollowUp(
		state,
		queuedMessage({ messagePayload: payload, deliveryId: "delivery-7" }),
	);
	assert.ok(first);
	const second = handleMessageEndQueuedFollowUp(state, first);
	assert.equal(second, undefined, "a delivered message is never rewritten twice");
});

test("message_end leaves direct, steered, historical, and foreign messages byte-identical", () => {
	const state = stateWithPending("delivery-7", 1_000, 2_000);
	const cases: Array<{ label: string; message: unknown }> = [
		{ label: "direct follow-up (no seed)", message: queuedMessage({ messagePayload: payload }) },
		{
			label: "steered redirect (no seed)",
			message: { ...queuedMessage({ messagePayload: payload }), customType: SESSION_MESSAGE_TYPE },
		},
		{
			label: "unknown seed id",
			message: queuedMessage({ messagePayload: payload, deliveryId: "delivery-other" }),
		},
		{
			label: "historical provenance already attached",
			message: queuedMessage({
				messagePayload: payload,
				deliveryProvenance: {
					deliveryId: "delivery-7",
					acceptedAt: 1,
					handoffAt: 2,
					queueDelay: "1s",
					disposition: "queued",
				},
			}),
		},
		{ label: "member request kind", message: queuedMessage({ crewRequestId: "r1" }) },
		{ label: "other custom type", message: { ...queuedMessage({}), customType: "crew-presence" } },
		{ label: "assistant role", message: { role: "assistant", content: "hi" } },
	];
	for (const { label, message } of cases) {
		assert.equal(handleMessageEndQueuedFollowUp(state, message), undefined, label);
	}
});

test("message_end never replaces a seeded message with an invalid payload", () => {
	const state = stateWithPending("delivery-7", 1_000, 2_000);
	assert.equal(
		handleMessageEndQueuedFollowUp(state, queuedMessage({ messagePayload: { nope: 1 }, deliveryId: "delivery-7" })),
		undefined,
	);
});
