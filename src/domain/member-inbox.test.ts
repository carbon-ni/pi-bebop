import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	INBOX_VERSION,
	MAX_INBOX_ITEMS,
	cancelInboxItem,
	compareInboxItems,
	createInboxItemId,
	createMemberInbox,
	enqueueInboxItem,
	isInboxItem,
	isMemberInbox,
	nextInboxSequence,
	nextOfferableInboxItem,
	pendingInboxItemsAfterRestart,
	removeAcknowledgedInboxItems,
	setInboxOffering,
	type InboxItem,
	type MemberInbox,
	type MessagePayload,
} from "./index.ts";

const target = { name: "Bob", socketPath: "/repo/.pi/bebop/sockets/Bob.sock" };
const payload = (content: string, extra: Partial<MessagePayload> = {}): MessagePayload => ({
	content,
	...extra,
});

function inboxWith(count: number, content = "message"): MemberInbox {
	let inbox = createMemberInbox(target);
	for (let index = 0; index < count; index += 1) {
		const result = enqueueInboxItem(inbox, { payload: payload(`${content}-${index}`), now: 1000 });
		assert.equal(result.ok, true);
		inbox = result.inbox;
	}
	return inbox;
}

describe("member inbox schema", () => {
	test("valid item passes strict validation with minimal fields", () => {
		const inbox = inboxWith(1);
		const item = inbox.items[0] as InboxItem;
		assert.equal(isInboxItem(item), true);
		assert.equal(isMemberInbox(inbox), true);
		assert.equal(item.version, INBOX_VERSION);
		assert.deepEqual(item.target, target);
	});

	test("rejects wrong version, extra fields, empty or unsafe ids and targets", () => {
		const valid = inboxWith(1).items[0] as InboxItem;
		const invalidItems: unknown[] = [
			{ ...valid, version: 2 },
			{ ...valid, id: "" },
			{ ...valid, id: " id " },
			{ ...valid, id: "id\0" },
			{ ...valid, id: `${"x".repeat(129)}` },
			{ ...valid, target: { ...target, name: "" } },
			{ ...valid, target: { ...target, socketPath: " " } },
			{ ...valid, extra: true },
			{ ...valid, sequence: -1 },
			{ ...valid, sequence: 1.5 },
			{ ...valid, enqueuedAt: Number.NaN },
			{ ...valid, enqueuedAt: -1 },
			{ ...valid, payload: payload("   ") },
			{ ...valid, payload: payload("nul\0") },
			{ ...valid, payload: { ...payload("ok"), unknown: true } },
		];
		for (const value of invalidItems) assert.equal(isInboxItem(value), false);
	});

	test("inbox validation rejects duplicate ids, duplicate sequences, and foreign targets", () => {
		const inbox = inboxWith(2);
		const [first, second] = inbox.items as [InboxItem, InboxItem];
		assert.equal(isMemberInbox({ ...inbox, items: [first, first] }), false);
		assert.equal(isMemberInbox({ ...inbox, items: [first, { ...second, sequence: first.sequence }] }), false);
		assert.equal(
			isMemberInbox({
				...inbox,
				items: [
					first,
					{ ...second, target: { name: "Dave", socketPath: "/repo/.pi/bebop/sockets/Dave.sock" } },
				],
			}),
			false,
		);
		assert.equal(isMemberInbox({ ...inbox, offering: "sometimes" }), false);
		assert.equal(isMemberInbox({ ...inbox, version: 2 }), false);
	});
});

