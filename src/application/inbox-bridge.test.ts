import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	createInboxBridge,
	formatInboxStatus,
	type InboxBridgeController,
	type InboxBridgeDependencies,
	type InboxBridgeOwnership,
	type OfferingStateStore,
} from "./inbox-bridge.ts";
import type { InboxItem, InboxItemSummary } from "../domain/index.ts";

const ownership: InboxBridgeOwnership = {
	memberName: "Bob",
	memberRole: "dev",
	socketPath: "/project/.pi/bebop/sockets/Bob.sock",
	manifestPath: "/project/.pi/bebop/crew.json",
	projectRoot: "/project",
};

const item = (sequence: number, content = "msg"): InboxItem => ({
	version: 1,
	id: `inbox-${sequence.toString(16)}-abc`,
	target: { name: "Bob", socketPath: "/project/.pi/bebop/sockets/Bob.sock" },
	payload: { content },
	enqueuedAt: 1000 + sequence,
	sequence,
});

const summary = (entry: InboxItem): InboxItemSummary => ({
	id: entry.id,
	sequence: entry.sequence,
	enqueuedAt: entry.enqueuedAt,
	bytes: 24,
});

interface FakeStore {
	readonly items: InboxItem[];
	readonly removed: string[];
	readonly cancelled: string[];
	peekOldest(): Promise<InboxItem | null>;
	list(): Promise<readonly InboxItemSummary[]>;
	count(): Promise<number>;
	remove(id: string): Promise<{ readonly removed: boolean }>;
	cancel(id: string): Promise<{ readonly removed: boolean }>;
}

function makeStore(items: InboxItem[] = []): FakeStore {
	const removed: string[] = [];
	const cancelled: string[] = [];
	return {
		items,
		removed,
		cancelled,
		peekOldest: async () => items[0] ?? null,
		list: async () => items.map(summary),
		count: async () => items.length,
		remove: async (id) => {
			const index = items.findIndex((entry) => entry.id === id);
			if (index === -1) return { removed: false };
			items.splice(index, 1);
			removed.push(id);
			return { removed: true };
		},
		cancel: async (id) => {
			const index = items.findIndex((entry) => entry.id === id);
			if (index === -1) return { removed: false };
			items.splice(index, 1);
			cancelled.push(id);
			return { removed: true };
		},
	};
}

function memoryOffering(initial: "active" | "paused" = "active"): OfferingStateStore {
	let state = initial;
	return {
		read: () => state,
		write: (next) => {
			state = next;
		},
	};
}

interface Harness {
	bridge: InboxBridgeController;
	store: FakeStore;
	offered: InboxItem[];
	evidence: string[];
	readonly openCount: number;
	setEvidence(ids: string[]): void;
}

function makeBridge(overrides: Partial<InboxBridgeDependencies> = {}): Harness {
	const store = makeStore();
	const offered: InboxItem[] = [];
	const evidence: string[] = [];
	let openCount = 0;
	const offering = memoryOffering();
	const bridge = createInboxBridge({
		openStore: async () => {
			openCount += 1;
			return store;
		},
		listEvidence: () => [...evidence],
		offerItem: async (entry) => {
			offered.push(entry);
			return true;
		},
		offeringState: offering,
		...overrides,
	});
	return {
		bridge,
		store,
		offered,
		evidence,
		get openCount() {
			return openCount;
		},
		setEvidence: (ids) => {
			evidence.length = 0;
			evidence.push(...ids);
		},
	};
}

