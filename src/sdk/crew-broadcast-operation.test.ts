import assert from "node:assert/strict";
import { test } from "node:test";
import type { CrewManifest } from "../domain/index.ts";
import { createMemberMessageCoordinator, type MemberMessageDependencies } from "../application/member-message.ts";
import { RpcProtocolError } from "../infra/rpc-client.ts";
import { BebopClientError } from "./errors.ts";
import {
	createInProcessCrewBroadcastOperation,
	createRemoteCrewBroadcastOperation,
	type InProcessCrewBroadcastOperationDependencies,
	type RemoteCrewBroadcastCommand,
} from "./crew-broadcast-operation.ts";

const manifest: CrewManifest = {
	version: 1,
	presence: { notifications: true },
	members: [
		{ name: "Tony", role: "lead", socket: "tony.sock", socketPath: "/crew/tony.sock" },
		{ name: "Mary", role: "po", socket: "mary.sock", socketPath: "/crew/mary.sock" },
		{ name: "Bob", role: "dev", socket: "bob.sock", socketPath: "/crew/bob.sock" },
		{ name: "Kelly", role: "qa", socket: "kelly.sock", socketPath: "/crew/kelly.sock" },
	],
};
const membership = {
	manifestPath: "/crew/.pi/bebop/crew.json",
	socketPath: "/crew/bob.sock",
	member: manifest.members[2]!,
	manifest,
};
const wireResult = {
	dispositions: [
		{ member: "Tony", role: "lead", disposition: "delivered", deliveryId: "delivery-1" },
		{ member: "Mary", role: "po", disposition: "failed", code: "offline" },
	],
	summary: { delivered: 1, failed: 1, total: 2 },
};

function memberMessageDependencies(
	calls: { endpoint: string; command: { type: string; payload?: { kind?: string }; delivery?: string } }[],
	onSend?: (endpoint: string, signal?: AbortSignal) => Promise<void>,
): MemberMessageDependencies {
	return {
		resolveEndpoint: async (endpoint) => endpoint,
		coordinator: createMemberMessageCoordinator(),
		transport: {
			async send(endpoint, command, options) {
				calls.push({ endpoint, command });
				await onSend?.(endpoint, options.signal);
				return {
					response: {
						success: true,
						data: { deliveryId: `delivery-${calls.length}`, disposition: "queued" },
					} as never,
				};
			},
		},
		now: () => 1_000,
	};
}

function inProcessDependencies(
	calls: { endpoint: string; command: { type: string; payload?: { kind?: string }; delivery?: string } }[],
	overrides: Partial<InProcessCrewBroadcastOperationDependencies["surface"]> = {},
	onSend?: (endpoint: string, signal?: AbortSignal) => Promise<void>,
): InProcessCrewBroadcastOperationDependencies {
	return {
		surface: {
			getMembership: () => membership,
			isTrusted: () => true,
			approvedGuests: () => [],
			...overrides,
		},
		message: memberMessageDependencies(calls, onSend),
	};
}

test("remote Broadcast sends one typed RPC and maps wire recipients to the shared result", async () => {
	const sent: { command: RemoteCrewBroadcastCommand; options?: { signal?: AbortSignal; timeoutMs?: number } }[] = [];
	const controller = new AbortController();
	const operation = createRemoteCrewBroadcastOperation({
		send: async (command, options) => {
			sent.push({ command, options });
			return wireResult;
		},
	});

	const result = await operation.broadcastToCrew(
		{ message: "Release is ready", instructions: ["check the notes"] },
		{ signal: controller.signal, timeoutMs: 3_000 },
	);

	assert.deepEqual(sent, [
		{
			command: { type: "crew_broadcast", message: "Release is ready", instructions: ["check the notes"] },
			options: { signal: controller.signal, timeoutMs: 3_000 },
		},
	]);
	assert.deepEqual(result, {
		ok: true,
		dispositions: [
			{ recipientName: "Tony", recipientRole: "lead", disposition: "delivered", deliveryId: "delivery-1" },
			{ recipientName: "Mary", recipientRole: "po", disposition: "failed", code: "offline" },
		],
		summary: { delivered: 1, failed: 1, total: 2 },
	});
});