describe("enqueue ordering and capacity", () => {
	test("assigns monotonic sequences and offers strictly FIFO regardless of content", () => {
		const inbox = inboxWith(3);
		assert.deepEqual(
			inbox.items.map((item) => item.payload.content),
			["message-0", "message-1", "message-2"],
		);
		assert.deepEqual(
			inbox.items.map((item) => item.sequence),
			[0, 1, 2],
		);
		const offered = nextOfferableInboxItem(inbox);
		assert.equal(offered && offered.payload.content, "message-0");
		assert.equal(compareInboxItems(inbox.items[0] as InboxItem, inbox.items[1] as InboxItem), -1);
	});

	test("same enqueue timestamp never collapses order: sequence breaks ties", () => {
		const inbox = inboxWith(3);
		assert.ok(inbox.items.every((item) => item.enqueuedAt === 1000));
		assert.deepEqual(
			inbox.items.map((item) => item.sequence),
			[0, 1, 2],
		);
	});

	test("next sequence respects stored items and an explicit floor", () => {
		assert.equal(nextInboxSequence([]), 0);
		assert.equal(nextInboxSequence(inboxWith(2).items), 2);
		assert.equal(nextInboxSequence([], 7), 7);
		assert.equal(nextInboxSequence(inboxWith(2).items, 7), 7);
	});

	test("ids are deterministic from target, sequence, and payload only", () => {
		const inbox = inboxWith(1);
		const item = inbox.items[0] as InboxItem;
		assert.equal(createInboxItemId(target, 0, item.payload), item.id);
		const other = createInboxItemId(target, 0, payload("different"));
		assert.notEqual(other, item.id);
		assert.notEqual(createInboxItemId({ ...target, name: "Dave" }, 0, item.payload), item.id);
		assert.notEqual(createInboxItemId(target, 1, item.payload), item.id);
	});

	test("rejects enqueue beyond capacity without mutating the inbox", () => {
		let inbox = inboxWith(MAX_INBOX_ITEMS);
		const before = inbox;
		const result = enqueueInboxItem(inbox, { payload: payload("overflow"), now: 2000 });
		assert.equal(result.ok, false);
		assert.ok(!result.ok && result.code === "capacity-exceeded");
		assert.equal(result.inbox, before);
		assert.equal(result.inbox.items.length, MAX_INBOX_ITEMS);
	});

	test("rejects invalid payloads without mutating the inbox", () => {
		const inbox = createMemberInbox(target);
		for (const bad of [payload("  "), payload("nul\0"), { content: "" } as MessagePayload]) {
			const result = enqueueInboxItem(inbox, { payload: bad, now: 1000 });
			assert.equal(result.ok, false);
			assert.ok(!result.ok && result.code === "invalid-payload");
			assert.equal(result.inbox, inbox);
		}
	});

	test("enqueue ignores claimed origin and role: roles grant no enqueue permission", () => {
		const crewOrigin = { kind: "crew" as const, name: "Tony", role: "lead" };
		const result = enqueueInboxItem(createMemberInbox(target), {
			payload: payload("from lead", { origin: crewOrigin }),
			now: 1,
		});
		assert.equal(result.ok, true);
	});
});

describe("cancel pending items", () => {
	test("cancels one pending item and preserves remaining order", () => {
		const inbox = inboxWith(3);
		const middle = (inbox.items[1] as InboxItem).id;
		const result = cancelInboxItem(inbox, middle);
		assert.equal(result.ok, true);
		assert.deepEqual(result.ok && result.inbox.items.map((item) => item.payload.content), [
			"message-0",
			"message-2",
		]);
		const offered = nextOfferableInboxItem(result.ok ? result.inbox : inbox);
		assert.equal(offered && offered.payload.content, "message-0");
	});

	test("unknown or already-canceled ids fail without mutation", () => {
		const inbox = inboxWith(1);
		const missing = cancelInboxItem(inbox, "nope");
		assert.equal(missing.ok, false);
		assert.ok(!missing.ok && missing.code === "item-not-found");
		assert.equal(missing.inbox, inbox);
		const id = (inbox.items[0] as InboxItem).id;
		const canceled = cancelInboxItem(inbox, id);
		assert.equal(canceled.ok, true);
		const again = cancelInboxItem(canceled.ok ? canceled.inbox : inbox, id);
		assert.ok(!again.ok && again.code === "item-not-found");
	});
});

