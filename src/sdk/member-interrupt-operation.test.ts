import assert from "node:assert/strict";
import test from "node:test";
import { parseCrewManifest } from "../domain/index.ts";
import { RpcProtocolError } from "../infra/rpc-client.ts";
import { BebopClientError } from "./index.ts";
import {
	createInProcessMemberInterruptOperation,
	createRemoteMemberInterruptOperation,
	type InProcessMemberInterruptOperationDependencies,
} from "./member-interrupt-operation.ts";

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

function inProcessDependencies(
	overrides: Partial<InProcessMemberInterruptOperationDependencies["surface"]> = {},
	transport: Partial<InProcessMemberInterruptOperationDependencies["transport"]> = {},
): InProcessMemberInterruptOperationDependencies {
	return {
		surface: {
			getMembership: () => membership,
			isTrusted: () => true,
			...overrides,
		},
		resolveEndpoint: async (socketPath) => socketPath,
		transport: {
			send: async (_endpoint, _command, _options) => ({
				response: {
					type: "response",
					command: "interrupt",
					success: true,
					id: "request-1",
					data: { interruptId: "interrupt-1", disposition: "interrupt-requested" },
				},
			}),
			...transport,
		},
		now: () => 1234,
	};
}

test("remote Interrupt sends one typed member_interrupt command and returns its disposition", async () => {
	const calls: unknown[] = [];
	const controller = new AbortController();
	const operation = createRemoteMemberInterruptOperation({
		send: async (command, options) => {
			calls.push({ command, options });
			return {
				member: { name: "Kelly", role: "qa" },
				interruptId: "interrupt-remote",
				disposition: "interrupt-requested",
			};
		},
	});

	const result = await operation.interruptMember(
		"Kelly",
		{ message: "Stop the unsafe action", instructions: ["preserve evidence", "report status"] },
		{ signal: controller.signal, timeoutMs: 5_000 },
	);

	assert.deepEqual(result, {
		member: { name: "Kelly", role: "qa" },
		interruptId: "interrupt-remote",
		disposition: "interrupt-requested",
	});
	assert.deepEqual(calls, [
		{
			command: {
				type: "member_interrupt",
				target: "Kelly",
				message: "Stop the unsafe action",
				instructions: ["preserve evidence", "report status"],
			},
			options: { signal: controller.signal, timeoutMs: 5_000 },
		},
	]);
});

test("in-process Interrupt routes only to the current joined Member and derives sender identity", async () => {
	const destinations: string[] = [];
	const commands: unknown[] = [];
	const options: unknown[] = [];
	const operation = createInProcessMemberInterruptOperation(
		inProcessDependencies(
			{},
			{
				send: async (endpoint, command, requestOptions) => {
					destinations.push(endpoint);
					commands.push(command);
					options.push(requestOptions);
					return {
						response: {
							type: "response",
							command: "interrupt",
							success: true,
							id: "request-1",
							data: { interruptId: "interrupt-local", disposition: "direct" },
						},
					};
				},
			},
		),
	);

	const result = await operation.interruptMember("qa", {
		message: "Stop and recover",
		instructions: ["inspect the last result", "report blockers"],
	});

	assert.deepEqual(result, {
		member: { name: "Kelly", role: "qa" },
		interruptId: "interrupt-local",
		disposition: "direct",
	});
	assert.deepEqual(destinations, ["/project/.pi/bebop/sockets/kelly.sock"]);
	assert.notEqual(destinations[0], membership.socketPath, "in-process Interrupt must not RPC to its source");
	assert.deepEqual(commands, [
		{
			type: "interrupt",
			payload: {
				content: "Stop and recover",
				instructions: ["inspect the last result", "report blockers"],
				origin: { kind: "crew", name: "Dave", role: "developer" },
				kind: "interrupt",
				sentAt: 1234,
			},
		},
	]);
	assert.equal(options.length, 1);
	const sendOptions = options[0] as { signal: AbortSignal; timeoutMs: number; classifyLostAck: boolean };
	assert.equal(sendOptions.signal.aborted, false);
	assert.equal(sendOptions.timeoutMs, 5_000);
	assert.equal(sendOptions.classifyLostAck, true);
});

test("remote and in-process Interrupt validate timeout bounds and pre-abort before dispatch", async (t) => {
	for (const timeoutMs of [0, 49, 60_001, Number.NaN, Number.POSITIVE_INFINITY, 50.5]) {
		await t.test(`rejects timeout ${String(timeoutMs)}`, async () => {
			let remoteSends = 0;
			let localSends = 0;
			const remote = createRemoteMemberInterruptOperation({
				send: async () => {
					remoteSends += 1;
					throw new Error("unexpected dispatch");
				},
			});
			const local = createInProcessMemberInterruptOperation(
				inProcessDependencies(
					{},
					{
						send: async () => {
							localSends += 1;
							throw new Error("unexpected dispatch");
						},
					},
				),
			);
			for (const operation of [remote, local])
				await assert.rejects(
					operation.interruptMember("Kelly", { message: "Stop" }, { timeoutMs }),
					(error: unknown) => error instanceof BebopClientError && error.code === "invalid-input",
				);
			assert.equal(remoteSends, 0);
			assert.equal(localSends, 0);
		});
	}

	for (const timeoutMs of [50, 60_000]) {
		await t.test(`accepts timeout boundary ${timeoutMs}`, async () => {
			const remote = createRemoteMemberInterruptOperation({
				send: async () => ({
					member: { name: "Kelly", role: "qa" },
					interruptId: "remote",
					disposition: "direct",
				}),
			});
			const local = createInProcessMemberInterruptOperation(inProcessDependencies());
			await remote.interruptMember("Kelly", { message: "Stop" }, { timeoutMs });
			await local.interruptMember("Kelly", { message: "Stop" }, { timeoutMs });
		});
	}

	let localSends = 0;
	let reads = 0;
	const remote = createRemoteMemberInterruptOperation({
		send: async () => {
			throw new Error("unexpected dispatch");
		},
	});
	const local = createInProcessMemberInterruptOperation(
		inProcessDependencies(
			{
				getMembership: () => {
					reads += 1;
					return membership;
				},
			},
			{
				send: async () => {
					localSends += 1;
					throw new Error("unexpected dispatch");
				},
			},
		),
	);
	const controller = new AbortController();
	controller.abort();
	for (const operation of [remote, local])
		await assert.rejects(
			operation.interruptMember("Kelly", { message: "Stop" }, { signal: controller.signal }),
			(error: unknown) => error instanceof BebopClientError && error.code === "aborted",
		);
	assert.equal(reads, 0);
	assert.equal(localSends, 0);
});

