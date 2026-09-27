import assert from "node:assert/strict";
import test from "node:test";
import { createMemberMessageCoordinator, type MemberMessageDependencies } from "../application/member-message.ts";
import { parseCrewManifest } from "../domain/index.ts";
import { BebopClientError } from "./index.ts";
import {
	createInProcessFollowUpOperation,
	createRemoteFollowUpOperation,
	type InProcessFollowUpOperationDependencies,
} from "./follow-up-operation.ts";

const manifest = parseCrewManifest(
	{
		version: 1,
		members: [
			{ name: "Dave", role: "developer", socket: "sockets/dave.sock" },
			{ name: "Kelly", role: "qa", socket: "sockets/kelly.sock" },
		],
	},
	"/project/.pi/bebop/crew.json",
);
const membership = {
	manifestPath: "/project/.pi/bebop/crew.json",
	manifest,
	member: { ...manifest.members[0]!, socketPath: "/project/.pi/bebop/sockets/dave.sock" },
	socketPath: "/project/.pi/bebop/sockets/dave.sock",
	globalSocketPath: "/project/global.sock",
};

function dependencies(
	overrides: Partial<InProcessFollowUpOperationDependencies["surface"]> = {},
	messageOverrides: Partial<MemberMessageDependencies> = {},
): InProcessFollowUpOperationDependencies {
	return {
		surface: {
			getMembership: () => membership,
			isTrusted: () => true,
			approvedGuests: () => [],
			...overrides,
		},
		message: {
			resolveEndpoint: async (endpoint) => endpoint,
			transport: {
				send: async (_endpoint, command) => ({
					response: {
						type: "response",
						command: "send",
						success: true,
						id: "request-1",
						data: {
							deliveryId: "delivery-1",
							disposition: command.delivery === "follow_up" ? "queued" : "steered",
						},
					},
				}),
			},
			coordinator: createMemberMessageCoordinator(),
			...messageOverrides,
		},
	};
}

test("in-process Follow-up preserves content and instruction order through the runtime operation", async () => {
	const sent: Array<{ payload: { content: string; instructions?: string[] }; delivery: string }> = [];
	const operation = createInProcessFollowUpOperation(
		dependencies(
			{},
			{
				transport: {
					send: async (_endpoint, command) => {
						sent.push(command as never);
						return {
							response: {
								type: "response",
								command: "send",
								success: true,
								id: "request-1",
								data: {
									deliveryId: "delivery-1",
									disposition: "queued",
								},
							},
						};
					},
				},
			},
		),
	);

	const result = await operation.sendFollowUp("Kelly", {
		message: "  exact bytes\n",
		instructions: ["first", "second"],
	});

	assert.deepEqual(result, {
		member: { name: "Kelly", role: "qa" },
		deliveryId: "delivery-1",
		disposition: "queued",
	});
	assert.equal(sent.length, 1);
	assert.equal(sent[0]!.payload.content, "  exact bytes\n");
	assert.deepEqual(sent[0]!.payload.instructions, ["first", "second"]);
	assert.equal(sent[0]!.delivery, "follow_up");
});

test("in-process Follow-up treats an empty instruction list as omitted", async () => {
	let payload: Record<string, unknown> | undefined;
	const operation = createInProcessFollowUpOperation(
		dependencies(
			{},
			{
				now: () => 1_234,
				transport: {
					send: async (_endpoint, command) => {
						payload = command.payload as Record<string, unknown>;
						return {
							response: {
								type: "response",
								command: "send",
								success: true,
								id: "request-empty",
								data: { deliveryId: "delivery-empty", disposition: "queued" },
							},
						};
					},
				},
			},
		),
	);

	await operation.sendFollowUp("Kelly", { message: "hello", instructions: [] });

	assert.deepEqual(payload, {
		content: "hello",
		origin: { kind: "crew", name: "Dave", role: "developer" },
		kind: "follow-up",
		sentAt: 1_234,
	});
});