describe("pause and resume automatic offering", () => {
	test("paused inbox offers nothing but still accepts enqueues", () => {
		let inbox = setInboxOffering(inboxWith(2), "paused");
		assert.equal(nextOfferableInboxItem(inbox), null);
		const result = enqueueInboxItem(inbox, { payload: payload("while paused"), now: 2000 });
		assert.equal(result.ok, true);
		inbox = result.ok ? result.inbox : inbox;
		assert.equal(nextOfferableInboxItem(inbox), null);
		inbox = setInboxOffering(inbox, "active");
		const offered = nextOfferableInboxItem(inbox);
		assert.equal(offered && offered.payload.content, "message-0");
	});

	test("pause and resume never drop or reorder items", () => {
		const inbox = inboxWith(3);
		const paused = setInboxOffering(inbox, "paused");
		const resumed = setInboxOffering(paused, "active");
		assert.deepEqual(resumed.items, inbox.items);
	});
});

describe("crash deduplication and acknowledgement", () => {
	test("restart dedup drops items with recorded acceptance evidence and keeps order", () => {
		const inbox = inboxWith(3);
		const accepted = [(inbox.items[0] as InboxItem).id, (inbox.items[2] as InboxItem).id];
		const pending = pendingInboxItemsAfterRestart(inbox, accepted);
		assert.deepEqual(
			pending.map((item) => item.payload.content),
			["message-1"],
		);
	});

	test("unacknowledged duplicates are re-offered, matching bounded no-exactly-once semantics", () => {
		const inbox = inboxWith(1);
		const nothing = pendingInboxItemsAfterRestart(inbox, []);
		assert.equal(nothing.length, 1);
		const accepted = pendingInboxItemsAfterRestart(inbox, [(inbox.items[0] as InboxItem).id]);
		assert.equal(accepted.length, 0);
	});

	test("acknowledgement removes durably-evidenced items and reports removed ids", () => {
		const inbox = inboxWith(3);
		const id = (inbox.items[1] as InboxItem).id;
		const result = removeAcknowledgedInboxItems(inbox, { recipientSessionId: "session-1", itemIds: [id, "gone"] });
		assert.equal(result.ok, true);
		assert.ok(result.ok);
		assert.deepEqual(result.removedIds, [id]);
		assert.deepEqual(
			result.inbox.items.map((item) => item.payload.content),
			["message-0", "message-2"],
		);
	});

	test("invalid session evidence is rejected without mutation", () => {
		const inbox = inboxWith(1);
		const id = (inbox.items[0] as InboxItem).id;
		for (const evidence of [
			{ recipientSessionId: "", itemIds: [id] },
			{ recipientSessionId: "session-1", itemIds: [] },
			{ recipientSessionId: "session-1", itemIds: [""] },
		]) {
			const result = removeAcknowledgedInboxItems(inbox, evidence);
			assert.equal(result.ok, false);
			assert.ok(!result.ok && result.code === "invalid-evidence");
			assert.equal(result.inbox, inbox);
		}
	});

	test("offering after a crash-restart dedup still yields the earliest unaccepted item", () => {
		const inbox = inboxWith(3);
		const pending = pendingInboxItemsAfterRestart(inbox, [(inbox.items[0] as InboxItem).id]);
		const rebuilt = { ...inbox, items: pending };
		const offered = nextOfferableInboxItem(rebuilt);
		assert.equal(offered && offered.payload.content, "message-1");
	});
});

describe("invariants on pure operations", () => {
	test("enqueue preserves all previously issued sequences and ids", () => {
		let inbox = inboxWith(2);
		const ids = inbox.items.map((item) => item.id);
		const result = enqueueInboxItem(inbox, { payload: payload("more"), now: 9999 });
		inbox = result.ok ? result.inbox : inbox;
		assert.deepEqual(
			inbox.items.slice(0, 2).map((item) => item.id),
			ids,
		);
		assert.equal(isMemberInbox(inbox), true);
	});
});
