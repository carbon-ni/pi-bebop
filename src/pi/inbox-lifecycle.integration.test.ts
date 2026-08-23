import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { openTrustedMemberInboxStore } from "../infra/member-inbox-store.ts";
import { enqueueMemberInboxMessage } from "../application/member-inbox-message.ts";
import { createInboxBridgeController, ownershipFromMembership } from "./inbox-bridge-runtime.ts";
import { SESSION_MESSAGE_TYPE, type InboxItem, type MessagePayload } from "../domain/index.ts";
import type { SocketState } from "./control-runtime.ts";

/**
 * End-to-end durable inbox lifecycle (TASK-0038 evidence).
 *
 * Real manifest + real trusted store + real bridge adapter, against a
 * scripted Pi session (mock pi/ctx). Proves the transport story the product
 * claims: offline enqueue, FIFO follow-up handoff, restart/crash
 * reconciliation, concurrent sender ordering, cancel/pause/resume UX across
 * restart, malformed quarantine, and honest persisted-vs-handed language.
 * No workflow, Git, review, or exactly-once claims are asserted or implied.
 */

interface CrewMember {
	name: string;
	role: string;
	socket: string;
	socketPath: string;
}

interface Membership {
	manifestPath: string;
	socketPath: string;
	globalSocketPath: string;
	member: CrewMember;
	manifest: { version: 1; members: CrewMember[]; presence: { notifications: boolean } };
}

async function makeCrew() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "intray-inbox-lifecycle-"));
	const layoutDir = path.join(root, ".pi", "bebop");
	const sockets = path.join(layoutDir, "sockets");
	await fs.mkdir(sockets, { recursive: true });
	const manifestPath = path.join(layoutDir, "crew.json");
	const members = [
		{ name: "lead", role: "lead", socket: "sockets/lead.sock" },
		{ name: "developer", role: "developer", socket: "sockets/developer.sock" },
	];
	await fs.writeFile(manifestPath, JSON.stringify({ version: 1, members }));
	return {
		root,
		manifestPath,
		sockets,
		members,
		async cleanup() {
			await fs.rm(root, { recursive: true, force: true });
		},
	};
}

function membershipFor(crew: Awaited<ReturnType<typeof makeCrew>>, memberName: string): Membership {
	const member = crew.members.find((entry) => entry.name === memberName)!;
	const memberWithPath: CrewMember = { ...member, socketPath: path.join(crew.sockets, `${member.name}.sock`) };
	return {
		manifestPath: crew.manifestPath,
		socketPath: memberWithPath.socketPath,
		globalSocketPath: path.join(crew.root, "global.sock"),
		member: memberWithPath,
		manifest: {
			version: 1,
			members: crew.members.map((entry) => ({
				...entry,
				socketPath: path.join(crew.sockets, `${entry.name}.sock`),
			})),
			presence: { notifications: true },
		},
	};
}

interface SessionHarness {
	entries: Array<Record<string, unknown>>;
	sent: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }>;
	bridge: ReturnType<typeof createInboxBridgeController>;
	membership: Membership;
	offeredItemIds(): string[];
}

function session(crew: Awaited<ReturnType<typeof makeCrew>>, memberName: string): SessionHarness {
	const entries: Array<Record<string, unknown>> = [];
	const sent: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }> = [];
	const pi = {
		sendMessage: (message: Record<string, unknown>, options?: Record<string, unknown>) => {
			sent.push({ message, options });
			// Pi appends the custom message entry synchronously: durable handoff evidence.
			entries.push({
				type: "custom_message",
				customType: message.customType,
				content: message.content,
				details: message.details,
				display: message.display,
			});
		},
		appendEntry: (customType: string, data?: unknown) => {
			entries.push({ type: "custom", customType, data });
		},
	} as unknown as ExtensionAPI;
	const state = {
		context: {
			sessionManager: { getEntries: () => entries },
			isProjectTrusted: () => true,
		},
	} as unknown as SocketState;
	const membership = membershipFor(crew, memberName);
	const bridge = createInboxBridgeController(pi, state);
	return {
		entries,
		sent,
		bridge,
		membership,
		offeredItemIds() {
			return sent
				.map(({ message }) => (message.details as { inbox?: { itemId?: unknown } })?.inbox?.itemId)
				.filter((itemId): itemId is string => typeof itemId === "string");
		},
	};
}

