import test from "node:test";
import assert from "node:assert/strict";
import {
	createInProcessMemberInboxOperation,
	createRemoteMemberInboxOperation,
	type InProcessMemberInboxOperationDependencies,
	type RemoteMemberInboxOperationDependencies,
} from "./member-inbox-operation.ts";
import { BebopClientError } from "./errors.ts";
import { MemberInboxStoreError, type MemberInboxStore } from "../infra/member-inbox-store.ts";
import { RpcProtocolError } from "../infra/rpc-client.ts";
import type { MemberInboxMessageRequest } from "../application/member-inbox-message.ts";

const target = {
	name: "Developer",
	role: "dev",
	socket: "sockets/developer.sock",
	socketPath: "/project/.pi/bebop/sockets/developer.sock",
};
const membership = {
	member: {
		name: "Lead",
		role: "lead",
		socket: "sockets/lead.sock",
		socketPath: "/project/.pi/bebop/sockets/lead.sock",
	},
	socketPath: "/project/.pi/bebop/sockets/lead.sock",
	manifestPath: "/project/.pi/bebop/crew.json",
	manifest: { members: [target] },
} as NonNullable<MemberInboxMessageRequest["membership"]>;

function store(
	enqueue: MemberInboxStore["enqueue"] = async () => ({
		item: { version: 1, id: "inbox-0-item", target: null, payload: null, enqueuedAt: 10, sequence: 0 },
	}),
): MemberInboxStore {
	return {
		memberKey: "member-key",
		enqueue,
		enqueueWithId: async () => ({ alreadyPersisted: true, itemId: "inbox-0-item" }),
		peekOldest: async () => null,
		list: async () => [],
		count: async () => 0,
		remove: async () => ({ removed: false }),
		cancel: async () => ({ removed: false }),
	};
}

function inProcessDependencies(
	overrides: Partial<InProcessMemberInboxOperationDependencies["surface"]> = {},
	dependencies: Partial<InProcessMemberInboxOperationDependencies["message"]> = {},
	now: () => number = () => Date.now(),
): InProcessMemberInboxOperationDependencies {
	return {
		surface: {
			getMembership: () => membership,
			isTrusted: () => true,
			...overrides,
		},
		message: {
			openStore: async () => store(),
			hintTransport: null,
			...dependencies,
		},
		now,
	};
}

test("remote Inbox operation sends one typed command and preserves item identity and hint", async () => {
	const sent: unknown[] = [];
	const options = { timeoutMs: 2_000 };
	const operation = createRemoteMemberInboxOperation({
		send: async (command, receivedOptions) => {
			sent.push({ command, receivedOptions });
			return {
				member: { name: "Developer", role: "dev" },
				itemId: "inbox-3-stable",
				persisted: true,
				hint: "skipped",
			};
		},
	} satisfies RemoteMemberInboxOperationDependencies);

	assert.deepEqual(
		await operation.sendToInbox("dev", { message: "persist this", instructions: ["first", "second"] }, options),
		{
			member: { name: "Developer", role: "dev" },
			itemId: "inbox-3-stable",
			persisted: true,
			hint: "skipped",
		},
	);
	assert.deepEqual(sent, [
		{
			command: {
				type: "member_inbox_send",
				target: "dev",
				message: "persist this",
				instructions: ["first", "second"],
			},
			receivedOptions: options,
		},
	]);
});

test("remote Inbox validates payload before dispatch and reports malformed acknowledgements", async () => {
	let calls = 0;
	const operation = createRemoteMemberInboxOperation({
		send: async () => {
			calls += 1;
			return {};
		},
	});
	for (const input of [
		{ message: "  " },
		{ message: "x\0y" },
		{ message: "x".repeat(1_000_001) },
		{ message: "x", instructions: Array(33).fill("step") },
		{ message: "x", instructions: [" padded "] },
	]) {
		await assert.rejects(operation.sendToInbox("dev", input), (error: unknown) => {
			assert.ok(error instanceof BebopClientError);
			assert.equal(error.code, "invalid-input");
			return true;
		});
	}
	await assert.rejects(operation.sendToInbox("dev", { message: "valid" }), (error: unknown) => {
		assert.ok(error instanceof BebopClientError);
		assert.equal(error.code, "malformed-response");
		return true;
	});
	assert.equal(calls, 1);
});

test("remote Inbox preserves lost acknowledgement and never retries enqueue", async () => {
	let calls = 0;
	const operation = createRemoteMemberInboxOperation({
		send: async () => {
			calls += 1;
			throw new RpcProtocolError("outcome-unknown", "acknowledgement lost");
		},
	});
	await assert.rejects(operation.sendToInbox("dev", { message: "once" }), (error: unknown) => {
		assert.ok(error instanceof BebopClientError);
		assert.equal(error.code, "outcome-unknown");
		return true;
	});
	assert.equal(calls, 1);
});

