import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createGuestAdmissionRuntime, type GuestAdmissionRuntime } from "./guest-admission-runtime.ts";
import { createGuestRegistryStore, digestGuestCapability } from "./guest-registry-store.ts";

const crew = { id: "alpha", displayName: "Alpha" } as const;

function manifestFor(memberName: string, role: string) {
	return {
		version: 1 as const,
		crew,
		guestAdmission: { approvers: ["lead", "gatekeeper"] },
		members: [
			{ name: "lead", role: "lead", socket: "sockets/lead.sock" },
			{ name: "gatekeeper", role: "developer", socket: "sockets/gatekeeper.sock" },
			{ name: memberName, role, socket: `sockets/${memberName}.sock` },
		].filter((member, index, all) => all.findIndex((candidate) => candidate.name === member.name) === index),
	};
}

function runtimeFor(root: string, memberName: string, role: string): GuestAdmissionRuntime {
	let nextRequest = 0;
	mkdirSync(path.join(root, ".pi", "bebop"), { recursive: true });
	const registry = createGuestRegistryStore({
		manifestPath: path.join(root, ".pi", "bebop", "crew.json"),
		crew,
	});
	const runtime = createGuestAdmissionRuntime({
		manifest: manifestFor(memberName, role),
		memberName,
		createRequestId: () => `${memberName}-generated-${++nextRequest}`,
		createCapability: () => `capability-${memberName}-${nextRequest}`,
		digestCapability: digestGuestCapability,
		persist: (records) => {
			registry.replaceEntries(records);
		},
	});
	runtime.restore(registry.load().entries.map(toRegistrySnapshot));
	return runtime;
}

function toRegistrySnapshot(entry: {
	status: string;
	crew: { id: string; displayName: string };
	guestIdentity: string;
	guestName: string;
	callbackEndpoint: string;
	capabilityDigest: string;
	approver?: string;
}) {
	if (entry.status === "denied")
		return {
			status: entry.status,
			request: {
				requestId: `registry-${entry.order}`,
				crew: entry.crew,
				guestIdentity: entry.guestIdentity,
				guestName: entry.guestName,
				callbackEndpoint: entry.callbackEndpoint,
				submittedByMember: "lead",
			},
			approver: entry.approver,
		};
	return {
		status: entry.status,
		record: {
			crew: entry.crew,
			guestIdentity: entry.guestIdentity,
			guestName: entry.guestName,
			callbackEndpoint: entry.callbackEndpoint,
			approvedBy: entry.approver,
		},
		...(entry.status === "approved" ? { capabilityDigest: entry.capabilityDigest } : {}),
	};
}

function joinRequest(identity: string, guestName: string, submittedByMember = "lead") {
	return {
		requestId: "incoming",
		crew,
		guestIdentity: identity,
		guestName,
		callbackEndpoint: "/tmp/guest-callback.sock",
		submittedByMember,
	};
}

describe("crew-owned Guest registry across Members", () => {
	test("approval by one Member is authoritative for every other Member runtime", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "guest-registry-multi-"));
		try {
			const lead = runtimeFor(root, "lead", "lead");
			const received = lead.receive(joinRequest("guest-session", "Alex"));
			assert.ok(received.ok);
			const approved = lead.approve("lead-generated-1", "lead");
			assert.ok(approved.ok);

			// A second Member runtime (fresh process equivalent) restores from the
			// same crew registry and sees the identical approved state.
			const dev = runtimeFor(root, "dev", "developer");
			assert.deepEqual(dev.list(), lead.list());
			assert.deepEqual(
				dev.list().map((row) => [row.guestName, row.status]),
				[["Alex", "approved"]],
			);

			// /crew guests consistency: neither runtime can see the verifier
			// digest or the capability, but both agree on the visible state.
			for (const runtime of [lead, dev]) {
				const view = runtime.list()[0]!;
				assert.equal("capabilityDigest" in view, false);
				assert.equal(view.status, "approved");
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("revocation by any Member is visible crew-wide and blocks re-approval replays", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "guest-registry-revoke-"));
		try {
			const lead = runtimeFor(root, "lead", "lead");
			assert.ok(lead.receive(joinRequest("guest-session", "Alex")).ok);
			assert.ok(lead.approve("lead-generated-1", "lead").ok);

			// A different approver Member revokes the Guest from its own runtime.
			const gatekeeper = runtimeFor(root, "gatekeeper", "developer");
			assert.deepEqual(gatekeeper.remove("Alex", "gatekeeper"), { ok: true, changed: true });

			// The revocation is visible to the approving Member after restart.
			const leadAfterRestart = runtimeFor(root, "lead", "lead");
			assert.deepEqual(
				leadAfterRestart.list().map((row) => [row.guestName, row.status]),
				[["Alex", "revoked"]],
			);

			// A revoked Guest cannot re-join on any Member runtime.
			assert.deepEqual(leadAfterRestart.receive(joinRequest("guest-session", "Alex")), {
				ok: false,
				code: "revoked",
			});
			assert.deepEqual(gatekeeper.receive(joinRequest("guest-session", "Alex", "gatekeeper")), {
				ok: false,
				code: "revoked",
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("denied tombstones persist crew-wide and reject replayed joins after restart", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "guest-registry-deny-"));
		try {
			const lead = runtimeFor(root, "lead", "lead");
			assert.ok(lead.receive(joinRequest("guest-session", "Blair")).ok);
			assert.ok(lead.deny("lead-generated-1", "lead").ok);

			const qa = runtimeFor(root, "qa", "QA");
			assert.deepEqual(qa.receive(joinRequest("guest-session", "Blair", "qa")), { ok: false, code: "denied" });
			assert.deepEqual(
				qa.list().map((row) => [row.guestName, row.status]),
				[["Blair", "denied"]],
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("the registry stores verifier digests, never plaintext capabilities", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "guest-registry-digest-"));
		try {
			const lead = runtimeFor(root, "lead", "lead");
			assert.ok(lead.receive(joinRequest("guest-session", "Alex")).ok);
			const approved = lead.approve("lead-generated-1", "lead");
			assert.ok(approved.ok);

			const registryPath = path.join(root, ".pi", "bebop", "guest-registry.json");
			const raw = await fs.readFile(registryPath, "utf8");
			assert.ok(!raw.includes("capability-lead-1"), "plaintext capability must never be persisted");
			assert.ok(raw.includes(digestGuestCapability("capability-lead-1")), "verifier digest must be persisted");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("a Member runtime with an empty registry inherits no session-private approvals", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "guest-registry-isolated-"));
		try {
			// No registry file exists: every runtime starts from an empty,
			// fail-closed base instead of migrating old session-private approvals.
			const fresh = runtimeFor(root, "lead", "lead");
			assert.deepEqual(fresh.list(), []);
			assert.deepEqual(fresh.receive(joinRequest("guest-session", "Alex")), {
				ok: true,
				status: "pending",
				requestId: "lead-generated-1",
				crew,
				idempotent: false,
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
