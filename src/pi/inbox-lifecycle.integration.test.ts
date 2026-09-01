import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { openTrustedMemberInboxStore } from "../infra/member-inbox-store.ts";
import { enqueueMemberInboxMessage } from "../application/member-inbox-message.ts";
import { submitCrewBroadcast } from "../application/crew-broadcast.ts";
import { createInboxBridgeController, ownershipFromMembership } from "./inbox-bridge-runtime.ts";
import { createInboxTerminalOfferCallbacks, registerInboxTerminalOfferHandlers } from "./inbox-terminal-handlers.ts";
import { handleSend } from "./command-handlers/send.ts";
import { handlerContext } from "./command-handlers/test-support.ts";
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

async function makeCrew(name?: string) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "intray-inbox-lifecycle-"));
	const layoutDir = path.join(root, ".pi", "bebop");
	const sockets = path.join(layoutDir, "sockets");
	await fs.mkdir(sockets, { recursive: true });
	const manifestPath = path.join(layoutDir, "crew.json");
	const members = [
		{ name: "lead", role: "lead", socket: "sockets/lead.sock" },
		{ name: "developer", role: "developer", socket: "sockets/developer.sock" },
	];
	await fs.writeFile(manifestPath, JSON.stringify({ version: 1, ...(name ? { name } : {}), members }));
	return {
		root,
		manifestPath,
		sockets,
		members,
		name,
		async cleanup() {
			await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
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
			...(crew.name ? { name: crew.name } : {}),
			members: crew.members.map((entry) => ({
				...entry,
				socketPath: path.join(crew.sockets, `${entry.name}.sock`),
			})),
			presence: { notifications: true },
		},
	};
}

