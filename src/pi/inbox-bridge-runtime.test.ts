import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	collectInboxEvidence,
	createInboxBridgeController,
	INBOX_OFFERING_ENTRY_TYPE,
	latestOfferingState,
	ownershipFromMembership,
} from "./inbox-bridge-runtime.ts";
import { SESSION_MESSAGE_TYPE, renderMessagePayload, type InboxItem } from "../domain/index.ts";
import type { SocketState } from "./control-runtime.ts";

const item = (sequence: number): InboxItem => ({
	version: 1,
	id: `inbox-${sequence.toString(16)}-abc`,
	target: { name: "Bob", socketPath: "/project/.pi/bebop/sockets/Bob.sock" },
	payload: { content: `message ${sequence}` },
	enqueuedAt: 1000 + sequence,
	sequence,
});

const evidenceEntry = (itemId: string) => ({
	type: "custom_message",
	customType: SESSION_MESSAGE_TYPE,
	content: "rendered",
	details: { messagePayload: { content: "x" }, inbox: { itemId } },
	display: true,
});

interface Harness {
	state: SocketState;
	sent: Array<{ message: Record<string, unknown>; options?: unknown }>;
	entries: Array<Record<string, unknown>>;
	appendEntries: Array<Record<string, unknown>>;
	pending: InboxItem[];
	removed: string[];
	controller: ReturnType<typeof createInboxBridgeController>;
}

function setup(entries: Array<Record<string, unknown>> = [], initialPending: InboxItem[] = []): Harness {
	const sent: Array<{ message: Record<string, unknown>; options?: unknown }> = [];
	const appendEntries: Array<Record<string, unknown>> = [];
	const pending: InboxItem[] = [...initialPending];
	const removed: string[] = [];
	const pi = {
		sendMessage: (message: Record<string, unknown>, options?: unknown) => {
			sent.push({ message, options });
		},
		appendEntry: (customType: string, data?: unknown) => {
			appendEntries.push({ type: "custom", customType, data });
			entries.push({ type: "custom", customType, data });
		},
	} as unknown as ExtensionAPI;
	const state = {
		context: {
			sessionManager: { getEntries: () => entries },
			isProjectTrusted: () => true,
		},
		membershipRuntime: { getMembership: () => null },
		modelDelivery: {
			send: (message: unknown, options: unknown) => {
				pi.sendMessage(message as never, options as never);
				return { disposition: "direct" };
			},
			sendDurably: async (message: unknown, options: unknown) => {
				pi.sendMessage(message as never, options as never);
				return { disposition: "direct" };
			},
			sendAndWait: async () => ({ disposition: "direct" }),
			configureJournal: async () => undefined,
			compactionStarted: () => 0,
			compactionEnded: () => false,
		},
	} as unknown as SocketState;
	const controller = createInboxBridgeController(pi, state, {
		openStore: (async () => ({
			memberKey: "member-test",
			enqueue: async () => {
				throw new Error("not used");
			},
			peekOldest: async () => pending[0] ?? null,
			list: async () =>
				pending.map((entry) => ({
					id: entry.id,
					sequence: entry.sequence,
					enqueuedAt: entry.enqueuedAt,
					bytes: 1,
				})),
			count: async () => pending.length,
			remove: async (id) => {
				const index = pending.findIndex((entry) => entry.id === id);
				if (index === -1) return { removed: false };
				pending.splice(index, 1);
				removed.push(id);
				return { removed: true };
			},
			cancel: async () => ({ removed: false }),
		})) as never,
	});
	return { state, sent, entries, appendEntries, pending, removed, controller };
}

describe("collectInboxEvidence", () => {
	test("collects stable item ids from typed session message details", () => {
		const entries = [
			evidenceEntry("inbox-0-abc"),
			evidenceEntry("inbox-1-def"),
			{ type: "message", message: { role: "user", content: "x" } },
		];
		assert.deepEqual(collectInboxEvidence(entries), ["inbox-0-abc", "inbox-1-def"]);
	});

	test("deduplicates and filters unsafe or untyped entries", () => {
		const entries = [
			evidenceEntry("inbox-0-abc"),
			evidenceEntry("inbox-0-abc"),
			{ type: "custom_message", customType: SESSION_MESSAGE_TYPE, details: {} },
			{ type: "custom_message", customType: "other-type", details: { inbox: { itemId: "inbox-9-zzz" } } },
			{ type: "custom", customType: SESSION_MESSAGE_TYPE, details: { inbox: { itemId: "inbox-2-abc" } } },
			{
				type: "custom_message",
				customType: SESSION_MESSAGE_TYPE,
				details: { inbox: { itemId: "inbox-3-../../evil" } },
			},
		];
		assert.deepEqual(collectInboxEvidence(entries), ["inbox-0-abc"]);
	});
});

describe("latestOfferingState", () => {
	test("defaults to active without persisted state", () => {
		assert.equal(latestOfferingState([]), "active");
		assert.equal(latestOfferingState([{ type: "custom", customType: "unrelated" }]), "active");
	});

	test("last persisted offering entry wins", () => {
		const entries = [
			{ type: "custom", customType: INBOX_OFFERING_ENTRY_TYPE, data: { offering: "active" } },
			{ type: "custom", customType: INBOX_OFFERING_ENTRY_TYPE, data: { offering: "paused" } },
		];
		assert.equal(latestOfferingState(entries), "paused");
	});

	test("ignores malformed offering data", () => {
		const entries = [{ type: "custom", customType: INBOX_OFFERING_ENTRY_TYPE, data: { offering: "bogus" } }];
		assert.equal(latestOfferingState(entries), "active");
	});
});