test("remote Broadcast maps no recipients, rejects malformed results, and never retries a lost acknowledgement", async () => {
	let calls = 0;
	const operation = createRemoteCrewBroadcastOperation({
		send: async () => {
			calls += 1;
			throw Object.assign(new Error("outcome unknown"), { code: "outcome-unknown" });
		},
	});
	await assert.rejects(operation.broadcastToCrew({ message: "hello" }), (error) => {
		assert.ok(error instanceof BebopClientError);
		assert.equal(error.code, "outcome-unknown");
		return true;
	});
	assert.equal(calls, 1);

	const noRecipients = createRemoteCrewBroadcastOperation({
		send: async () => {
			throw new RpcProtocolError("remote-error", "no-recipients");
		},
	});
	assert.deepEqual(await noRecipients.broadcastToCrew({ message: "hello" }), {
		ok: false,
		code: "no-recipients",
	});

	const untrusted = createRemoteCrewBroadcastOperation({
		send: async () => {
			throw new Error("remote-error: untrusted-project: trust is required");
		},
	});
	await assert.rejects(untrusted.broadcastToCrew({ message: "hello" }), (error) => {
		assert.ok(error instanceof BebopClientError);
		assert.equal(error.code, "untrusted");
		return true;
	});

	const malformed = createRemoteCrewBroadcastOperation({ send: async () => ({ dispositions: [], summary: {} }) });
	await assert.rejects(malformed.broadcastToCrew({ message: "hello" }), (error) => {
		assert.ok(error instanceof BebopClientError);
		assert.equal(error.code, "malformed-response");
		return true;
	});
});

test("in-process Broadcast reads current trust and membership, excludes sender, and preserves member then Guest order", async () => {
	const calls: { endpoint: string; command: { type: string; payload?: { kind?: string }; delivery?: string } }[] = [];
	let currentMembership: typeof membership | null = membership;
	let trusted = true;
	const operation = createInProcessCrewBroadcastOperation(
		inProcessDependencies(calls, {
			getMembership: () => currentMembership,
			isTrusted: () => trusted,
			approvedGuests: () => [
				{ guestName: "Alex", guestIdentity: "guest-id", callbackEndpoint: "/crew/alex.sock" },
			],
		}),
	);

	const result = await operation.broadcastToCrew({ message: "Release is ready" });
	assert.deepEqual(result.ok && result.dispositions.map((item) => item.recipientName), [
		"Tony",
		"Mary",
		"Kelly",
		"Alex",
	]);
	assert.ok(calls.every((call) => call.command.type === "send" && call.command.delivery === "follow_up"));
	assert.ok(calls.every((call) => call.command.payload?.kind === "broadcast"));

	currentMembership = null;
	await assert.rejects(operation.broadcastToCrew({ message: "hello" }), (error) => {
		assert.ok(error instanceof BebopClientError);
		assert.equal(error.code, "not-joined");
		return true;
	});
	currentMembership = membership;
	trusted = false;
	await assert.rejects(operation.broadcastToCrew({ message: "hello" }), (error) => {
		assert.ok(error instanceof BebopClientError);
		assert.equal(error.code, "untrusted");
		return true;
	});
	assert.equal(calls.length, 4);
});

test("in-process cancelled fan-out records every recipient once and never retries or redirects", async () => {
	const calls: { endpoint: string; command: { type: string; payload?: { kind?: string }; delivery?: string } }[] = [];
	const controller = new AbortController();
	const operation = createInProcessCrewBroadcastOperation(
		inProcessDependencies(calls, {}, async (_endpoint) => {
			controller.abort();
			throw Object.assign(new Error("cancelled"), { name: "AbortError" });
		}),
	);

	const result = await operation.broadcastToCrew({ message: "hello" }, { signal: controller.signal });
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.deepEqual(
			result.dispositions.map((item) => item.code),
			["aborted", "aborted", "aborted"],
		);
		assert.deepEqual(result.summary, { delivered: 0, failed: 3, total: 3 });
	}
	assert.deepEqual(
		calls.map((call) => call.endpoint),
		["/crew/tony.sock"],
	);
	assert.ok(
		calls.every((call) => call.command.delivery === "follow_up" && call.command.payload?.kind === "broadcast"),
	);
});

test("Broadcast validates message limits and timeout before dispatch", async () => {
	let calls = 0;
	const operation = createRemoteCrewBroadcastOperation({
		send: async () => {
			calls += 1;
			return wireResult;
		},
	});
	await assert.rejects(operation.broadcastToCrew({ message: " \n " }), (error) => {
		assert.equal((error as BebopClientError).code, "invalid-input");
		return true;
	});
	await assert.rejects(operation.broadcastToCrew({ message: "hello" }, { timeoutMs: 0 }), (error) => {
		assert.equal((error as BebopClientError).code, "invalid-input");
		return true;
	});
	assert.equal(calls, 0);
});