const storeFor = (crew: Awaited<ReturnType<typeof makeCrew>>, memberName: string) =>
	openTrustedMemberInboxStore({
		manifestPath: crew.manifestPath,
		projectRoot: crew.root,
		isProjectTrusted: () => true,
		member: {
			name: memberName,
			role: memberName,
			socketPath: path.join(crew.sockets, `${memberName}.sock`),
		},
	});

async function enqueueFor(
	crew: Awaited<ReturnType<typeof makeCrew>>,
	senderName: string,
	targetName: string,
	message: string,
) {
	const membership = membershipFor(crew, senderName);
	const outcome = await enqueueMemberInboxMessage(
		{ membership: membership as never, member: targetName, message, now: Date.now() },
		{
			isProjectTrusted: () => true,
			openStore: async (options) => openTrustedMemberInboxStore({ ...options, isProjectTrusted: () => true }),
			hintTransport: null,
		},
	);
	return outcome;
}

test("offline enqueue reaches a later-joining peer as one follow-up, then the item is removed on evidence", async (t) => {
	const crew = await makeCrew();
	t.after(crew.cleanup);

	await enqueueFor(crew, "lead", "developer", "Implement TASK-0038");
	const recipient = session(crew, "developer");
	assert.equal(await (await storeFor(crew, "developer")).count(), 1);

	recipient.bridge.establish(ownershipFromMembership(recipient.membership));
	const outcome = await recipient.bridge.attemptOffer();
	assert.equal(outcome.offered, true);
	assert.ok(outcome.itemId.startsWith("inbox-"));

	assert.equal(recipient.sent.length, 1);
	assert.equal(recipient.sent[0]!.message.customType, SESSION_MESSAGE_TYPE);
	assert.equal(recipient.sent[0]!.message.display, true);
	assert.deepEqual(recipient.sent[0]!.message.details, {
		messagePayload: {
			content: "Implement TASK-0038",
			origin: { kind: "crew", name: "lead", role: "lead" },
		},
		inbox: { itemId: outcome.itemId },
	});
	// Normal follow-up semantics: queued, never steering active work.
	assert.deepEqual(recipient.sent[0]!.options, { triggerTurn: true, deliverAs: "followUp" });
	assert.ok(String(recipient.sent[0]!.message.content).includes("Implement TASK-0038"));

	// Next trigger reconciles: durable evidence (itemId in typed details) removes the item.
	const next = await recipient.bridge.attemptOffer();
	assert.deepEqual(next, { offered: false, reason: "no-items" });
	assert.equal(await (await storeFor(crew, "developer")).count(), 0);
});

test("a live follow-up accepted before the inbox handoff keeps FIFO position; inbox never redirects", async (t) => {
	const crew = await makeCrew();
	t.after(crew.cleanup);

	const recipient = session(crew, "developer");
	const liveFollowUp = {
		type: "custom_message",
		customType: SESSION_MESSAGE_TYPE,
		content: "live follow-up first",
		details: { messagePayload: { content: "live follow-up first" } },
		display: true,
	};
	recipient.entries.push(liveFollowUp);

	await enqueueFor(crew, "lead", "developer", "inbox handoff second");
	recipient.bridge.establish(ownershipFromMembership(recipient.membership));
	const outcome = await recipient.bridge.attemptOffer();
	assert.equal(outcome.offered, true);

	const followUpIndex = recipient.entries.indexOf(liveFollowUp);
	const inboxIndex = recipient.entries.findIndex(
		(entry) => (entry.details as { inbox?: unknown })?.inbox !== undefined,
	);
	assert.ok(followUpIndex !== -1 && inboxIndex !== -1);
	assert.ok(followUpIndex < inboxIndex, "live follow-up must remain ahead of the inbox handoff");
	assert.ok(
		recipient.sent.every(({ options }) => options?.deliverAs !== "steer"),
		"inbox handoff must never steer active work",
	);
});