describe("offer lifecycle", () => {
	test("not joined skips before any store IO", async () => {
		const harness = makeBridge();
		const outcome = await harness.bridge.attemptOffer();
		assert.deepEqual(outcome, { offered: false, reason: "not-joined" });
		assert.equal(harness.openCount, 0);
	});

	test("offers the oldest item once as follow-up after establish", async () => {
		const harness = makeBridge();
		harness.store.items.push(item(0), item(1));
		harness.bridge.establish(ownership);
		const outcome = await harness.bridge.attemptOffer();
		assert.deepEqual(outcome, { offered: true, itemId: "inbox-0-abc" });
		assert.deepEqual(
			harness.offered.map((entry) => entry.sequence),
			[0],
		);
	});

	test("reconciles evidenced items away before offering the next oldest", async () => {
		const harness = makeBridge();
		harness.store.items.push(item(0), item(1));
		harness.bridge.establish(ownership);
		harness.setEvidence(["inbox-0-abc"]);
		const outcome = await harness.bridge.attemptOffer();
		assert.deepEqual(outcome, { offered: true, itemId: "inbox-1-abc" });
		assert.deepEqual(harness.store.removed, ["inbox-0-abc"]);
	});

	test("at most one item outstanding: repeated triggers do not re-offer", async () => {
		const harness = makeBridge();
		harness.store.items.push(item(0), item(1));
		harness.bridge.establish(ownership);
		await harness.bridge.attemptOffer();
		const second = await harness.bridge.attemptOffer();
		assert.deepEqual(second, { offered: false, reason: "outstanding" });
		assert.deepEqual(
			harness.offered.map((entry) => entry.id),
			["inbox-0-abc"],
		);
	});

	test("durable evidence clears the outstanding item so the next item is offered", async () => {
		const harness = makeBridge();
		harness.store.items.push(item(0), item(1));
		harness.bridge.establish(ownership);
		await harness.bridge.attemptOffer();
		harness.setEvidence(["inbox-0-abc"]);
		const next = await harness.bridge.attemptOffer();
		assert.deepEqual(next, { offered: true, itemId: "inbox-1-abc" });
		assert.deepEqual(harness.store.removed, ["inbox-0-abc"]);
	});

	test("restart loses outstanding memory but durable evidence reconciles before offering", async () => {
		const harness = makeBridge();
		harness.store.items.push(item(0), item(1));
		harness.bridge.establish(ownership);
		await harness.bridge.attemptOffer();
		harness.setEvidence(["inbox-0-abc"]);

		const restarted = makeBridge();
		restarted.store.items.push(...harness.store.items);
		restarted.setEvidence(["inbox-0-abc"]);
		restarted.bridge.establish(ownership);
		const outcome = await restarted.bridge.attemptOffer();
		assert.deepEqual(outcome, { offered: true, itemId: "inbox-1-abc" });
		assert.deepEqual(restarted.store.removed, ["inbox-0-abc"]);
	});

	test("store open failure and offer rejection map to bounded failed outcomes", async () => {
		const failedOpen = makeBridge({
			openStore: async () => {
				throw new Error("untrusted");
			},
		});
		failedOpen.bridge.establish(ownership);
		assert.deepEqual(await failedOpen.bridge.attemptOffer(), { offered: false, reason: "failed" });

		const rejected = makeBridge({
			offerItem: async () => false,
		});
		rejected.store.items.push(item(0));
		rejected.bridge.establish(ownership);
		assert.deepEqual(await rejected.bridge.attemptOffer(), { offered: false, reason: "failed" });
		const retry = await rejected.bridge.attemptOffer();
		assert.deepEqual(retry, { offered: false, reason: "failed" });
	});

	test("concurrent triggers never duplicate the same oldest item", async () => {
		const store = makeStore([item(0), item(1)]);
		const offered: InboxItem[] = [];
		const offering = memoryOffering();
		let releaseOffer: (() => void) | undefined;
		let offerStarted = 0;
		const bridge = createInboxBridge({
			openStore: async () => store,
			listEvidence: () => [],
			offerItem: async (entry) => {
				offerStarted += 1;
				if (offerStarted === 1)
					await new Promise<void>((resolve) => {
						releaseOffer = resolve;
					});
				offered.push(entry);
				return true;
			},
			offeringState: offering,
		});
		bridge.establish(ownership);
		const first = bridge.attemptOffer();
		const second = bridge.attemptOffer();
		await new Promise((resolve) => setTimeout(resolve, 0));
		releaseOffer?.();
		const outcomes = await Promise.all([first, second]);
		assert.deepEqual(
			outcomes.map((outcome) => (outcome.offered ? outcome.itemId : outcome.reason)),
			["inbox-0-abc", "outstanding"],
		);
		assert.deepEqual(
			offered.map((entry) => entry.id),
			["inbox-0-abc"],
		);
	});

	test("store list failure during reconcile maps to bounded failed outcome", async () => {
		const harness = makeBridge({
			openStore: async () =>
				({
					memberKey: "member-test",
					list: async () => {
						throw new Error("quarantine-failed");
					},
					peekOldest: async () => null,
					count: async () => 0,
					remove: async () => ({ removed: false }),
					cancel: async () => ({ removed: false }),
					enqueue: async () => {
						throw new Error("not used");
					},
				}) as never,
		});
		harness.bridge.establish(ownership);
		assert.deepEqual(await harness.bridge.attemptOffer(), { offered: false, reason: "failed" });
	});
});

