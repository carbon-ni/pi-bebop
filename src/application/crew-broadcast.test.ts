import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CrewManifest, CrewMember, RpcCommandResponse } from "../domain/index.ts";
import { createMemberMessageCoordinator, type MemberMessageDependencies } from "./member-message.ts";
import { submitCrewBroadcast, type CrewBroadcastApplicationError } from "./crew-broadcast.ts";

type Call = { endpoint: string; command: Record<string, unknown> };

function makeCrew(): CrewManifest {
	return {
		version: 1,
		presence: { notifications: true },
		members: [
			{ name: "Tony", role: "lead", socket: "tony.sock", socketPath: "/crew/tony.sock" },
			{ name: "Mary", role: "po", socket: "mary.sock", socketPath: "/crew/mary.sock" },
			{ name: "Bob", role: "dev", socket: "bob.sock", socketPath: "/crew/bob.sock" },
			{ name: "Kelly", role: "qa", socket: "kelly.sock", socketPath: "/crew/kelly.sock" },
		] as CrewMember[],
	};
}
function membership(sender = "Bob") {
	const manifest = makeCrew();
	const member = manifest.members.find((candidate) => candidate.name === sender)!;
	return { manifestPath: "/crew/.pi/bebop/crew.json", socketPath: member.socketPath, member, manifest };
}
function dependencies(calls: Call[], failures = new Map<string, Error>()): MemberMessageDependencies {
	return {
		resolveEndpoint: async (socketPath) => socketPath,
		coordinator: createMemberMessageCoordinator(),
		transport: {
			send: async (endpoint, command) => {
				calls.push({ endpoint, command: command as Record<string, unknown> });
				const failure = failures.get(endpoint);
				if (failure) throw failure;
				return {
					response: {
						success: true,
						data: { deliveryId: `delivery-${calls.length}`, disposition: "queued" },
					} as RpcCommandResponse,
				};
			},
		},
		now: () => 1_000,
	};
}

describe("submitCrewBroadcast", () => {
	test("fans out live Follow-ups in manifest order, excludes sender, and preserves broadcast payload", async () => {
		const calls: Call[] = [];
		const result = await submitCrewBroadcast(
			{ membership: membership(), message: "API changed", instructions: ["pull latest"] },
			dependencies(calls),
		);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(
			result.dispositions.map((item) => item.recipientName),
			["Tony", "Mary", "Kelly"],
		);
		assert.deepEqual(result.summary, { delivered: 3, failed: 0, total: 3 });
		assert.deepEqual(
			calls.map((call) => call.endpoint),
			["/crew/tony.sock", "/crew/mary.sock", "/crew/kelly.sock"],
		);
		for (const call of calls) {
			assert.equal(call.command.type, "send");
			assert.equal(call.command.delivery, "follow_up");
			assert.equal((call.command.payload as { kind: string }).kind, "broadcast");
			assert.deepEqual((call.command.payload as { origin: unknown }).origin, {
				kind: "crew",
				name: "Bob",
				role: "dev",
			});
			assert.deepEqual((call.command.payload as { instructions: string[] }).instructions, ["pull latest"]);
		}
	});

	test("attempts every recipient and reports offline and rejected failures independently", async () => {
		const calls: Call[] = [];
		const failures = new Map([
			["/crew/mary.sock", Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" })],
			["/crew/kelly.sock", new Error("target rejected")],
		]);
		const result = await submitCrewBroadcast(
			{ membership: membership(), message: "hello" },
			dependencies(calls, failures),
		);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(
			calls.map((call) => call.endpoint),
			["/crew/tony.sock", "/crew/mary.sock", "/crew/kelly.sock"],
		);
		assert.deepEqual(
			result.dispositions.map((item) => item.disposition),
			["delivered", "failed", "failed"],
		);
		assert.equal(result.dispositions[1]!.code, "offline");
		assert.equal(result.dispositions[2]!.code, "transport-error");
		assert.deepEqual(result.summary, { delivered: 1, failed: 2, total: 3 });
	});

	test("busy targets use ordinary queued Follow-up delivery, never immediate delivery", async () => {
		const calls: Call[] = [];
		const result = await submitCrewBroadcast(
			{ membership: membership("Tony"), message: "normal work" },
			dependencies(calls),
		);
		assert.equal(result.ok, true);
		assert.ok(calls.every((call) => call.command.delivery === "follow_up"));
	});

	test("unjoined and single-member crews fail before any transport", async () => {
		const calls: Call[] = [];
		await assert.rejects(
			submitCrewBroadcast({ membership: null, message: "hello" }, dependencies(calls)),
			(error) => (error as CrewBroadcastApplicationError).code === "not-joined",
		);
		const solo = membership("Bob");
		solo.manifest.members = [solo.member];
		const result = await submitCrewBroadcast({ membership: solo, message: "hello" }, dependencies(calls));
		assert.deepEqual(result, { ok: false, code: "no-recipients" });
		assert.equal(calls.length, 0);
	});
});

test("approved Guests join the transient recipient set after Members, in registry order", async () => {
	const calls: Call[] = [];
	const result = await submitCrewBroadcast(
		{
			membership: membership("Bob"),
			message: "crew update",
			approvedGuests: [
				{
					guestName: "Alex",
					guestIdentity: "guest-a",
					callbackEndpoint: "/tmp/alex-callback.sock",
				},
				{
					guestName: "Blake",
					guestIdentity: "guest-b",
					callbackEndpoint: "/tmp/blake-callback.sock",
				},
			],
		},
		dependencies(calls),
	);
	assert.ok(result.ok);
	if (!result.ok) return;
	assert.deepEqual(
		result.dispositions.map((disposition) => [disposition.recipientName, disposition.recipientRole]),
		[
			["Tony", "lead"],
			["Mary", "po"],
			["Kelly", "qa"],
			["Alex", "guest"],
			["Blake", "guest"],
		],
	);
	const guestCalls = calls.filter((call) => String(call.endpoint).includes("callback.sock"));
	assert.deepEqual(
		guestCalls.map((call) => call.endpoint),
		["/tmp/alex-callback.sock", "/tmp/blake-callback.sock"],
	);
	for (const call of guestCalls) {
		const payload = call.command.payload as { kind: string; origin: { kind: string; name: string } };
		assert.equal(payload.kind, "broadcast");
		assert.equal(payload.origin.kind, "crew");
		assert.equal(payload.origin.name, "Bob");
	}
});

test("offline Guests fail explicitly in the dispositions without Inbox fallback", async () => {
	const failures = new Map<string, Error>([
		["/tmp/alex-callback.sock", Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })],
	]);
	const calls: Call[] = [];
	const result = await submitCrewBroadcast(
		{
			membership: membership("Bob"),
			message: "crew update",
			approvedGuests: [
				{
					guestName: "Alex",
					guestIdentity: "guest-a",
					callbackEndpoint: "/tmp/alex-callback.sock",
				},
			],
		},
		dependencies(calls, failures),
	);
	assert.ok(result.ok);
	if (!result.ok) return;
	const guestDisposition = result.dispositions.find((disposition) => disposition.recipientName === "Alex");
	assert.equal(guestDisposition?.disposition, "failed");
	assert.equal(guestDisposition?.code, "offline");
	assert.equal(result.summary.failed, 1);
});