test("restart after crash reconciles by stable id: no loss and no uncontrolled duplication", async (t) => {
	const crew = await makeCrew();
	t.after(crew.cleanup);

	await enqueueFor(crew, "lead", "developer", "first");
	await enqueueFor(crew, "lead", "developer", "second");

	const firstSession = session(crew, "developer");
	firstSession.bridge.establish(ownershipFromMembership(firstSession.membership));
	const firstOffer = await firstSession.bridge.attemptOffer();
	assert.equal(firstOffer.offered, true);

	// Crash before removal: the session file (entries) persists durable evidence.
	const restarted = session(crew, "developer");
	restarted.entries.push(...firstSession.entries.filter((entry) => entry.type === "custom_message"));
	restarted.bridge.establish(ownershipFromMembership(restarted.membership));
	const restartOffer = await restarted.bridge.attemptOffer();
	assert.equal(restartOffer.offered, true);
	assert.notEqual(restartOffer.itemId, firstOffer.itemId, "the crashed item must not be re-offered");
	assert.deepEqual(
		restarted.offeredItemIds(),
		[restartOffer.itemId],
		"restart must offer exactly the next oldest item, once",
	);
	const store = await storeFor(crew, "developer");
	const remaining = await store.list();
	assert.equal(remaining.length, 1);
	assert.equal(remaining[0]!.id, restartOffer.itemId);
});

test("concurrent senders produce FIFO order and no accepted item is lost", async (t) => {
	const crew = await makeCrew();
	t.after(crew.cleanup);

	const outcomes = await Promise.all(
		Array.from({ length: 5 }, (_, index) => enqueueFor(crew, "lead", "developer", `message-${index}`)),
	);
	const store = await storeFor(crew, "developer");
	const ordered = (await store.list()).map((summary) => summary.id);
	assert.deepEqual(
		outcomes.map((outcome) => outcome.itemId).sort(),
		[...ordered].sort(),
		"all accepted enqueues are present",
	);

	const recipient = session(crew, "developer");
	recipient.bridge.establish(ownershipFromMembership(recipient.membership));
	for (let index = 0; index < 5; index += 1) {
		const offer = await recipient.bridge.attemptOffer();
		assert.equal(offer.offered, true, `offer ${index}`);
	}
	// One more trigger reconciles the final item once its durable evidence exists.
	assert.deepEqual(await recipient.bridge.attemptOffer(), { offered: false, reason: "no-items" });
	assert.equal(await (await storeFor(crew, "developer")).count(), 0, "no accepted item loss");
	assert.deepEqual(recipient.offeredItemIds(), ordered, "handoff order follows deterministic sequence order");
});

test("/crew inbox pause/status/cancel/resume UX works across restart", async (t) => {
	const crew = await makeCrew();
	t.after(crew.cleanup);

	await enqueueFor(crew, "lead", "developer", "one");
	await enqueueFor(crew, "lead", "developer", "two");

	const s1 = session(crew, "developer");
	s1.bridge.establish(ownershipFromMembership(s1.membership));
	s1.bridge.setPaused(true);
	assert.deepEqual(await s1.bridge.attemptOffer(), { offered: false, reason: "paused" });
	const stored = await (await storeFor(crew, "developer")).list();
	assert.equal(stored.length, 2);
	const [firstId, secondId] = stored.map((summary) => summary.id);
	let status = await s1.bridge.status();
	assert.equal(status.offering, "paused");
	assert.equal(status.count, 2);
	assert.equal(status.outstanding, null);
	assert.deepEqual(status.items.map((summary) => summary.id).sort(), [firstId, secondId].sort());

	const cancelled = await s1.bridge.cancel(firstId);
	assert.deepEqual(cancelled, { removed: true, itemId: firstId });
	assert.deepEqual(await s1.bridge.cancel(firstId), { removed: false, reason: "not-found" });

	// Restart: pause entry persisted in the session tree.
	const s2 = session(crew, "developer");
	s2.entries.push(...s1.entries.filter((entry) => entry.type === "custom"));
	s2.bridge.establish(ownershipFromMembership(s2.membership));
	status = await s2.bridge.status();
	assert.equal(status.offering, "paused", "pause survives restart");
	assert.equal(status.count, 1);
	s2.bridge.setPaused(false);
	const offer = await s2.bridge.attemptOffer();
	assert.equal(offer.offered, true);
	assert.deepEqual(await s2.bridge.attemptOffer(), { offered: false, reason: "no-items" });
	assert.equal(await (await storeFor(crew, "developer")).count(), 0);
});