test("in-process Follow-up uses fresh approved Guest routing and runtime reply metadata", async () => {
	let deliveredEndpoint = "";
	let deliveredPayload: Record<string, unknown> | undefined;
	const operation = createInProcessFollowUpOperation(
		dependencies(
			{
				approvedGuests: () => [
					{
						guestName: "Mony",
						guestIdentity: "mony@example.test",
						callbackEndpoint: "/guest/mony.sock",
					},
				],
				sender: () => ({ sessionId: "source-session", sessionName: "Dave" }),
			},
			{
				now: () => 1_234,
				transport: {
					send: async (endpoint, command) => {
						deliveredEndpoint = endpoint;
						deliveredPayload = command.payload as Record<string, unknown>;
						return {
							response: {
								type: "response",
								command: "send",
								success: true,
								id: "request-guest",
								data: { deliveryId: "delivery-guest", disposition: "queued" },
							},
						};
					},
				},
			},
		),
	);

	const result = await operation.sendFollowUp("Mony", { message: "hello" });

	assert.deepEqual(result.member, { name: "Mony", role: "guest" });
	assert.equal(deliveredEndpoint, "/guest/mony.sock");
	assert.deepEqual(deliveredPayload?.origin, { kind: "crew", name: "Dave", role: "developer" });
	assert.deepEqual(deliveredPayload?.replyTo, { sessionId: "source-session", sessionName: "Dave" });
});

test("remote Follow-up sends one typed command and returns the acknowledged result", async () => {
	const commands: unknown[] = [];
	const controller = new AbortController();
	const operation = createRemoteFollowUpOperation({
		send: async (command, options) => {
			commands.push({ command, options });
			return {
				member: { name: "Kelly", role: "qa" },
				deliveryId: "delivery-remote",
				disposition: "queued",
			};
		},
	});

	const result = await operation.sendFollowUp(
		"Kelly",
		{ message: "hello", instructions: [] },
		{ signal: controller.signal, timeoutMs: 5_000 },
	);

	assert.deepEqual(result, {
		member: { name: "Kelly", role: "qa" },
		deliveryId: "delivery-remote",
		disposition: "queued",
	});
	assert.equal(commands.length, 1);
	assert.deepEqual(commands[0], {
		command: { type: "member_follow_up", target: "Kelly", message: "hello" },
		options: { signal: controller.signal, timeoutMs: 5_000 },
	});
});

test("in-process Follow-up reads membership and trust for every call", async () => {
	let membershipReads = 0;
	let trustReads = 0;
	let sends = 0;
	const operation = createInProcessFollowUpOperation(
		dependencies(
			{
				getMembership: () => {
					membershipReads += 1;
					return membership;
				},
				isTrusted: () => {
					trustReads += 1;
					return true;
				},
			},
			{
				transport: {
					send: async () => {
						sends += 1;
						return {
							response: {
								type: "response",
								command: "send",
								success: true,
								id: "request-1",
								data: {
									deliveryId: "delivery-1",
									disposition: "queued",
								},
							},
						};
					},
				},
			},
		),
	);

	await operation.sendFollowUp("Kelly", { message: "one" });
	await operation.sendFollowUp("Kelly", { message: "two" });

	assert.equal(membershipReads, 2);
	assert.equal(trustReads, 2);
	assert.equal(sends, 2);
});

test("in-process Follow-up denies missing membership and untrusted authority before transport", async () => {
	for (const [overrides, code] of [
		[{ getMembership: () => null }, "not-joined"],
		[{ isTrusted: () => false }, "untrusted"],
	] as const) {
		let resolutions = 0;
		let sends = 0;
		const operation = createInProcessFollowUpOperation(
			dependencies(overrides, {
				resolveEndpoint: async (endpoint) => {
					resolutions += 1;
					return endpoint;
				},
				transport: {
					send: async () => {
						sends += 1;
						throw new Error("unexpected send");
					},
				},
			}),
		);
		await assert.rejects(
			operation.sendFollowUp("Kelly", { message: "hello" }),
			(error: unknown) => error instanceof BebopClientError && error.code === code,
		);
		assert.equal(resolutions, 0);
		assert.equal(sends, 0);
	}
});

test("in-process Follow-up distinguishes pre-dispatch abort and lost acknowledgement", async () => {
	const controller = new AbortController();
	controller.abort();
	let sends = 0;
	const preDispatch = createInProcessFollowUpOperation(
		dependencies(
			{},
			{
				transport: {
					send: async () => {
						sends += 1;
						throw new Error("unexpected send");
					},
				},
			},
		),
	);
	await assert.rejects(
		preDispatch.sendFollowUp("Kelly", { message: "hello" }, { signal: controller.signal }),
		(error: unknown) => error instanceof BebopClientError && error.code === "aborted",
	);
	assert.equal(sends, 0);

	const lostAck = createInProcessFollowUpOperation(
		dependencies(
			{},
			{
				transport: {
					send: async () => {
						throw Object.assign(new Error("ack lost"), { code: "outcome-unknown" });
					},
				},
			},
		),
	);
	await assert.rejects(
		lostAck.sendFollowUp("Kelly", { message: "hello" }),
		(error: unknown) => error instanceof BebopClientError && error.code === "outcome-unknown",
	);
});