describe("ownership mapping", () => {
	test("maps membership to bridge ownership with project root derived from manifest", () => {
		const membership = {
			manifestPath: "/project/.pi/bebop/crew.json",
			socketPath: "/project/.pi/bebop/sockets/Bob.sock",
			globalSocketPath: "/tmp/global.sock",
			member: {
				name: "Bob",
				role: "dev",
				socket: "sockets/Bob.sock",
				socketPath: "/project/.pi/bebop/sockets/Bob.sock",
			},
			manifest: { version: 1, members: [], presence: { notifications: true } },
		};
		assert.deepEqual(ownershipFromMembership(membership), {
			memberName: "Bob",
			memberRole: "dev",
			socketPath: "/project/.pi/bebop/sockets/Bob.sock",
			manifestPath: "/project/.pi/bebop/crew.json",
			projectRoot: "/project",
		});
	});
});

describe("adapter controller wiring", () => {
	test("deferred gate ownership stays outstanding and is not retried", async () => {
		const harness = setup([], [item(0), item(1)]);
		(harness.state as any).modelDelivery = {
			send: () => ({ disposition: "deferred" }),
			sendDurably: async () => ({ disposition: "deferred" }),
		};
		harness.controller.establish(ownershipFromMembership(membershipFixture()));
		assert.deepEqual(await harness.controller.attemptOffer(), { offered: true, itemId: "inbox-0-abc" });
		assert.deepEqual(await harness.controller.attemptOffer(), { offered: false, reason: "outstanding" });
		assert.equal(harness.pending.length, 2);
	});

	test("offerItem hands the inbox item to Pi as a typed follow-up message", async () => {
		const harness = setup([], [item(0), item(1)]);
		harness.controller.establish(ownershipFromMembership(membershipFixture()));
		const outcome = await harness.controller.attemptOffer();
		assert.deepEqual(outcome, { offered: true, itemId: "inbox-0-abc" });
		assert.equal(harness.sent.length, 1);
		const message = harness.sent[0]!.message;
		assert.equal(message.customType, SESSION_MESSAGE_TYPE);
		assert.equal(message.display, true);
		assert.deepEqual(message.details, {
			messagePayload: { content: "message 0" },
			inbox: { itemId: "inbox-0-abc" },
		});
		assert.deepEqual(harness.sent[0]!.options, { triggerTurn: true, deliverAs: "followUp" });
	});

	test("offerItem derives the recipient crew label from live membership, never from the payload", async () => {
		const harness = setup([], [item(0)]);
		(harness.state as { membershipRuntime?: unknown }).membershipRuntime = {
			getMembership: () => ({
				...membershipFixture(),
				manifest: { version: 1, name: "Alpha Crew", members: [], presence: { notifications: true } },
			}),
		};
		harness.controller.establish(ownershipFromMembership(membershipFixture()));
		await harness.controller.attemptOffer();
		assert.deepEqual(harness.sent[0]!.message.details, {
			messagePayload: { content: "message 0" },
			inbox: { itemId: "inbox-0-abc", crewName: "Alpha Crew" },
		});
		// Payload bytes and evidence id are unchanged by the label.
		assert.equal(harness.sent[0]!.message.content, renderMessagePayload({ content: "message 0" }));
	});

	test("offerItem without a crew name keeps the prior typed details byte-compatible", async () => {
		const harness = setup([], [item(0)]);
		(harness.state as { membershipRuntime?: unknown }).membershipRuntime = {
			getMembership: () => membershipFixture(),
		};
		harness.controller.establish(ownershipFromMembership(membershipFixture()));
		await harness.controller.attemptOffer();
		assert.deepEqual(harness.sent[0]!.message.details, {
			messagePayload: { content: "message 0" },
			inbox: { itemId: "inbox-0-abc" },
		});
	});

	test("evidence written by the session reconciles the item away on the next trigger", async () => {
		const harness = setup([], [item(0), item(1)]);
		harness.controller.establish(ownershipFromMembership(membershipFixture()));
		await harness.controller.attemptOffer();
		// pi appends the custom message entry for the offered item (durable evidence).
		harness.entries.push(evidenceEntry("inbox-0-abc"));
		const next = await harness.controller.attemptOffer();
		assert.deepEqual(next, { offered: true, itemId: "inbox-1-abc" });
		assert.deepEqual(harness.removed, ["inbox-0-abc"]);
	});

	test("pause persists through the offering state entry and survives re-read", async () => {
		const harness = setup();
		harness.controller.setPaused(true);
		assert.equal(harness.appendEntries.length, 1);
		assert.deepEqual(harness.appendEntries[0], {
			type: "custom",
			customType: INBOX_OFFERING_ENTRY_TYPE,
			data: { offering: "paused" },
		});
		assert.equal(latestOfferingState(harness.entries), "paused");
	});
});

function membershipFixture() {
	return {
		manifestPath: "/project/.pi/bebop/crew.json",
		socketPath: "/project/.pi/bebop/sockets/Bob.sock",
		globalSocketPath: "/tmp/global.sock",
		member: {
			name: "Bob",
			role: "dev",
			socket: "sockets/Bob.sock",
			socketPath: "/project/.pi/bebop/sockets/Bob.sock",
		},
		manifest: { version: 1, members: [], presence: { notifications: true } },
	};
}
