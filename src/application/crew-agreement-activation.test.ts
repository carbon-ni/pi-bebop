import { test } from "node:test";
import assert from "node:assert/strict";
import { activateAgreementRevision } from "./crew-agreement-activation.ts";
import type { CrewAgreementStore } from "../infra/crew-agreement-store.ts";
import type { MemberInboxStore } from "../infra/member-inbox-store.ts";

function inbox(result: "persisted" | "already-persisted" = "persisted"): MemberInboxStore {
	return {
		memberKey: "member-key",
		enqueue: async () => {
			throw new Error("unused");
		},
		enqueueWithId: async () =>
			result === "persisted"
				? ({ item: {} as never } as const)
				: ({ alreadyPersisted: true, itemId: "stable" } as const),
		peekOldest: async () => null,
		list: async () => [],
		count: async () => 0,
		remove: async () => ({ removed: false }),
		cancel: async () => ({ removed: false }),
	};
}

function store(): CrewAgreementStore {
	return {
		putProposal: async () => {
			throw new Error("unused");
		},
		putRevision: async () => {
			throw new Error("unused");
		},
		activateRevision: async (revisionId) => ({
			revisionId,
			priorRevisionId: "genesis",
			disposition: "activated",
		}),
		show: async () => {
			throw new Error("unused");
		},
		list: async () => [],
	};
}

const membership = {
	manifestPath: "/project/.pi/bebop/crew.json",
	manifest: {
		version: 2 as const,
		presence: { notifications: true },
		members: [
			{
				name: "Mary",
				role: "po",
				socket: "sockets/mary.sock",
				socketPath: "/project/.pi/bebop/sockets/mary.sock",
			},
			{
				name: "Kelly",
				role: "qa",
				socket: "sockets/kelly.sock",
				socketPath: "/project/.pi/bebop/sockets/kelly.sock",
			},
		],
	},
};

test("activation persists before bounded per-member notices and retries partial fan-out", async () => {
	const calls: string[] = [];
	const result = await activateAgreementRevision(membership, "revision-1", {
		isProjectTrusted: () => true,
		openAgreementStore: async () => store(),
		openInboxStore: async ({ member }) => {
			calls.push(member.name);
			if (member.name === "Kelly") throw new Error("inbox offline");
			return inbox();
		},
		now: () => 123,
	});
	assert.equal(result.activation.disposition, "activated");
	assert.deepEqual(calls, ["Mary", "Kelly"]);
	assert.deepEqual(
		result.notices.map((notice) => notice.status),
		["persisted", "failed"],
	);
	assert.equal(result.notices[1]?.member, "Kelly");
});

test("untrusted activation stops before any Agreement or Inbox operation", async () => {
	let agreementOpened = false;
	let inboxOpened = false;
	await assert.rejects(() =>
		activateAgreementRevision(membership, "revision-1", {
			isProjectTrusted: () => false,
			openAgreementStore: async () => {
				agreementOpened = true;
				return store();
			},
			openInboxStore: async () => {
				inboxOpened = true;
				return inbox();
			},
			now: () => 123,
		}),
	);
	assert.equal(agreementOpened, false);
	assert.equal(inboxOpened, false);
});