test("in-process Interrupt reads live membership and trust, and never admits Guest or self targets", async () => {
	let currentMembership: typeof membership | null = membership;
	let trusted = true;
	let sends = 0;
	const operation = createInProcessMemberInterruptOperation(
		inProcessDependencies(
			{
				getMembership: () => currentMembership,
				isTrusted: () => trusted,
			},
			{
				send: async () => {
					sends += 1;
					return {
						response: {
							type: "response",
							command: "interrupt",
							success: true,
							id: "request-1",
							data: { interruptId: "interrupt-local", disposition: "direct" },
						},
					};
				},
			},
		),
	);

	await operation.interruptMember("Kelly", { message: "Stop" });
	trusted = false;
	await assert.rejects(
		operation.interruptMember("Kelly", { message: "Stop" }),
		(error: unknown) => error instanceof BebopClientError && error.code === "untrusted",
	);
	trusted = true;
	currentMembership = null;
	await assert.rejects(
		operation.interruptMember("Kelly", { message: "Stop" }),
		(error: unknown) => error instanceof BebopClientError && error.code === "not-joined",
	);
	currentMembership = membership;
	for (const target of ["Dave", "guest"])
		await assert.rejects(
			operation.interruptMember(target, { message: "Stop" }),
			(error: unknown) =>
				error instanceof BebopClientError && (error.code === "self-query" || error.code === "unknown-member"),
		);
	assert.equal(sends, 1);
});

test("Interrupt maps malformed identity and direct or generic remote errors without retry", async () => {
	const failures: Array<{ result?: unknown; error?: unknown; code: string }> = [
		{ error: new RpcProtocolError("remote-error", "unknown-member"), code: "unknown-member" },
		{ error: new RpcProtocolError("remote-error", "abort-failed"), code: "abort-failed" },
		{ error: new RpcProtocolError("mismatched-id", "response id did not match"), code: "malformed-response" },
		{ result: {}, code: "malformed-response" },
		{
			result: { member: { name: "Someone else", role: "other" }, interruptId: "i", disposition: "direct" },
			code: "identity-mismatch",
		},
	];
	for (const failure of failures) {
		let sends = 0;
		const operation = createRemoteMemberInterruptOperation({
			send: async () => {
				sends += 1;
				if (failure.error) throw failure.error;
				return failure.result;
			},
		});
		await assert.rejects(
			operation.interruptMember("Kelly", { message: "Stop" }),
			(error: unknown) => error instanceof BebopClientError && error.code === failure.code,
		);
		assert.equal(sends, 1, "a failed or uncertain Interrupt must never retry");
	}
});

test("in-process Interrupt maps an offline target without retry", async () => {
	let sends = 0;
	const operation = createInProcessMemberInterruptOperation(
		inProcessDependencies(
			{},
			{
				send: async () => {
					sends += 1;
					throw Object.assign(new Error("target offline"), { code: "ECONNREFUSED" });
				},
			},
		),
	);
	await assert.rejects(
		operation.interruptMember("Kelly", { message: "Stop" }),
		(error: unknown) => error instanceof BebopClientError && error.code === "offline-member",
	);
	assert.equal(sends, 1);
});

test("in-process Interrupt maps disconnect-after-dispatch to unknown outcome without retry", async () => {
	let dispatched!: () => void;
	const wasDispatched = new Promise<void>((resolve) => (dispatched = resolve));
	let sends = 0;
	const operation = createInProcessMemberInterruptOperation(
		inProcessDependencies(
			{},
			{
				send: async (_endpoint, _command, options) => {
					sends += 1;
					dispatched();
					return new Promise((_resolve, reject) => {
						options.signal?.addEventListener(
							"abort",
							() => reject(new RpcProtocolError("outcome-unknown", "acknowledgement lost")),
							{ once: true },
						);
					});
				},
			},
		),
	);
	const controller = new AbortController();
	const result = operation.interruptMember("Kelly", { message: "Stop" }, { signal: controller.signal });
	await wasDispatched;
	controller.abort();
	await assert.rejects(
		result,
		(error: unknown) => error instanceof BebopClientError && error.code === "outcome-unknown",
	);
	assert.equal(sends, 1);
});
