import assert from "node:assert/strict";
import test from "node:test";
import { createMemberMessageCoordinator, type MemberMessageDependencies } from "../application/member-message.ts";
import { parseCrewManifest } from "../domain/index.ts";
import { RpcProtocolError } from "../infra/rpc-client.ts";
import { BebopClientError } from "./index.ts";
import {
	createInProcessRedirectOperation,
	createRemoteRedirectOperation,
	type InProcessRedirectOperationDependencies,
} from "./redirect-operation.ts";

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
	overrides: Partial<InProcessRedirectOperationDependencies["surface"]> = {},
	messageOverrides: Partial<MemberMessageDependencies> = {},
): InProcessRedirectOperationDependencies {
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
							disposition: command.delivery === "immediate" ? "steered" : "queued",
						},
					},
				}),
			},
			coordinator: createMemberMessageCoordinator(),
			...messageOverrides,
		},
	};
}

test("in-process Redirect preserves content and instruction order and uses immediate delivery", async () => {
	const sent: Array<{ payload: { content: string; instructions?: string[]; kind: string }; delivery: string }> = [];
	const destinations: string[] = [];
	const operation = createInProcessRedirectOperation(
		dependencies(
			{},
			{
				now: () => 1_234,
				transport: {
					send: async (endpoint, command) => {
						destinations.push(endpoint);
						sent.push(command as never);
						return {
							response: {
								type: "response",
								command: "send",
								success: true,
								id: "request-1",
								data: { deliveryId: "delivery-1", disposition: "steered" },
							},
						};
					},
				},
			},
		),
	);

	const result = await operation.redirectMember("Kelly", {
		message: "  exact bytes\n",
		instructions: ["first", "second"],
	});

	assert.deepEqual(result, {
		member: { name: "Kelly", role: "qa" },
		deliveryId: "delivery-1",
		disposition: "steered",
	});
	assert.equal(sent.length, 1);
	assert.deepEqual(
		destinations,
		["/project/.pi/bebop/sockets/kelly.sock"],
		"in-process Redirect must contact the target, not its own source socket",
	);
	assert.equal(sent[0]!.payload.content, "  exact bytes\n");
	assert.deepEqual(sent[0]!.payload.instructions, ["first", "second"]);
	assert.equal(sent[0]!.payload.kind, "redirect");
	assert.equal(sent[0]!.delivery, "immediate");
});

test("remote Redirect sends one typed member.redirect command", async () => {
	const calls: unknown[] = [];
	const controller = new AbortController();
	const operation = createRemoteRedirectOperation({
		send: async (command, options) => {
			calls.push({ command, options });
			return {
				member: { name: "Kelly", role: "qa" },
				deliveryId: "delivery-remote",
				disposition: "steered",
			};
		},
	});

	const result = await operation.redirectMember(
		"Kelly",
		{ message: "urgent", instructions: ["change direction"] },
		{ signal: controller.signal, timeoutMs: 5_000 },
	);

	assert.equal(result.disposition, "steered");
	assert.deepEqual(calls, [
		{
			command: {
				type: "member_redirect",
				target: "Kelly",
				message: "urgent",
				instructions: ["change direction"],
			},
			options: { signal: controller.signal, timeoutMs: 5_000 },
		},
	]);
});

test("in-process Redirect reads authority each call and rejects missing or untrusted membership before dispatch", async () => {
	for (const [overrides, code] of [
		[{ getMembership: () => null }, "not-joined"],
		[{ isTrusted: () => false }, "untrusted"],
	] as const) {
		let sends = 0;
		const operation = createInProcessRedirectOperation(
			dependencies(overrides, {
				transport: {
					send: async () => {
						sends += 1;
						throw new Error("unexpected dispatch");
					},
				},
			}),
		);
		await assert.rejects(
			operation.redirectMember("Kelly", { message: "urgent" }),
			(error: unknown) => error instanceof BebopClientError && error.code === code,
		);
		assert.equal(sends, 0);
	}
});

test("Redirect maps remote rejection, offline transport, cancellation, and uncertain dispatch without retry", async () => {
	const cases: Array<{ error: unknown; code: string }> = [
		{ error: new RpcProtocolError("remote-error", "unknown-member"), code: "unknown-member" },
		{ error: new RpcProtocolError("remote-error", "offline-member"), code: "offline-member" },
		{ error: Object.assign(new Error("cancelled"), { name: "AbortError", code: "aborted" }), code: "aborted" },
		{ error: Object.assign(new Error("ack lost"), { code: "outcome-unknown" }), code: "outcome-unknown" },
	];
	for (const { error, code } of cases) {
		let sends = 0;
		const operation = createInProcessRedirectOperation(
			dependencies(
				{},
				{
					transport: {
						send: async () => {
							sends += 1;
							throw error;
						},
					},
				},
			),
		);
		await assert.rejects(
			operation.redirectMember("Kelly", { message: "urgent" }),
			(failure: unknown) => failure instanceof BebopClientError && failure.code === code,
		);
		assert.equal(sends, 1, `${code} must not retry an effectful dispatch`);
	}
});

test("Redirect validates input and reports pre-dispatch cancellation", async () => {
	let sends = 0;
	const operation = createInProcessRedirectOperation(
		dependencies(
			{},
			{
				transport: {
					send: async () => {
						sends += 1;
						throw new Error("unexpected dispatch");
					},
				},
			},
		),
	);
	await assert.rejects(
		operation.redirectMember("Kelly", { message: "  " }),
		(error: unknown) => error instanceof BebopClientError && error.code === "invalid-input",
	);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		operation.redirectMember("Kelly", { message: "urgent" }, { signal: controller.signal }),
		(error: unknown) => error instanceof BebopClientError && error.code === "aborted",
	);
	assert.equal(sends, 0);
});