async function flushAutomaticTrigger(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

function allOfferedContent(sent: Array<Record<string, unknown>>): string[] {
	return sent
		.filter((message) => (message.details as any)?.inbox)
		.map((message) => JSON.parse(message.content as string).content as string);
}

async function waitForOffers(
	sent: Array<Record<string, unknown>>,
	count: number,
	waitForDelivery: () => Promise<void>,
): Promise<void> {
	while (sent.filter((message) => (message.details as any)?.inbox).length < count) await waitForDelivery();
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
	const membership = membershipFor(crew, memberName);
	const state = {
		context: {
			sessionManager: { getEntries: () => entries },
			isProjectTrusted: () => true,
		},
		membershipRuntime: { getMembership: () => membership },
	} as unknown as SocketState;
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

test(
	"production lifecycle harness: hint and terminal events hand off FIFO exactly once",
	{ timeout: 5000 },
	async (t) => {
		const crew = await makeCrew();
		t.after(crew.cleanup);
		await enqueueFor(crew, "lead", "developer", "first");
		await enqueueFor(crew, "lead", "developer", "second");
		const membership = membershipFor(crew, "developer");
		const entries: Array<Record<string, unknown>> = [];
		const sent: Array<Record<string, unknown>> = [];
		let resolveDelivery: (() => void) | undefined;
		const waitForDelivery = () =>
			new Promise<void>((resolve) => {
				resolveDelivery = resolve;
			});
		let idle = true;
		let compacting = false;
		const context = {
			isIdle: () => idle,
			isCompacting: () => compacting,
			sessionManager: { getEntries: () => entries },
			isProjectTrusted: () => true,
		};
		const pi = {
			sendMessage: (message: Record<string, unknown>) => {
				sent.push(message);
				resolveDelivery?.();
				resolveDelivery = undefined;
				entries.push({ type: "custom_message", customType: message.customType, details: message.details });
			},
			appendEntry: (customType: string, data?: unknown) => entries.push({ customType, data }),
		} as unknown as ExtensionAPI;
		const state = {
			context,
			membershipRuntime: { getMembership: () => membership },
		} as unknown as SocketState;
		const bridge = createInboxBridgeController(pi, state);
		bridge.establish(ownershipFromMembership(membership) as never);
		let hintAttempt: Promise<unknown> | undefined;
		state.onInboxHint = () => {
			hintAttempt = bridge.attemptOffer();
			return hintAttempt;
		};
		const handlers = new Map<string, (...args: any[]) => void>();
		registerInboxTerminalOfferHandlers(
			{ on: (name: string, handler: (...args: any[]) => void) => handlers.set(name, handler) } as never,
			createInboxTerminalOfferCallbacks({
				emitSettled: () => undefined,
				offer: () => bridge.attemptOffer(),
			}),
		);
		const inbound = handlerContext({
			state,
			ctx: context as never,
			contextIsCompacting: () => compacting,
		});
		inbound.state.modelDelivery = {
			sendDurably: async (message: unknown) => {
				pi.sendMessage(message as never);
				return { disposition: "direct" };
			},
		} as never;
		await handleSend(
			{
				type: "send",
				delivery: "follow_up",
				id: "hint",
				payload: { content: "[inbox] durable inbox item" },
			} as never,
			inbound,
		);
		await waitForOffers(sent, 1, waitForDelivery);
		const firstOffer = sent.find((message) => (message.details as any)?.inbox)!;
		const firstId = (firstOffer.details as any).inbox.itemId as string;
		assert.match(firstId, /^inbox-0-/);
		assert.match(firstOffer.content as string, /first/);
		idle = false;
		handlers.get("agent_settled")?.({}, context);
		await flushAutomaticTrigger();
		assert.equal(sent.filter((message) => (message.details as any)?.inbox).length, 1);
		idle = true;
		handlers.get("agent_settled")?.({}, context);
		await waitForOffers(sent, 2, waitForDelivery);
		const offeredIds = sent
			.filter((message) => (message.details as any)?.inbox)
			.map((message) => (message.details as any).inbox.itemId);
		assert.equal(offeredIds.length, 2);
		assert.notEqual(offeredIds[0], offeredIds[1]);
		assert.equal(new Set(offeredIds).size, 2);
		assert.match(allOfferedContent(sent)[0], /first/);
		assert.match(allOfferedContent(sent)[1], /second/);
		await enqueueFor(crew, "lead", "developer", "third");
		compacting = true;
		handlers.get("session_compact")?.({}, context);
		handlers.get("session_compact_failed")?.({}, context);
		await flushAutomaticTrigger();
		assert.equal(sent.filter((message) => (message.details as any)?.inbox).length, 2);
		compacting = false;
		handlers.get("session_compact_failed")?.({}, context);
		await waitForOffers(sent, 3, waitForDelivery);
		const allOffered = sent.filter((message) => (message.details as any)?.inbox);
		assert.equal(new Set(allOffered.map((message) => (message.details as any).inbox.itemId)).size, 3);
		assert.deepEqual(allOfferedContent(sent).slice(0, 3), ["first", "second", "third"]);
		const broadcastHints: string[] = [];
		const broadcast = await submitCrewBroadcast(
			{ membership: membershipFor(crew, "lead") as never, message: "broadcast fourth", now: 4 },
			{
				isProjectTrusted: () => true,
				openStore: async (options) => openTrustedMemberInboxStore({ ...options, isProjectTrusted: () => true }),
				notifyRecipient: async (recipient) => {
					broadcastHints.push(recipient.name);
					await handleSend(
						{
							type: "send",
							delivery: "follow_up",
							id: "broadcast-hint",
							payload: { content: "[inbox] durable inbox item" },
						} as never,
						inbound,
					);
				},
			},
		);
		assert.equal(broadcast.ok, true);
		assert.deepEqual(broadcastHints, ["developer"]);
		await waitForOffers(sent, 4, waitForDelivery);
		await enqueueFor(crew, "lead", "developer", "fourth");
		await Promise.all([
			handleSend(
				{
					type: "send",
					delivery: "follow_up",
					id: "hint-race",
					payload: { content: "[inbox] durable inbox item" },
				} as never,
				inbound,
			),
			(async () => {
				await handlers.get("agent_settled")?.({}, context);
			})(),
		]);
		await hintAttempt;
		await waitForOffers(sent, 5, waitForDelivery);
		const raceOffers = sent.filter((message) => (message.details as any)?.inbox);
		assert.equal(new Set(raceOffers.map((message) => (message.details as any).inbox.itemId)).size, 5);
		assert.equal(raceOffers.length, 5);
	},
);

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

test("named external intake persists offline and hands off with the trusted recipient crew label", async (t) => {
	const crew = await makeCrew("Alpha Crew");
	t.after(crew.cleanup);

	await enqueueFor(crew, "lead", "developer", "Named crew handoff");
	const recipient = session(crew, "developer");
	recipient.bridge.establish(ownershipFromMembership(recipient.membership));
	const outcome = await recipient.bridge.attemptOffer();
	assert.equal(outcome.offered, true);
	assert.deepEqual(recipient.sent[0]!.message.details, {
		messagePayload: {
			content: "Named crew handoff",
			origin: { kind: "crew", name: "lead", role: "lead" },
		},
		inbox: { itemId: outcome.itemId, crewName: "Alpha Crew" },
	});
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

import { submitExternalIntake } from "../application/external-intake.ts";
import { parseCrewManifest } from "../domain/index.ts";

test("external intake persists for an offline contact and later hands off as a follow-up", async (t) => {
	const crew = await makeCrew();
	t.after(crew.cleanup);

	// Configure the crew contact (exact member name) and submit intake while offline.
	const manifestWithIntake = {
		version: 1,
		members: crew.members.map((member) => ({ ...member })),
		intake: { contact: "developer" },
	};
	await fs.writeFile(crew.manifestPath, JSON.stringify(manifestWithIntake));
	const ack = await submitExternalIntake(
		{ manifestPath: crew.manifestPath, label: "jira-automation", content: "evaluate the proposal" },
		{
			loadManifest: async (manifestPath) =>
				parseCrewManifest(JSON.parse(await fs.readFile(manifestPath, "utf8")), manifestPath),
			openStore: async (options) => openTrustedMemberInboxStore({ ...options, isProjectTrusted: () => true }),
		},
	);
	assert.equal(ack.contact, "developer");
	assert.equal(ack.persisted, true);
	assert.match(ack.itemId, /^inbox-/);
	assert.ok(!JSON.stringify(ack).includes("replyTo"));
	assert.equal(await (await storeFor(crew, "developer")).count(), 1, "contact offline but item persisted");

	// Contact later joins; TASK-0037 hands the oldest item over as a follow-up.
	const recipient = session(crew, "developer");
	recipient.bridge.establish(ownershipFromMembership(recipient.membership));
	const outcome = await recipient.bridge.attemptOffer();
	assert.equal(outcome.offered, true);
	assert.equal(outcome.itemId, ack.itemId);
	const payload = (recipient.sent[0]!.message.details as { messagePayload: { origin?: unknown } }).messagePayload;
	assert.deepEqual(payload.origin, { kind: "external", label: "jira-automation" });
	assert.deepEqual(recipient.sent[0]!.options, { triggerTurn: true, deliverAs: "followUp" });

	// Durable evidence removes the item on the next trigger.
	assert.deepEqual(await recipient.bridge.attemptOffer(), { offered: false, reason: "no-items" });
	assert.equal(await (await storeFor(crew, "developer")).count(), 0);
});

import { submitCrewBroadcast } from "../application/crew-broadcast.ts";

test("broadcast reaches an offline recipient as a normal follow-up and is removed on evidence", async (t) => {
	const crew = await makeCrew();
	t.after(crew.cleanup);

	// Fan out from the lead while the developer is offline (no endpoint exists).
	const outcome = await submitCrewBroadcast(
		{
			membership: membershipFor(crew, "lead"),
			message: "API contract changed; pull latest plan before continuing",
			instructions: ["Acknowledge constraint in your next normal report"],
			now: 1000,
		},
		{
			isProjectTrusted: () => true,
			openStore: async (options) => openTrustedMemberInboxStore({ ...options, isProjectTrusted: () => true }),
		},
	);
	assert.equal(outcome.ok, true);
	if (!outcome.ok) return;
	assert.equal(outcome.summary.persisted, 1);
	assert.equal(outcome.summary.failed, 0);

	// Recipient is the developer with a deterministic broadcast item id (no endpoint probe).
	const devStore = await storeFor(crew, "developer");
	assert.equal(await devStore.count(), 1);
	const listed = await devStore.list();
	assert.ok(listed[0]!.id.startsWith("broadcast-"), `expected broadcast id, got ${listed[0]!.id}`);

	// Developer joins later and the item hands off as a normal non-interrupting follow-up.
	const recipient = session(crew, "developer");
	const senderCreated = recipient.sent.length;
	recipient.bridge.establish(ownershipFromMembership(recipient.membership));
	const offer = await recipient.bridge.attemptOffer();
	assert.equal(offer.offered, true);
	assert.equal(offer.itemId, listed[0]!.id);

	const handoff = recipient.sent[senderCreated]!;
	assert.equal(handoff.message.customType, SESSION_MESSAGE_TYPE);
	const payload = (handoff.message.details as { messagePayload?: MessagePayload }).messagePayload;
	assert.equal(payload?.content, "API contract changed; pull latest plan before continuing");
	// Derived crew origin: the broadcaster's manifest identity, never external.
	assert.deepEqual(payload?.origin, { kind: "crew", name: "lead", role: "lead" });
	// Never redirects active work.
	assert.deepEqual(handoff.options, { triggerTurn: true, deliverAs: "followUp" });

	// Durable evidence removes the item on the next trigger.
	assert.deepEqual(await recipient.bridge.attemptOffer(), { offered: false, reason: "no-items" });
	assert.equal(await devStore.count(), 0);
});

test("broadcast fan-out is idempotent across a retry after one recipient failed", async (t) => {
	const crew = await makeCrew();
	t.after(crew.cleanup);

	const run = () =>
		submitCrewBroadcast(
			{ membership: membershipFor(crew, "lead"), message: "retry me", now: 2000 },
			{
				isProjectTrusted: () => true,
				openStore: async (options) => openTrustedMemberInboxStore({ ...options, isProjectTrusted: () => true }),
			},
		);

	const first = await run();
	assert.equal(first.ok, true);
	if (!first.ok) return;
	// Same broadcast re-sent must not duplicate the successful recipient.
	const second = await run();
	assert.equal(second.ok, true);
	if (!second.ok) return;
	assert.equal(second.summary.alreadyPersisted, 1);

	const devStore = await storeFor(crew, "developer");
	assert.equal(await devStore.count(), 1, "retry must not duplicate the broadcast item");
});

import { handleCommand, createSocketState } from "./control-runtime.ts";
import { createInterruptFlow } from "../application/interrupt-flow.ts";
import { INTERRUPT_ENTRY_TYPE } from "../application/interrupt-flow.ts";

test("interrupt E2E: target-owned flow persists pending, aborts, steers recovery, and reload recovery re-delivers on crash", async (t) => {
	const crew = await makeCrew();
	t.after(crew.cleanup);

	// Target session (the recipient of the interrupt): scripted Pi surface.
	const entries: unknown[] = [];
	const sent: Array<{ message: unknown; options?: unknown }> = [];
	const pi = {
		sendMessage: (message: unknown, options?: unknown) => {
			sent.push({ message, options });
		},
		appendEntry: (customType: string, data?: unknown) => {
			entries.push({ type: "custom", customType, data });
		},
	} as unknown as ExtensionAPI;
	const writes: string[] = [];
	const socket = { write: (value: string) => writes.push(value), once: () => socket } as never;
	let idle = false;
	const ctx = {
		sessionManager: { getSessionId: () => "target-session", getEntries: () => entries },
		isIdle: () => idle,
		abort: () => {},
	};
	const state = createSocketState();
	state.context = ctx as never;
	state.server = {} as never;

	const payload = {
		content: "Stop and re-check the contract before continuing",
		origin: { kind: "crew", name: "Tony", role: "lead" },
	};

	// Busy: interrupt request arrives while the target is streaming.
	idle = false;
	await handleCommand(pi, state, { type: "interrupt", payload, id: "int-e2e" }, socket);
	const response = JSON.parse(writes[0]!) as { result?: { disposition: string; interruptId: string } };
	assert.equal(response.result?.disposition, "interrupt-requested");
	const interruptId = response.result!.interruptId;
	assert.match(interruptId, /^interrupt-/);

	// Evidence: pending then handed-off persisted.
	const records = entries.filter((e) => (e as { customType?: string }).customType === INTERRUPT_ENTRY_TYPE);
	assert.equal(records.length, 2);
	assert.equal((records[0] as { data: { phase: string } }).data.phase, "pending");
	assert.equal((records[1] as { data: { phase: string } }).data.phase, "handed-off");

	// Recovery handed as a steer (never redirect, never followUp) with derived origin.
	const handoff = sent[sent.length - 1]! as {
		message: { details: { messagePayload: MessagePayload } };
		options: unknown;
	};
	assert.deepEqual(handoff.options, { triggerTurn: true, deliverAs: "steer" });
	assert.deepEqual(handoff.message.details.messagePayload.origin, { kind: "crew", name: "Tony", role: "lead" });

	// Reload recovery: simulate crash between pending and handed-off — remove the
	// handed-off entry, keep pending; a fresh flow must re-deliver.
	entries.splice(1, 1); // drop handed-off, keep pending
	const recoveredEntries: unknown[] = [...entries];
	const recoveredFlow = createInterruptFlow({
		isIdle: () => true,
		abort: async () => {},
		sendMessage: (message, options) => {
			sent.push({ message, options });
		},
		appendEntry: (customType, data) => {
			recoveredEntries.push({ type: "custom", customType, data });
		},
		getEntries: () => recoveredEntries,
	});
	const recovery = await recoveredFlow.recoverPending();
	assert.equal(recovery?.interruptId, interruptId);
	// Re-delivered as steer with derived origin.
	const last = sent[sent.length - 1]! as { options: unknown };
	assert.deepEqual(last.options, { triggerTurn: true, deliverAs: "steer" });
	const phases = recoveredEntries.map((e) => (e as { data?: { phase?: string } }).data?.phase).filter(Boolean);
	assert.deepEqual(phases, ["pending", "handed-off"]);
});
