import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createGuestMembershipRuntime } from "./guest-membership-runtime.ts";
import { createGuestRegistryStore, digestGuestCapability } from "./guest-registry-store.ts";
import { createGuestRegistryAuthorizationResolver } from "./guest-registry-authorization.ts";

const alpha = { id: "alpha", displayName: "Alpha" } as const;

test("composition resolver reads the selected Guest crew registry fresh and isolates revocation", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "guest-auth-resolver-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const manifestPath = path.join(root, ".pi", "bebop", "crew.json");
	const memberSocket = path.join(root, ".pi", "bebop", "sockets", "lead.sock");
	await fs.mkdir(path.dirname(memberSocket), { recursive: true });
	const registry = createGuestRegistryStore({ manifestPath, crew: alpha });
	const sourceCapability = "source-capability";
	registry.replaceEntries([
		{
			status: "approved",
			record: {
				crew: alpha,
				guestIdentity: "source-guest",
				guestName: "Alex",
				callbackEndpoint: "/tmp/source.sock",
				approvedBy: "lead",
			},
			capabilityDigest: digestGuestCapability(sourceCapability),
		},
	]);
	const receiver = createGuestMembershipRuntime({
		guestIdentity: "receiver-guest",
		callbackEndpoint: "/tmp/receiver.sock",
		createRequestId: () => "request-1",
		submitJoinRequest: async () => undefined,
	});
	receiver.track(
		{ crew: alpha, guestName: "Blake", memberSocket, submittedByMember: "lead" },
		"request-1",
		"approved",
		"receiver-capability",
	);
	const authorize = createGuestRegistryAuthorizationResolver({ runtime: receiver, isProjectTrusted: () => true });
	const input = {
		crewId: "alpha",
		guestIdentity: "source-guest",
		callbackEndpoint: "/tmp/source.sock",
		capability: sourceCapability,
	};
	assert.deepEqual(authorize(input), { ok: true, guestName: "Alex" });
	registry.replaceEntries([
		{
			status: "revoked",
			record: {
				crew: alpha,
				guestIdentity: "source-guest",
				guestName: "Alex",
				callbackEndpoint: "/tmp/source.sock",
				approvedBy: "lead",
			},
		},
	]);
	assert.deepEqual(authorize(input), { ok: false, code: "revoked" });
	assert.deepEqual(authorize({ ...input, crewId: "beta" }), { ok: false, code: "registry-unavailable" });
});
