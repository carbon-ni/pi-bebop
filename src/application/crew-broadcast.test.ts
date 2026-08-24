import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CrewManifest, CrewMember } from "../domain/index.ts";
import { submitCrewBroadcast, type CrewBroadcastApplicationError } from "./crew-broadcast.ts";
import { MemberInboxStoreError, type MemberInboxStore } from "../infra/member-inbox-store.ts";

function makeCrew(overrides: Array<Partial<CrewMember>> = []): { crew: CrewManifest; byName: Map<string, CrewMember> } {
	const members: CrewMember[] = (
		[
			{ name: "Tony", role: "lead", socket: "sockets/lead.sock", socketPath: "/p/.pi/bebop/sockets/lead.sock" },
			{ name: "Mary", role: "po", socket: "sockets/po.sock", socketPath: "/p/.pi/bebop/sockets/po.sock" },
			{ name: "Bob", role: "dev", socket: "sockets/bob.sock", socketPath: "/p/.pi/bebop/sockets/bob.sock" },
			{ name: "Kelly", role: "qa", socket: "sockets/kelly.sock", socketPath: "/p/.pi/bebop/sockets/kelly.sock" },
		] as CrewMember[]
	).map((member, index) => ({ ...member, ...(overrides[index] ?? {}) }));
	return {
		crew: { version: 1, presence: { notifications: true }, members },
		byName: new Map(members.map((m) => [m.name, m])),
	};
}
interface FakeInbox {
	items: Array<{ id: string; payload: MessagePayload; sequence: number }>;
	enqueueWithId: (...args: unknown[]) => Promise<unknown>;
}

function makeStore(): FakeInbox {
	const inbox: FakeInbox = {
		items: [],
		enqueueWithId: async () => ({ item: { id: "ignored" } }),
	};
	return inbox;
}

interface MakeOpts {
	crew: Crew;
	enqueued: Map<string, FakeInbox>;
	failedSockets?: Set<string>;
	abortSignal?: AbortSignal;
}

function makeDeps(opts: MakeOpts) {
	const openStore = async (options: {
		manifestPath: string;
		projectRoot: string;
		isProjectTrusted: () => boolean;
		member: Member;
	}): Promise<MemberInboxStore> => {
		let inbox = opts.enqueued.get(options.member.name);
		if (!inbox) {
			inbox = makeStore();
			opts.enqueued.set(options.member.name, inbox);
		}
		return {
			memberKey: options.member.name,
			enqueue: async (payload, now) => {
				const entry = { id: `inbox-${opts.enqueued.size}`, payload: payload as MessagePayload, sequence: 0 };
				inbox!.items.push(entry);
				return { item: entry as never };
			},
			enqueueWithId: async (payload, now, id) => {
				if (opts.failedSockets?.has(options.member.name))
					throw new MemberInboxStoreError("write-failed", "disk full");
				const exists = inbox!.items.some((item) => item.id === id);
				if (exists) return { alreadyPersisted: true, itemId: id };
				const item = { id, payload: payload as MessagePayload, sequence: inbox!.items.length };
				inbox!.items.push(item);
				return { item };
			},
			peekOldest: async () => null,
			list: async () => [],
			count: async () => inbox!.items.length,
			remove: async () => ({ removed: true }),
			cancel: async () => ({ removed: true }),
		} as MemberInboxStore;
	};
	return { openStore };
}

function makeMembership(crew: Crew, senderName: string) {
	const sender = crew.members.find((member) => member.name === senderName)!;
	return {
		manifestPath: "/p/.pi/bebop/crew.json",
		socketPath: sender.socketPath,
		globalSocketPath: "/p/.pi/bebop/global.sock",
		member: sender,
		manifest: crew,
	};
}

