import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, renameSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createGuestRegistryStore, digestGuestCapability, GuestRegistryError } from "./guest-registry-store.ts";

const crew = { id: "alpha", displayName: "Alpha" } as const;

function approvedSnapshot(overrides: Record<string, unknown> = {}) {
	return {
		status: "approved" as const,
		record: {
			crew,
			guestIdentity: "guest-session",
			guestName: "Alex",
			callbackEndpoint: "/tmp/callback.sock",
			approvedBy: "lead",
		},
		capabilityDigest: "a".repeat(64),
		...overrides,
	};
}

function deniedSnapshot() {
	return {
		status: "denied" as const,
		request: {
			requestId: "request-1",
			crew,
			guestIdentity: "guest-2",
			guestName: "Rowan",
			callbackEndpoint: "/tmp/callback.sock",
			submittedByMember: "lead",
		},
	};
}

async function crewRoot() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "guest-registry-"));
	const bebop = path.join(root, ".pi", "bebop");
	await fs.mkdir(bebop, { recursive: true });
	return root;
}

describe("crew guest registry path rules", () => {
	test("rejects manifest paths outside the canonical crew layout", () => {
		assert.throws(
			() => createGuestRegistryStore({ manifestPath: "/tmp/elsewhere/crew.json", crew }),
			(error) => {
				assert.ok(error instanceof GuestRegistryError);
				assert.equal(error.code, "untrusted-path");
				return true;
			},
		);
	});

	test("derives the registry as a sibling of the trusted crew manifest", async () => {
		const root = await crewRoot();
		try {
			const store = createGuestRegistryStore({
				manifestPath: path.join(root, ".pi", "bebop", "crew.json"),
				crew,
			});
			assert.equal(store.path, path.join(root, ".pi", "bebop", "guest-registry.json"));
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

describe("crew guest registry store", () => {
	test("digests capabilities deterministically as lowercase hex sha256", () => {
		assert.equal(digestGuestCapability("capability"), digestGuestCapability("capability"));
		assert.match(digestGuestCapability("capability"), /^[0-9a-f]{64}$/);
		assert.notEqual(digestGuestCapability("capability"), digestGuestCapability("capability-2"));
	});

	test("absent registry reads as empty and the first write assigns revision and order", async () => {
		const root = await crewRoot();
		try {
			const store = createGuestRegistryStore({
				manifestPath: path.join(root, ".pi", "bebop", "crew.json"),
				crew,
			});
			assert.deepEqual(store.load(), { version: 1, crew, revision: 0, entries: [] });
			const written = store.replaceEntries([approvedSnapshot()]);
			assert.equal(written.revision, 1);
			assert.deepEqual(
				written.entries.map((entry) => [entry.status, entry.order, entry.revision]),
				[["approved", 1, 1]],
			);
			assert.deepEqual(store.load(), written);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("restored tombstones keep stable order while new identities append", async () => {
		const root = await crewRoot();
		try {
			const store = createGuestRegistryStore({
				manifestPath: path.join(root, ".pi", "bebop", "crew.json"),
				crew,
			});
			store.replaceEntries([approvedSnapshot(), deniedSnapshot()]);
			const written = store.replaceEntries([
				approvedSnapshot({ record: { ...(approvedSnapshot().record as object), guestName: "Alexa" } }),
				deniedSnapshot(),
			]);
			assert.equal(written.revision, 2);
			assert.deepEqual(
				written.entries.map((entry) => [entry.guestIdentity, entry.order, entry.revision]),
				[
					["guest-session", 1, 2],
					["guest-2", 2, 1],
				],
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("fails closed on tampered files: invalid JSON, invalid schema, foreign crew", async () => {
		const root = await crewRoot();
		try {
			const registryPath = path.join(root, ".pi", "bebop", "guest-registry.json");
			const store = createGuestRegistryStore({
				manifestPath: path.join(root, ".pi", "bebop", "crew.json"),
				crew,
			});
			await fs.writeFile(registryPath, "{not json", { encoding: "utf8", mode: 0o600 });
			assert.throws(
				() => store.load(),
				(error) => error instanceof GuestRegistryError && error.code === "tampered",
			);
			await fs.writeFile(
				registryPath,
				JSON.stringify({ version: 1, crew, revision: 1, entries: [{ bogus: true }] }),
				{ encoding: "utf8", mode: 0o600 },
			);
			assert.throws(
				() => store.load(),
				(error) => error instanceof GuestRegistryError && error.code === "tampered",
			);
			await fs.writeFile(
				registryPath,
				JSON.stringify({
					version: 1,
					crew: { id: "beta", displayName: "Beta" },
					revision: 1,
					entries: [],
				}),
				{ encoding: "utf8", mode: 0o600 },
			);
			assert.throws(
				() => store.load(),
				(error) => error instanceof GuestRegistryError && error.code === "tampered",
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("fails closed on world/group readable registry files", async () => {
		const root = await crewRoot();
		try {
			const registryPath = path.join(root, ".pi", "bebop", "guest-registry.json");
			const store = createGuestRegistryStore({
				manifestPath: path.join(root, ".pi", "bebop", "crew.json"),
				crew,
			});
			await fs.writeFile(registryPath, JSON.stringify({ version: 1, crew, revision: 1, entries: [] }), {
				mode: 0o644,
			});
			assert.throws(
				() => store.load(),
				(error) => error instanceof GuestRegistryError && error.code === "permission",
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("writes are crash-safe: temp file plus atomic rename, no leftovers", async () => {
		const root = await crewRoot();
		try {
			const registryPath = path.join(root, ".pi", "bebop", "guest-registry.json");
			const writes: Array<{ temp: string; final: string }> = [];
			const store = createGuestRegistryStore({
				manifestPath: path.join(root, ".pi", "bebop", "crew.json"),
				crew,
				deps: {
					renameSync: (from, to) => {
						writes.push({ temp: from, final: to });
						renameSync(from, to);
					},
				},
			});
			store.replaceEntries([approvedSnapshot()]);
			assert.equal(writes.length, 1);
			assert.ok(writes[0]!.temp.includes(".tmp-"));
			assert.equal(writes[0]!.final, registryPath);
			const siblings = (await fs.readdir(path.join(root, ".pi", "bebop"))).filter((name) =>
				name.startsWith(".tmp-"),
			);
			assert.deepEqual(siblings, []);
			const stat = await fs.stat(registryPath);
			assert.equal(stat.mode & 0o777, 0o600);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("concurrent writers retry on revision conflict and never lose tombstones", async () => {
		const root = await crewRoot();
		try {
			const registryPath = path.join(root, ".pi", "bebop", "guest-registry.json");
			const memberA = createGuestRegistryStore({
				manifestPath: path.join(root, ".pi", "bebop", "crew.json"),
				crew,
			});
			const memberB = createGuestRegistryStore({
				manifestPath: path.join(root, ".pi", "bebop", "crew.json"),
				crew,
			});
			// Both read the same empty base, then race: B writes first, A must retry.
			memberB.replaceEntries([deniedSnapshot()]);
			const originalLoad = memberA.load.bind(memberA);
			let injected = false;
			memberA.load = (() => {
				if (!injected) {
					injected = true;
					// Simulate B's write landing between A's read and write.
					memberB.replaceEntries([deniedSnapshot(), approvedSnapshot()]);
				}
				return originalLoad();
			}) as typeof memberA.load;
			const result = memberA.replaceEntries([
				approvedSnapshot(),
				deniedSnapshot(),
				approvedSnapshot({
					record: {
						crew,
						guestIdentity: "guest-3",
						guestName: "Blake",
						callbackEndpoint: "/tmp/callback.sock",
						approvedBy: "lead",
					},
					capabilityDigest: "c".repeat(64),
				}),
			]);
			assert.equal(result.revision >= 3, true);
			assert.deepEqual(
				result.entries.map((entry) => [entry.guestIdentity, entry.status]),
				[
					["guest-2", "denied"],
					["guest-session", "approved"],
					["guest-3", "approved"],
				],
			);
			assert.deepEqual(memberA.load(), result);
			void registryPath;
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
