import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { submitGuestBroadcast, submitGuestMessage, type GuestMessageTransport } from "./guest-message.ts";
import { createGuestMembershipRuntime, type GuestMembershipRuntime } from "../infra/guest-membership-runtime.ts";
import { RpcProtocolError } from "../infra/rpc-client.ts";

const crew = { id: "alpha", displayName: "Alpha" } as const;

function guestRuntime(): GuestMembershipRuntime {
	return createGuestMembershipRuntime({
		guestIdentity: "guest-session",
		callbackEndpoint: "/tmp/guest-callback.sock",
		createRequestId: () => "local-1",
		submitJoinRequest: async () => undefined,
	});
}

function approvedRuntime() {
	const runtime = guestRuntime();
	runtime.track(
		{ crew, guestName: "Alex", memberSocket: "/tmp/lead.sock", submittedByMember: "member" },
		"request-1",
		"approved",
		"member-issued-capability",
	);
	return runtime;
}

function trustedManifest() {
	return {
		crew: { id: "alpha", displayName: "Alpha" },
		members: [
			{ name: "lead", role: "lead", socketPath: "/tmp/sockets/lead.sock" },
			{ name: "dev", role: "developer", socketPath: "/tmp/sockets/dev.sock" },
		],
	};
}

function deps(response: unknown, error?: unknown, capture: Array<{ endpoint: string; command: unknown }> = []) {
	const transport: GuestMessageTransport = {
		send: async (endpoint, command, options) => {
			void options;
			capture.push({ endpoint, command });
			if (error !== undefined) throw error;
			return { response } as never;
		},
	};
	return { transport, capture };
}

const request = (overrides: Record<string, unknown> = {}) => ({
	guestRuntime: approvedRuntime(),
	guestIdentity: "guest-session",
	crew: "alpha",
	target: "dev",
	message: "hello crew",
	loadManifest: async () => trustedManifest(),
	...overrides,
});