test("in-process Inbox reads live authority, persists offline, and preserves derived item semantics", async () => {
	let currentMembership: typeof membership | null = membership;
	let trusted = true;
	let enqueues = 0;
	let written: { payload: unknown; now: number } | undefined;
	const operation = createInProcessMemberInboxOperation(
		inProcessDependencies(
			{ getMembership: () => currentMembership, isTrusted: () => trusted },
			{
				openStore: async () =>
					store(async (payload, now) => {
						enqueues += 1;
						written = { payload, now };
						return {
							item: {
								version: 1,
								id: "inbox-4-stable",
								target: null,
								payload,
								enqueuedAt: now,
								sequence: 4,
							},
						};
					}),
				hintTransport: null,
			},
			() => 321,
		),
	);

	const persisted = await operation.sendToInbox("dev", {
		message: "offline durable",
		instructions: ["first", "second"],
	});
	assert.deepEqual(persisted, {
		member: { name: "Developer", role: "dev" },
		itemId: "inbox-4-stable",
		persisted: true,
		hint: "skipped",
	});
	assert.deepEqual(written, {
		payload: {
			content: "offline durable",
			instructions: ["first", "second"],
			origin: { kind: "crew", name: "Lead", role: "lead" },
		},
		now: 321,
	});
	assert.equal(enqueues, 1);

	currentMembership = null;
	await assert.rejects(operation.sendToInbox("dev", { message: "not joined" }), (error: unknown) => {
		assert.ok(error instanceof BebopClientError);
		assert.equal(error.code, "not-joined");
		return true;
	});
	currentMembership = membership;
	trusted = false;
	await assert.rejects(operation.sendToInbox("dev", { message: "untrusted" }), (error: unknown) => {
		assert.ok(error instanceof BebopClientError);
		assert.equal(error.code, "untrusted-project");
		return true;
	});
	assert.equal(enqueues, 1);
});

test("in-process Inbox rejects cancellation while opening storage before enqueue", async () => {
	const controller = new AbortController();
	let releaseOpen!: (value: MemberInboxStore) => void;
	const opening = new Promise<MemberInboxStore>((resolve) => {
		releaseOpen = resolve;
	});
	let enqueues = 0;
	const operation = createInProcessMemberInboxOperation(
		inProcessDependencies({}, { openStore: async () => opening }),
	);
	const pending = operation.sendToInbox("dev", { message: "cancel before enqueue" }, { signal: controller.signal });
	await new Promise<void>((resolve) => setImmediate(resolve));
	controller.abort();
	await assert.rejects(pending, (error: unknown) => {
		assert.ok(error instanceof BebopClientError);
		assert.equal(error.code, "aborted");
		return true;
	});
	releaseOpen(
		store(async () => {
			enqueues += 1;
			return { item: { version: 1, id: "late", target: null, payload: null, enqueuedAt: 1, sequence: 0 } };
		}),
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(enqueues, 0);
});

test("in-process Inbox reports uncertainty after enqueue dispatch and does not duplicate", async () => {
	const controller = new AbortController();
	let enteredEnqueue!: () => void;
	const enqueueStarted = new Promise<void>((resolve) => {
		enteredEnqueue = resolve;
	});
	let releaseEnqueue!: (value: {
		item: { version: 1; id: string; target: null; payload: null; enqueuedAt: number; sequence: number };
	}) => void;
	const enqueuePending = new Promise<{
		item: { version: 1; id: string; target: null; payload: null; enqueuedAt: number; sequence: number };
	}>((resolve) => {
		releaseEnqueue = resolve;
	});
	let calls = 0;
	const operation = createInProcessMemberInboxOperation(
		inProcessDependencies(
			{},
			{
				openStore: async () =>
					store(async () => {
						calls += 1;
						enteredEnqueue();
						return enqueuePending;
					}),
			},
		),
	);
	const pending = operation.sendToInbox("dev", { message: "one enqueue" }, { signal: controller.signal });
	await enqueueStarted;
	controller.abort();
	await assert.rejects(pending, (error: unknown) => {
		assert.ok(error instanceof BebopClientError);
		assert.equal(error.code, "outcome-unknown");
		return true;
	});
	releaseEnqueue({
		item: { version: 1, id: "inbox-0-one", target: null, payload: null, enqueuedAt: 1, sequence: 0 },
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(calls, 1);
});

test("in-process Inbox maps full and malformed storage boundaries without retry", async () => {
	let calls = 0;
	const full = createInProcessMemberInboxOperation(
		inProcessDependencies(
			{},
			{
				openStore: async () =>
					store(async () => {
						calls += 1;
						throw new MemberInboxStoreError("capacity-exceeded", "full");
					}),
			},
		),
	);
	await assert.rejects(full.sendToInbox("dev", { message: "full" }), (error: unknown) => {
		assert.ok(error instanceof BebopClientError);
		assert.equal(error.code, "inbox-full");
		return true;
	});
	assert.equal(calls, 1);
});
