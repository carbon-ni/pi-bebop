import assert from "node:assert/strict";
import test from "node:test";
import {
	createMemberMessageCoordinator,
	sendMemberMessage,
	MemberMessageError,
	type MemberMessageDependencies,
} from "./member-message.ts";
import { parseCrewManifest } from "../domain/index.ts";

const manifest = parseCrewManifest(
	{
		version: 1,
		members: [
			{ name: "dev", role: "developer", socket: "sockets/dev.sock" },
			{ name: "qa", role: "reviewer", socket: "sockets/qa.sock" },
		],
	},
	"/project/.pi/bebop/crew.json",
);
const membership = {
	manifestPath: "/project/.pi/bebop/crew.json",
	manifest,
	member: { ...manifest.members[0], socketPath: "/project/.pi/bebop/sockets/dev.sock" },
	socketPath: "/project/.pi/bebop/sockets/dev.sock",
	globalSocketPath: "/project/global.sock",
};
const ack = (success = true, data: unknown = { deliveryId: "delivery-1", disposition: "queued" }) => ({
	response: {
		type: "response" as const,
		command: "send" as const,
		success,
		data,
		...(success ? {} : { error: "busy" }),
	},
});
function dependencies(events: string[], response = ack()): MemberMessageDependencies {
	return {
		resolveEndpoint: async (socketPath) => {
			events.push(`resolve:${socketPath}`);
			return `endpoint:${socketPath}`;
		},
		transport: {
			send: async (endpoint) => {
				events.push(`send:${endpoint}`);
				return response;
			},
		},
		coordinator: createMemberMessageCoordinator(),
	};
}

test("preparation rejects local requests before endpoint or transport IO", async () => {
	for (const request of [
		{ membership: null, member: "qa", message: "x" },
		{ membership, member: "qa", message: "x", waitFor: "response" as const },
		{ membership, member: "qa", message: "" },
		{ membership, member: "dev", message: "x" },
	]) {
		const events: string[] = [];
		await assert.rejects(() => sendMemberMessage(request, dependencies(events)), MemberMessageError);
		assert.deepEqual(events, []);
	}
});

test("sendMemberMessage resolves endpoint before delivery and preserves prepared command", async () => {
	const events: string[] = [];
	const outcome = await sendMemberMessage(
		{ membership, member: "qa", message: "hello", intent: "immediate" },
		dependencies(events),
	);
	assert.deepEqual(events, [
		"resolve:/project/.pi/bebop/sockets/qa.sock",
		"send:endpoint:/project/.pi/bebop/sockets/qa.sock",
	]);
	assert.deepEqual(outcome, {
		target: { kind: "member", name: "qa", role: "reviewer", socketPath: "/project/.pi/bebop/sockets/qa.sock" },
		deliveryId: "delivery-1",
		disposition: "queued",
	});
});

test("delivery stage keeps stable acknowledgement and lost-outcome errors", async () => {
	for (const [response, code] of [
		[ack(false), "remote-rejected"],
		[ack(true, {}), "invalid-ack"],
	] as const) {
		await assert.rejects(
			() =>
				sendMemberMessage(
					{ membership, member: "qa", message: "x", intent: "immediate" },
					dependencies([], response),
				),
			(error: unknown) => error instanceof MemberMessageError && error.code === code,
		);
	}
	const lost: MemberMessageDependencies = {
		...dependencies([]),
		transport: {
			send: async () => {
				throw Object.assign(new Error("ack lost"), { code: "outcome-unknown" });
			},
		},
	};
	await assert.rejects(
		() => sendMemberMessage({ membership, member: "qa", message: "x", intent: "immediate" }, lost),
		(error: unknown) => error instanceof MemberMessageError && error.code === "outcome-unknown",
	);
});

test("Member->Guest follow-ups route to the approved Guest callback endpoint", async () => {
	const events: string[] = [];
	const sent: unknown[] = [];
	const dependencies: MemberMessageDependencies = {
		coordinator: createMemberMessageCoordinator(),
		resolveEndpoint: async (socketPath) => {
			events.push(`resolve:${socketPath}`);
			return socketPath;
		},
		transport: {
			send: async (_endpoint, command) => {
				sent.push(command);
				return ack();
			},
		},
	};
	const outcome = await sendMemberMessage(
		{
			membership,
			member: "Taylor",
			message: "hello guest",
			approvedGuests: [
				{ guestName: "Taylor", guestIdentity: "guest-session", callbackEndpoint: "/tmp/guest-callback.sock" },
			],
		},
		dependencies,
	);
	assert.deepEqual(outcome.target, {
		kind: "guest",
		guestName: "Taylor",
		guestIdentity: "guest-session",
		callbackEndpoint: "/tmp/guest-callback.sock",
	});
	assert.deepEqual(events, ["resolve:/tmp/guest-callback.sock"]);
	const command = sent[0] as { payload: { origin: { kind: string; name: string; role: string } } };
	assert.equal(command.payload.origin.kind, "crew");
	assert.equal(command.payload.origin.name, "dev");
});

test("Guest names colliding with Member names are qualification errors, never guesses", async () => {
	const dependencies: MemberMessageDependencies = {
		resolveEndpoint: async (socketPath) => socketPath,
		transport: { send: async () => ack() },
	};
	await assert.rejects(
		() =>
			sendMemberMessage(
				{
					membership,
					member: "dev",
					message: "hi",
					approvedGuests: [
						{
							guestName: "dev",
							guestIdentity: "guest-session",
							callbackEndpoint: "/tmp/guest-callback.sock",
						},
					],
				},
				dependencies,
			),
		(error: MemberMessageError) => {
			assert.equal(error.code, "ambiguous-member");
			assert.match(error.message, /matches both a crew Member and an approved Guest/);
			return true;
		},
	);
});

test("without an approvedGuests resolver, Guest names fail closed as unknown", async () => {
	const dependencies: MemberMessageDependencies = {
		resolveEndpoint: async (socketPath) => socketPath,
		transport: { send: async () => ack() },
	};
	await assert.rejects(
		() => sendMemberMessage({ membership, member: "Taylor", message: "hi" }, dependencies),
		(error: MemberMessageError) => {
			assert.equal(error.code, "unknown-member");
			return true;
		},
	);
});