describe("guest messaging application flow", () => {
	test("routes directly to the selected member's configured endpoint with credentials", async () => {
		const { transport, capture } = deps({
			success: true,
			data: { deliveryId: "delivery-1", disposition: "direct", fromGuestName: "Alex" },
		});
		const outcome = await submitGuestMessage(request(), { transport });
		assert.deepEqual(outcome, {
			target: { name: "dev", role: "developer" },
			deliveryId: "delivery-1",
			disposition: "direct",
			fromGuestName: "Alex",
		});
		assert.deepEqual(capture, [
			{
				endpoint: "/tmp/sockets/dev.sock",
				command: {
					type: "guest_send",
					crewId: "alpha",
					guestIdentity: "guest-session",
					callbackEndpoint: "/tmp/guest-callback.sock",
					capability: "member-issued-capability",
					target: "dev",
					content: "hello crew",
				},
			},
		]);
	});

	test("requires the exact crew selector and an approved binding before any routing", async () => {
		const { transport, capture } = deps({ success: true, data: {} });
		await assert.rejects(
			() => submitGuestMessage(request({ crew: "", runtimeGuard: undefined } as never), { transport }),
			(error: Error & { code?: string }) => {
				assert.equal(error.code, "invalid-request");
				return true;
			},
		);
		await assert.rejects(
			() => submitGuestMessage(request({ guestRuntime: guestRuntime() }), { transport }),
			(error: Error & { code?: string }) => {
				assert.equal(error.code, "not-approved");
				assert.match(error.message, /No approved Guest membership for crew alpha/);
				return true;
			},
		);
		assert.deepEqual(capture, [], "no wire request may precede authorization");
	});

	test("manifest/crew mismatch and untrusted loads fail closed without delivery", async () => {
		const { transport, capture } = deps({ success: true, data: {} });
		await assert.rejects(
			() =>
				submitGuestMessage(
					request({ loadManifest: async () => ({ crew: { id: "beta", displayName: "Beta" }, members: [] }) }),
					{ transport },
				),
			(error: Error & { code?: string }) => {
				assert.equal(error.code, "crew-mismatch");
				return true;
			},
		);
		await assert.rejects(
			() =>
				submitGuestMessage(
					request({
						loadManifest: async () => {
							throw new Error("not trusted");
						},
					}),
					{ transport },
				),
			(error: Error & { code?: string }) => {
				assert.equal(error.code, "offline");
				return true;
			},
		);
		assert.deepEqual(capture, []);
	});

	test("offline endpoints fail explicitly with no fallback", async () => {
		const { transport } = deps(
			undefined,
			Object.assign(new Error("connect ECONNREFUSED /tmp/sockets/dev.sock"), { code: "ECONNREFUSED" }),
		);
		await assert.rejects(
			() => submitGuestMessage(request(), { transport }),
			(error: Error & { code?: string }) => {
				assert.equal(error.code, "offline");
				return true;
			},
		);
	});

	test("member-side registry rejections pass through their exact codes", async () => {
		for (const code of ["revoked", "capability-mismatch", "endpoint-mismatch", "pending"]) {
			const { transport } = deps(undefined, new RpcProtocolError("remote-error", code));
			await assert.rejects(
				() => submitGuestMessage(request(), { transport }),
				(error: Error & { code?: string }) => {
					assert.equal(error.code, code);
					return true;
				},
			);
		}
	});

	test("invalid acknowledgements fail closed instead of guessing success", async () => {
		const { transport } = deps({ success: true, data: { bogus: true } });
		await assert.rejects(
			() => submitGuestMessage(request(), { transport }),
			(error: Error & { code?: string }) => {
				assert.equal(error.code, "invalid-ack");
				return true;
			},
		);
	});

	test("Guest Broadcast delivers directly to Members and approved Guests, excluding the sender", async () => {
		const capture: Array<{ endpoint: string; command: any }> = [];
		const transport: GuestMessageTransport = {
			send: async (endpoint, command) => {
				capture.push({ endpoint, command });
				return {
					response: {
						success: true,
						data: {
							deliveryId: `delivery-${capture.length}`,
							disposition: "direct",
							fromGuestName: "Alex",
						},
					},
				};
			},
		};
		const outcome = await submitGuestBroadcast(
			request({
				message: "crew update",
				loadManifest: async () => ({
					...trustedManifest(),
					approvedGuests: [
						{ guestIdentity: "guest-session", guestName: "Alex", callbackEndpoint: "/tmp/alex.sock" },
						{ guestIdentity: "guest-blake", guestName: "Blake", callbackEndpoint: "/tmp/blake.sock" },
					],
				}),
			}),
			{ transport },
		);
		assert.deepEqual(
			outcome.dispositions.map((item) => [item.recipientName, item.recipientRole]),
			[
				["lead", "lead"],
				["dev", "developer"],
				["Blake", "guest"],
			],
		);
		assert.deepEqual(
			capture.map(({ endpoint, command }) => [endpoint, command.type, command.target, command.kind]),
			[
				["/tmp/sockets/lead.sock", "guest_send", "lead", "broadcast"],
				["/tmp/sockets/dev.sock", "guest_send", "dev", "broadcast"],
				["/tmp/blake.sock", "guest_send", "Blake", "broadcast"],
			],
		);
	});

	test("Guest Broadcast stops remaining direct sends when local membership is revalidated as revoked", async () => {
		const runtime = approvedRuntime();
		let reads = 0;
		const originalCredentials = runtime.credentials.bind(runtime);
		runtime.credentials = (crewId) => {
			reads++;
			return reads > 3 ? null : originalCredentials(crewId);
		};
		const capture: string[] = [];
		const transport: GuestMessageTransport = {
			send: async (endpoint) => {
				capture.push(endpoint);
				return {
					response: {
						success: true,
						data: { deliveryId: endpoint, disposition: "direct", fromGuestName: "Alex" },
					},
				};
			},
		};
		const outcome = await submitGuestBroadcast(
			request({
				guestRuntime: runtime,
				loadManifest: async () => ({
					...trustedManifest(),
					approvedGuests: [
						{ guestIdentity: "guest-session", guestName: "Alex", callbackEndpoint: "/tmp/alex.sock" },
					],
				}),
			}),
			{ transport },
		);
		assert.deepEqual(capture, ["/tmp/sockets/lead.sock"]);
		assert.deepEqual(outcome.summary, { delivered: 1, failed: 1, total: 2 });
		assert.equal(outcome.dispositions[1]?.code, "revoked");
	});
});