describe("submitCrewBroadcast", () => {
	test("rejects when not joined", async () => {
		const { crew } = makeCrew();
		const deps = makeDeps({ crew, enqueued: new Map() });
		await assert.rejects(
			submitCrewBroadcast(
				{ membership: null, message: "hi", now: 1 },
				{ isProjectTrusted: () => true, openStore: deps.openStore },
			),
			(error) => (error as CrewBroadcastApplicationError).code === "not-joined",
		);
	});

	test("defensive: unknown sender resolves to ok:false without IO", async () => {
		const { crew } = makeCrew();
		const enqueued = new Map<string, FakeInbox>();
		const { openStore } = makeDeps({ crew, enqueued });
		const ghost = { ...makeMembership(crew, "Tony"), member: { ...crew.members[0]!, name: "Ghost" } };
		const result = await submitCrewBroadcast(
			{ membership: ghost as never, message: "hi", now: 1 },
			{ isProjectTrusted: () => true, openStore },
		);
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.code, "unknown-sender");
		assert.equal(enqueued.size, 0, "no store IO on unknown sender");
	});

	test("single-member crew (only sender) returns no-recipients without any IO", async () => {
		const crew: Crew = {
			version: 1,
			presence: { notifications: true },
			members: [makeCrew().crew.members[0]!],
		};
		const enqueued = new Map<string, FakeInbox>();
		const { openStore } = makeDeps({ crew, enqueued });
		const result = await submitCrewBroadcast(
			{ membership: makeMembership(crew, "Tony"), message: "hi", now: 1 },
			{ isProjectTrusted: () => true, openStore },
		);
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.code, "no-recipients");
		assert.equal(enqueued.size, 0, "no store IO on no-recipients");
	});

	test("fans out to every other member in manifest order with derived crew origin", async () => {
		const { crew } = makeCrew();
		const enqueued = new Map<string, FakeInbox>();
		const { openStore } = makeDeps({ crew, enqueued });
		const result = await submitCrewBroadcast(
			{
				membership: makeMembership(crew, "Bob"),
				message: "API changed",
				now: 100,
				instructions: ["pull latest"],
			},
			{ isProjectTrusted: () => true, openStore },
		);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.summary.persisted, 3);
		assert.equal(result.summary.failed, 0);
		assert.deepEqual(
			result.dispositions.map((d) => d.recipientName),
			["Tony", "Mary", "Kelly"],
		);
		// Every non-sender member got exactly one item.
		assert.deepEqual(Array.from(enqueued.keys()).sort(), ["Kelly", "Mary", "Tony"]);
		for (const [name, inbox] of enqueued) {
			assert.equal(inbox.items.length, 1, `${name} should have one broadcast item`);
			assert.equal(inbox.items[0]!.payload.content, "API changed");
			assert.deepEqual(inbox.items[0]!.payload.origin, { kind: "crew", name: "Bob", role: "dev" });
		}
	});

	test("instructions are passed through and no replyTo is attached", async () => {
		const { crew } = makeCrew();
		const enqueued = new Map<string, FakeInbox>();
		const { openStore } = makeDeps({ crew, enqueued });
		const result = await submitCrewBroadcast(
			{
				membership: makeMembership(crew, "Bob"),
				message: "refresh",
				now: 1,
				instructions: ["step one", "step two"],
			},
			{ isProjectTrusted: () => true, openStore },
		);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		const first = enqueued.values().next().value as FakeInbox;
		assert.deepEqual(first.items[0]!.payload.instructions, ["step one", "step two"]);
		assert.ok(!("replyTo" in first.items[0]!.payload));
	});

	test("deterministic stable id is identical across duplicate submissions (retry idempotency)", async () => {
		const { crew } = makeCrew();
		const first = makeDeps({ crew, enqueued: new Map() });
		const second = makeDeps({ crew, enqueued: new Map() });
		const a = await submitCrewBroadcast(
			{ membership: makeMembership(crew, "Bob"), message: "same", now: 1 },
			{ isProjectTrusted: () => true, openStore: first.openStore },
		);
		const b = await submitCrewBroadcast(
			{ membership: makeMembership(crew, "Bob"), message: "same", now: 1 },
			{ isProjectTrusted: () => true, openStore: second.openStore },
		);
		assert.equal(a.ok && b.ok, true);
		if (!a.ok || !b.ok) return;
		assert.equal(b.broadcastId, a.broadcastId);
		assert.deepEqual(
			b.dispositions.map((d) => d.itemId),
			a.dispositions.map((d) => d.itemId),
		);
		assert.equal(a.summary.persisted, 3);
		assert.equal(b.summary.persisted, 3);
	});

	test("retry after partial failure marks already-persisted for successful recipients", async () => {
		const { crew } = makeCrew();
		const enqueued = new Map<string, FakeInbox>();
		const failedSockets = new Set<string>(["Kelly"]); // one recipient fails first time
		const deps = makeDeps({ crew, enqueued, failedSockets });

		// First attempt: Kelly store throws on enqueue.
		const first = await submitCrewBroadcast(
			{ membership: makeMembership(crew, "Bob"), message: "announce", now: 1 },
			{ isProjectTrusted: () => true, openStore: deps.openStore },
		);
		assert.equal(first.ok, true);
		if (!first.ok) return;
		assert.equal(first.summary.persisted, 2, "Tony+Mary persisted");
		assert.equal(first.summary.failed, 1);
		const failedDisp = first.dispositions.find((d) => d.status === "failed");
		assert.equal(failedDisp?.recipientName, "Kelly");
		assert.equal(failedDisp?.code, "storage-unavailable");

		// Second attempt: Kelly now succeeds with already-persisted skipped.
		failedSockets.delete("Kelly");
		const second = await submitCrewBroadcast(
			{ membership: makeMembership(crew, "Bob"), message: "announce", now: 1 },
			{ isProjectTrusted: () => true, openStore: deps.openStore },
		);
		assert.equal(second.ok, true);
		if (!second.ok) return;
		assert.equal(second.summary.persisted, 1, "retry persists only Kelly");
		assert.equal(second.summary.alreadyPersisted, 2);
		// And total items per member stay exactly one.
		for (const inbox of enqueued.values()) assert.equal(inbox.items.length, 1);
	});

	test("full inbox maps to a failed disposition with inbox-full and others persist", async () => {
		const { crew } = makeCrew();
		const enqueued = new Map<string, FakeInbox>();
		const { openStore } = makeDeps({ crew, enqueued });
		const originalOpen = openStore;
		const wrappedOpen: typeof openStore = async (options) => {
			const store = await originalOpen(options);
			if (options.member.name === "Kelly") {
				return {
					...store,
					enqueueWithId: async () => Promise.reject(new MemberInboxStoreError("capacity-exceeded", "full")),
				};
			}
			return store;
		};
		const result = await submitCrewBroadcast(
			{ membership: makeMembership(crew, "Bob"), message: "announce", now: 1 },
			{ isProjectTrusted: () => true, openStore: wrappedOpen },
		);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.summary.persisted + result.summary.alreadyPersisted, 2);
		assert.equal(result.summary.failed, 1);
		assert.equal(result.dispositions.find((d) => d.recipientName === "Kelly")?.code, "inbox-full");
	});

	test("untrusted project fails fast without persistence", async () => {
		const { crew } = makeCrew();
		const enqueued = new Map<string, FakeInbox>();
		const { openStore } = makeDeps({ crew, enqueued });
		await assert.rejects(
			submitCrewBroadcast(
				{ membership: makeMembership(crew, "Bob"), message: "hi", now: 1 },
				{ isProjectTrusted: () => false, openStore },
			),
			(error) => (error as CrewBroadcastApplicationError).code === "untrusted-project",
		);
		assert.equal(enqueued.size, 0);
	});

	test("abort marks remaining recipients failed with aborted without IO", async () => {
		const { crew } = makeCrew();
		const enqueued = new Map<string, FakeInbox>();
		const { openStore } = makeDeps({ crew, enqueued });
		const controller = new AbortController();
		controller.abort();
		const result = await submitCrewBroadcast(
			{
				membership: makeMembership(crew, "Bob"),
				message: "hi",
				now: 1,
				signal: controller.signal,
			},
			{ isProjectTrusted: () => true, openStore },
		);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.summary.failed, 3);
		assert.ok(result.dispositions.every((d) => d.code === "aborted"));
		assert.equal(enqueued.size, 0, "no IO after abort");
	});

	test("abort after one persistence preserves the first write and marks remaining recipients aborted", async () => {
		const { crew } = makeCrew();
		const enqueued = new Map<string, FakeInbox>();
		const controller = new AbortController();
		const base = makeDeps({ crew, enqueued });
		let opened = 0;
		const openStore = async (options: Parameters<typeof base.openStore>[0]) => {
			const store = await base.openStore(options);
			opened += 1;
			if (opened !== 1) return store;
			return {
				...store,
				enqueueWithId: async (...args: Parameters<MemberInboxStore["enqueueWithId"]>) => {
					const result = await store.enqueueWithId(...args);
					controller.abort();
					return result;
				},
			};
		};
		const result = await submitCrewBroadcast(
			{ membership: makeMembership(crew, "Bob"), message: "partial", now: 1, signal: controller.signal },
			{ isProjectTrusted: () => true, openStore },
		);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(
			result.dispositions.map((item) => item.status),
			["persisted", "failed", "failed"],
		);
		assert.deepEqual(
			result.dispositions.slice(1).map((item) => item.code),
			["aborted", "aborted"],
		);
		assert.equal(result.summary.persisted, 1);
		assert.equal(result.summary.failed, 2);
		assert.equal(enqueued.size, 1, "abort stops IO for remaining recipients");
	});

	test("invalid payload rejects", async () => {
		const { crew } = makeCrew();
		const enqueued = new Map<string, FakeInbox>();
		const { openStore } = makeDeps({ crew, enqueued });
		await assert.rejects(
			submitCrewBroadcast(
				{ membership: makeMembership(crew, "Bob"), message: "   ", now: 1 },
				{ isProjectTrusted: () => true, openStore },
			),
			(error) => (error as CrewBroadcastApplicationError).code === "invalid-request",
		);
	});

	test("concurrent identical submissions do not duplicate", async () => {
		const { crew } = makeCrew();
		const enqueued = new Map<string, FakeInbox>();
		const { openStore } = makeDeps({ crew, enqueued });
		const [a, b] = await Promise.all([
			submitCrewBroadcast(
				{ membership: makeMembership(crew, "Bob"), message: "race", now: 1 },
				{ isProjectTrusted: () => true, openStore },
			),
			submitCrewBroadcast(
				{ membership: makeMembership(crew, "Bob"), message: "race", now: 1 },
				{ isProjectTrusted: () => true, openStore },
			),
		]);
		assert.equal(a.ok && b.ok, true);
		if (!a.ok || !b.ok) return;
		assert.equal((a as { broadcastId: string }).broadcastId, (b as { broadcastId: string }).broadcastId);
		for (const inbox of enqueued.values()) assert.equal(inbox.items.length, 1, "no dupes under concurrency");
	});

	test("empty instructions is equivalent to absent", async () => {
		const { crew } = makeCrew();
		const enqueued = new Map<string, FakeInbox>();
		const { openStore } = makeDeps({ crew, enqueued });
		const result = await submitCrewBroadcast(
			{ membership: makeMembership(crew, "Bob"), message: "hi", now: 1, instructions: [] },
			{ isProjectTrusted: () => true, openStore },
		);
		assert.equal(result.ok, true);
	});
});