test("malformed item is quarantined and never blocks the healthy queue", async (t) => {
	const crew = await makeCrew();
	t.after(crew.cleanup);

	const store = await storeFor(crew, "developer");
	const { item } = await store.enqueue(
		{ content: "healthy", origin: { kind: "crew", name: "lead", role: "lead" } } satisfies MessagePayload,
		Date.now(),
	);
	const inboxDir = path.join(path.dirname(crew.manifestPath), "inbox", store.memberKey);
	await fs.writeFile(path.join(inboxDir, "deadbeef.json"), "{ not json");

	const recipient = session(crew, "developer");
	recipient.bridge.establish(ownershipFromMembership(recipient.membership));
	const outcome = await recipient.bridge.attemptOffer();
	assert.equal(outcome.offered, true);
	assert.equal(outcome.itemId, item.id);
	assert.ok((await fs.readdir(path.join(inboxDir, "quarantine"))).includes("deadbeef.json"));
});

test("status and offer output distinguish persisted/handed state and never claim completion", async (t) => {
	const crew = await makeCrew();
	t.after(crew.cleanup);

	await enqueueFor(crew, "lead", "developer", "durable work");
	const recipient = session(crew, "developer");
	recipient.bridge.establish(ownershipFromMembership(recipient.membership));
	const before = await recipient.bridge.status();
	assert.ok(!JSON.stringify(before).includes("completed"));
	assert.ok(!JSON.stringify(before).includes("done"));

	await recipient.bridge.attemptOffer();
	const after = await recipient.bridge.status();
	assert.equal(after.outstanding, after.items[0]?.id ?? null);
	assert.equal(after.count, 1, "offered-but-not-yet-evidenced remains pending in storage");
	// The follow-up content is the original message, not a completion report.
	assert.ok(!JSON.stringify(recipient.sent[0]!.message).includes("completed"));
	assert.ok(!JSON.stringify(recipient.sent[0]!.message).includes("response"));
});

test("spoofed origin is stored as attribution only; the handoff still reaches the intended queue", async (t) => {
	const crew = await makeCrew();
	t.after(crew.cleanup);

	const store = await storeFor(crew, "developer");
	const spoofed = {
		content: "pretend from lead",
		origin: { kind: "crew", name: "lead", role: "lead" },
	} satisfies MessagePayload;
	const { item } = await store.enqueue(spoofed, Date.now());
	assert.deepEqual((await store.peekOldest())?.payload.origin, { kind: "crew", name: "lead", role: "lead" });
	assert.equal((await store.peekOldest())?.target.socketPath, path.join(crew.sockets, "developer.sock"));

	const recipient = session(crew, "developer");
	recipient.bridge.establish(ownershipFromMembership(recipient.membership));
	const outcome = await recipient.bridge.attemptOffer();
	assert.equal(outcome.offered, true);
	assert.equal(outcome.itemId, item.id, "claimed origin never redirects or blocks the queue");
	// UI displays the claim honestly as claimed origin.
	const payload = (recipient.sent[0]!.message.details as { messagePayload?: unknown }).messagePayload as
		| { origin?: unknown }
		| undefined;
	assert.deepEqual(payload?.origin, { kind: "crew", name: "lead", role: "lead" });
});