describe("pause and resume", () => {
	test("pause stops automatic offering but never blocks reconciliation", async () => {
		const harness = makeBridge();
		harness.store.items.push(item(0), item(1));
		harness.bridge.establish(ownership);
		harness.setEvidence(["inbox-0-abc"]);
		harness.bridge.setPaused(true);
		const outcome = await harness.bridge.attemptOffer();
		assert.deepEqual(outcome, { offered: false, reason: "paused" });
		assert.deepEqual(harness.store.removed, ["inbox-0-abc"]);
		assert.equal(harness.offered.length, 0);
	});

	test("resume allows offering again without deleting pending items", async () => {
		const harness = makeBridge();
		harness.store.items.push(item(0));
		harness.bridge.establish(ownership);
		harness.bridge.setPaused(true);
		await harness.bridge.attemptOffer();
		harness.bridge.setPaused(false);
		const outcome = await harness.bridge.attemptOffer();
		assert.deepEqual(outcome, { offered: true, itemId: "inbox-0-abc" });
	});
});

describe("ownership invalidation", () => {
	test("invalidate clears ownership and in-flight outstanding", async () => {
		const harness = makeBridge();
		harness.store.items.push(item(0));
		harness.bridge.establish(ownership);
		await harness.bridge.attemptOffer();
		harness.bridge.invalidate();
		const outcome = await harness.bridge.attemptOffer();
		assert.deepEqual(outcome, { offered: false, reason: "not-joined" });
	});

	test("establishing a different endpoint clears stale outstanding attempts", async () => {
		const harness = makeBridge();
		harness.store.items.push(item(0));
		harness.bridge.establish(ownership);
		await harness.bridge.attemptOffer();
		const switched: InboxBridgeOwnership = {
			...ownership,
			memberName: "Kelly",
			memberRole: "qa",
			socketPath: "/project/.pi/bebop/sockets/qa.sock",
		};
		harness.bridge.establish(switched);
		const outcome = await harness.bridge.attemptOffer();
		assert.deepEqual(outcome, { offered: true, itemId: "inbox-0-abc" });
	});
});

describe("cancel", () => {
	test("removes only a pending item and is idempotent", async () => {
		const harness = makeBridge();
		harness.store.items.push(item(0));
		harness.bridge.establish(ownership);
		const first = await harness.bridge.cancel("inbox-0-abc");
		assert.deepEqual(first, { removed: true, itemId: "inbox-0-abc" });
		const second = await harness.bridge.cancel("inbox-0-abc");
		assert.deepEqual(second, { removed: false, reason: "not-found" });
		assert.deepEqual(harness.store.cancelled, ["inbox-0-abc"]);
	});

	test("refuses items already handed to a session (durable evidence)", async () => {
		const harness = makeBridge();
		harness.store.items.push(item(0));
		harness.bridge.establish(ownership);
		harness.setEvidence(["inbox-0-abc"]);
		const outcome = await harness.bridge.cancel("inbox-0-abc");
		assert.deepEqual(outcome, { removed: false, reason: "not-pending" });
		assert.equal(harness.store.cancelled.length, 0);
	});

	test("refuses the in-flight outstanding item", async () => {
		const harness = makeBridge();
		harness.store.items.push(item(0));
		harness.bridge.establish(ownership);
		await harness.bridge.attemptOffer();
		const outcome = await harness.bridge.cancel("inbox-0-abc");
		assert.deepEqual(outcome, { removed: false, reason: "not-pending" });
	});
});

describe("status and formatting", () => {
	test("status exposes bounded metadata without message contents", async () => {
		const harness = makeBridge();
		harness.store.items.push(item(0, "secret content"), item(1, "also secret"));
		harness.bridge.establish(ownership);
		harness.bridge.setPaused(true);
		await harness.bridge.attemptOffer();
		const status = await harness.bridge.status();
		assert.equal(status.offering, "paused");
		assert.equal(status.count, 2);
		assert.deepEqual(
			status.items.map((entry) => entry.sequence),
			[0, 1],
		);
		assert.ok(!JSON.stringify(status).includes("secret content"));
	});

	test("formatInboxStatus renders bounded metadata and never content", () => {
		const text = formatInboxStatus(
			{
				offering: "active",
				count: 3,
				outstanding: "inbox-0-abc",
				items: [summary(item(0, "secret")), summary(item(1, "secret"))],
			},
			1,
		);
		assert.ok(text.includes("active"));
		assert.ok(text.includes("3 pending"));
		assert.ok(text.includes("inbox-0-abc"));
		assert.ok(text.includes("... 1 more"));
		assert.ok(!text.includes("secret"));
	});
});
