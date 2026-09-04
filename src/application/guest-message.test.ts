import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { submitGuestMessage, type GuestMessageTransport } from "./guest-message.ts";
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
});
