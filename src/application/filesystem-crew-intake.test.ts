import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createFilesystemCrewIntakeController } from "./filesystem-crew-intake.ts";
import { createExternalIntakePayload } from "../domain/crew-intake.ts";
import { createCrewIntakeDropbox, createCrewIntakeIdempotencyKey } from "../infra/crew-intake-dropbox.ts";
import { openTrustedMemberInboxStore } from "../infra/member-inbox-store.ts";
import { readTrustedCrewManifest } from "../infra/crew-manifest-store.ts";

async function fixture(contact = "Mary") {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "filesystem-crew-intake-"));
	const layout = path.join(root, ".pi", "bebop");
	const sockets = path.join(layout, "sockets");
	await fs.mkdir(sockets, { recursive: true, mode: 0o700 });
	const manifestPath = path.join(layout, "crew.json");
	const members = [
		{ name: "Mary", role: "po", socket: "sockets/Mary.sock" },
		{ name: "Bob", role: "dev", socket: "sockets/Bob.sock" },
	];
	await fs.writeFile(manifestPath, JSON.stringify({ version: 1, members, intake: { contact } }), { mode: 0o600 });
	const membership = {
		manifestPath,
		member: {
			name: contact,
			role: contact === "Mary" ? "po" : "dev",
			socketPath: path.join(sockets, `${contact}.sock`),
		},
	};
	return { root, layout, manifestPath, membership, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

function controllerFor(
	harness: Awaited<ReturnType<typeof fixture>>,
	member = harness.membership,
	options: {
		readonly quiescenceMs?: number;
		readonly hintTransport?: { sendHint(endpoint: string, command: { type: "inbox_hint" }): Promise<unknown> };
	} = { quiescenceMs: 0 },
) {
	let current: typeof member | null = member;
	let accepted = 0;
	const errors: string[] = [];
	const controller = createFilesystemCrewIntakeController({
		getMembership: () => current,
		isProjectTrusted: () => true,
		onAccepted: () => {
			accepted += 1;
		},
		onError: (code) => errors.push(code),
		hintTransport: options.hintTransport,
		quiescenceMs: options.quiescenceMs,
	});
	return {
		controller,
		errors,
		get accepted() {
			return accepted;
		},
		set current(value: typeof member | null) {
			current = value;
		},
	};
}

async function storeFor(harness: Awaited<ReturnType<typeof fixture>>, member = harness.membership.member) {
	return openTrustedMemberInboxStore({
		manifestPath: harness.manifestPath,
		projectRoot: harness.root,
		isProjectTrusted: () => true,
		member: {
			name: member.name,
			role: member.role,
			socketPath: member.socketPath,
		},
	});
}

test("filesystem intake resolves the exact contact, persists, and retains processed evidence", async (t) => {
	const harness = await fixture();
	const intake = controllerFor(harness);
	t.after(() => intake.controller.close());
	t.after(harness.cleanup);
	await intake.controller.scan();
	const newDir = path.join(harness.layout, "intake", "new");
	await fs.writeFile(path.join(newDir, "2026-09-20-login.md"), "opaque external context\nwithout classification");
	const result = await intake.controller.scan();
	assert.deepEqual(result, { state: "scanned", accepted: 1, failed: 0, remaining: 0 });
	assert.equal(intake.accepted, 1);
	assert.equal(await (await storeFor(harness)).count(), 1);
	assert.equal(
		await fs.readFile(path.join(harness.layout, "intake", "processed", "2026-09-20-login.md"), "utf8"),
		"opaque external context\nwithout classification",
	);
	assert.equal(intake.errors.length, 0);
	intake.controller.close();
});

test("restart after enqueue before receipt moves one item without duplicating Inbox state", async (t) => {
	const harness = await fixture();
	const intake = controllerFor(harness);
	t.after(() => intake.controller.close());
	t.after(harness.cleanup);
	await intake.controller.scan();
	const source = path.join(harness.layout, "intake", "new", "crash.md");
	await fs.writeFile(source, "crash window");
	const dropbox = createCrewIntakeDropbox({
		manifestPath: harness.manifestPath,
		projectRoot: harness.root,
		isProjectTrusted: () => true,
		quiescenceMs: 0,
	});
	await dropbox.prepare();
	const work = (await dropbox.listWork())[0]!;
	const claim = await dropbox.claim(work);
	const content = await dropbox.read(claim!);
	const key = createCrewIntakeIdempotencyKey(harness.manifestPath, claim!.name, content.digest);
	const store = await storeFor(harness);
	const persisted = await store.enqueueWithId(
		createExternalIntakePayload({ label: claim!.name, content: content.content }),
		1,
		key,
	);
	assert.equal("alreadyPersisted" in persisted, false);
	const result = await intake.controller.scan();
	assert.deepEqual(result, { state: "scanned", accepted: 1, failed: 0, remaining: 0 });
	assert.equal(await store.count(), 1);
	assert.equal(
		await fs.readFile(path.join(harness.layout, "intake", "processed", "crash.md"), "utf8"),
		"crash window",
	);
	assert.equal((await dropbox.readReceipt(key))?.itemId, persisted.item.id);
});

test("a manifest change after the Inbox commit retains one old-contact commit and moves on restart", async (t) => {
	const harness = await fixture();
	let mutated = false;
	const intake = createFilesystemCrewIntakeController({
		getMembership: () => harness.membership,
		isProjectTrusted: () => true,
		externalIntake: {
			openStore: async (options) => {
				const store = await openTrustedMemberInboxStore({ ...options, isProjectTrusted: () => true });
				return {
					...store,
					enqueueWithId: async (payload, now, id) => {
						if (!mutated) {
							mutated = true;
							await fs.writeFile(
								harness.manifestPath,
								JSON.stringify({
									version: 1,
									members: [
										{ name: "Mary", role: "po", socket: "sockets/Mary.sock" },
										{ name: "Bob", role: "dev", socket: "sockets/Bob.sock" },
									],
									intake: { contact: "Bob" },
								}),
							);
						}
						return store.enqueueWithId(payload, now, id);
					},
				};
			},
		},
	});
	t.after(() => intake.close());
	t.after(harness.cleanup);
	await intake.scan();
	await fs.writeFile(path.join(harness.layout, "intake", "new", "commit.md"), "commit point");
	assert.deepEqual(await intake.scan(), { state: "scanned", accepted: 0, failed: 0, remaining: 1 });
	assert.equal(await (await storeFor(harness)).count(), 1);
	assert.deepEqual(await intake.scan(), { state: "scanned", accepted: 1, failed: 0, remaining: 0 });
	const bobMembership = {
		name: "Bob",
		role: "dev",
		socketPath: path.join(harness.layout, "sockets", "Bob.sock"),
	};
	assert.equal(await (await storeFor(harness, bobMembership)).count(), 0);
	assert.equal(
		await fs.readFile(path.join(harness.layout, "intake", "processed", "commit.md"), "utf8"),
		"commit point",
	);
});

test("restart after enqueue without receipt preserves the original contact across a manifest change", async (t) => {
	const harness = await fixture();
	let crashed = false;
	const first = createFilesystemCrewIntakeController({
		getMembership: () => harness.membership,
		isProjectTrusted: () => true,
		externalIntake: {
			openStore: async (options) => {
				const store = await openTrustedMemberInboxStore({ ...options, isProjectTrusted: () => true });
				return {
					...store,
					enqueueWithId: async (payload, now, id) => {
						const result = await store.enqueueWithId(payload, now, id);
						if (!crashed) {
							crashed = true;
							await fs.writeFile(
								harness.manifestPath,
								JSON.stringify({
									version: 1,
									members: [
										{ name: "Mary", role: "po", socket: "sockets/Mary.sock" },
										{ name: "Bob", role: "dev", socket: "sockets/Bob.sock" },
									],
									intake: { contact: "Bob" },
								}),
							);
							throw new Error("simulated crash before receipt");
						}
						return result;
					},
				};
			},
		},
		quiescenceMs: 0,
	});
	t.after(() => first.close());
	await first.scan();
	await fs.writeFile(path.join(harness.layout, "intake", "new", "contact-crash.md"), "old contact commit");
	assert.deepEqual(await first.scan(), { state: "failed", code: "intake-storage-failed" });
	const bobMembership = {
		manifestPath: harness.manifestPath,
		member: {
			name: "Bob",
			role: "dev",
			socketPath: path.join(harness.layout, "sockets", "Bob.sock"),
		},
	};
	const restarted = controllerFor(harness, bobMembership);
	t.after(() => restarted.controller.close());
	t.after(harness.cleanup);
	assert.deepEqual(await restarted.controller.scan(), { state: "scanned", accepted: 1, failed: 0, remaining: 0 });
	assert.equal(await (await storeFor(harness)).count(), 1);
	assert.equal(await (await storeFor(harness, bobMembership.member)).count(), 0);
	assert.equal(
		await fs.readFile(path.join(harness.layout, "intake", "processed", "contact-crash.md"), "utf8"),
		"old contact commit",
	);
});

test("restart after receipt before move reuses the receipt without a duplicate", async (t) => {
	const harness = await fixture();
	const intake = controllerFor(harness);
	t.after(() => intake.controller.close());
	t.after(harness.cleanup);
	await intake.controller.scan();
	await fs.writeFile(path.join(harness.layout, "intake", "new", "receipt.md"), "receipt window");
	const dropbox = createCrewIntakeDropbox({
		manifestPath: harness.manifestPath,
		projectRoot: harness.root,
		isProjectTrusted: () => true,
		quiescenceMs: 0,
	});
	await dropbox.prepare();
	const claim = await dropbox.claim((await dropbox.listWork())[0]!);
	const content = await dropbox.read(claim!);
	const key = createCrewIntakeIdempotencyKey(harness.manifestPath, claim!.name, content.digest);
	const store = await storeFor(harness);
	const persisted = await store.enqueueWithId(
		createExternalIntakePayload({ label: claim!.name, content: content.content }),
		1,
		key,
	);
	await dropbox.writeReceipt({
		version: 1,
		idempotencyKey: key,
		filename: claim!.name,
		digest: content.digest,
		itemId: persisted.item.id,
		recordedAt: 1,
	});
	assert.deepEqual(await intake.controller.scan(), { state: "scanned", accepted: 1, failed: 0, remaining: 0 });
	assert.equal(await store.count(), 1);
});

test("membership generation changes before persistence requeue without Inbox writes", async (t) => {
	const harness = await fixture();
	let current: typeof harness.membership | null = harness.membership;
	let loads = 0;
	const intake = createFilesystemCrewIntakeController({
		getMembership: () => current,
		isProjectTrusted: () => true,
		loadManifest: async (manifestPath, projectRoot) => {
			const manifest = await readTrustedCrewManifest(manifestPath, projectRoot, () => true);
			loads += 1;
			if (loads === 3) current = null;
			return manifest;
		},
	});
	t.after(() => intake.close());
	t.after(harness.cleanup);
	await intake.scan();
	await fs.writeFile(path.join(harness.layout, "intake", "new", "stale.md"), "must retry");
	assert.deepEqual(await intake.scan(), { state: "scanned", accepted: 0, failed: 0, remaining: 1 });
	assert.equal(await (await storeFor(harness)).count(), 0);
	assert.equal(await fs.readFile(path.join(harness.layout, "intake", "new", "stale.md"), "utf8"), "must retry");
});

test("membership sync activates the watcher and scans immediately", async (t) => {
	const harness = await fixture();
	const intake = controllerFor(harness);
	t.after(() => intake.controller.close());
	t.after(harness.cleanup);
	await fs.mkdir(path.join(harness.layout, "intake", "new"), { recursive: true, mode: 0o700 });
	await fs.writeFile(path.join(harness.layout, "intake", "new", "startup.md"), "startup context");
	intake.controller.syncMembership();
	let processed = false;
	for (let attempt = 0; attempt < 30; attempt += 1) {
		try {
			await fs.access(path.join(harness.layout, "intake", "processed", "startup.md"));
			processed = true;
			break;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	assert.equal(processed, true);
	assert.equal(intake.accepted, 1);
});

test("watcher retries an atomic publication after the initial event quiesces", async (t) => {
	const harness = await fixture();
	const intake = controllerFor(harness, harness.membership, {});
	t.after(() => intake.controller.close());
	t.after(harness.cleanup);
	intake.controller.syncMembership();
	await intake.controller.scan();
	const draft = path.join(harness.layout, "intake", "new", ".context.md.draft");
	const published = path.join(harness.layout, "intake", "new", "atomic.md");
	await fs.writeFile(draft, "atomic external context");
	await fs.rename(draft, published);
	let processed = false;
	for (let attempt = 0; attempt < 120; attempt += 1) {
		try {
			await fs.access(path.join(harness.layout, "intake", "processed", "atomic.md"));
			processed = true;
			break;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	assert.equal(processed, true);
	assert.equal(intake.accepted, 1);
});

test("close cancels a debounced watcher retry", async (t) => {
	const harness = await fixture();
	const intake = controllerFor(harness, harness.membership, {});
	t.after(harness.cleanup);
	intake.controller.syncMembership();
	await intake.controller.scan();
	const draft = path.join(harness.layout, "intake", "new", ".context.md.draft");
	const published = path.join(harness.layout, "intake", "new", "closed.md");
	await fs.writeFile(draft, "must remain after close");
	await fs.rename(draft, published);
	await new Promise<void>((resolve) => setImmediate(resolve));
	await intake.controller.close();
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal(await fs.readFile(published, "utf8"), "must remain after close");
	assert.equal(await (await storeFor(harness)).count(), 0);
});

test("close prevents a queued scan from resurrecting a filesystem watcher", async (t) => {
	const harness = await fixture();
	const intake = controllerFor(harness);
	t.after(() => intake.controller.close());
	t.after(harness.cleanup);
	intake.controller.syncMembership();
	const queuedScan = intake.controller.scan();
	await intake.controller.close();
	assert.equal((await queuedScan).state, "skipped");
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(
		process._getActiveHandles().some((handle) => handle.constructor?.name === "FSWatcher"),
		false,
	);
});

test("close awaits an in-flight startup scan before filesystem teardown", async (t) => {
	const harness = await fixture();
	let openedResolve!: () => void;
	const opened = new Promise<void>((resolve) => {
		openedResolve = resolve;
	});
	let releaseResolve!: () => void;
	const release = new Promise<void>((resolve) => {
		releaseResolve = resolve;
	});
	const intake = createFilesystemCrewIntakeController({
		getMembership: () => harness.membership,
		isProjectTrusted: () => true,
		externalIntake: {
			openStore: async (options) => {
				openedResolve();
				await release;
				return openTrustedMemberInboxStore({ ...options, isProjectTrusted: () => true });
			},
		},
		quiescenceMs: 0,
	});
	t.after(() => intake.close());
	t.after(harness.cleanup);
	await fs.mkdir(path.join(harness.layout, "intake", "new"), { recursive: true, mode: 0o700 });
	await fs.writeFile(path.join(harness.layout, "intake", "new", "shutdown.md"), "shutdown context");
	intake.syncMembership();
	await opened;
	let closed = false;
	const closing = intake.close().then(() => {
		closed = true;
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(closed, false);
	releaseResolve();
	await closing;
	await harness.cleanup();
});

test("any trusted joined member persists intake for the exact offline contact", async (t) => {
	const harness = await fixture();
	const bob = {
		manifestPath: harness.manifestPath,
		member: { name: "Bob", role: "dev", socketPath: path.join(harness.layout, "sockets", "Bob.sock") },
	};
	const intake = controllerFor(harness, bob);
	t.after(() => intake.controller.close());
	t.after(harness.cleanup);
	await intake.controller.scan();
	await fs.writeFile(path.join(harness.layout, "intake", "new", "later.txt"), "wait for Mary");
	assert.deepEqual(await intake.controller.scan(), { state: "scanned", accepted: 1, failed: 0, remaining: 0 });
	assert.equal(intake.accepted, 0);
	assert.equal(await (await storeFor(harness)).count(), 1);
	assert.equal(await (await storeFor(harness, bob.member)).count(), 0);
	assert.equal(
		await fs.readFile(path.join(harness.layout, "intake", "processed", "later.txt"), "utf8"),
		"wait for Mary",
	);
	intake.controller.close();
});

test("remote contact receives a best-effort inbox hint after durable persistence", async (t) => {
	const harness = await fixture();
	const bob = {
		manifestPath: harness.manifestPath,
		member: { name: "Bob", role: "dev", socketPath: path.join(harness.layout, "sockets", "Bob.sock") },
	};
	const hints: Array<{ endpoint: string; type: string }> = [];
	const intake = controllerFor(harness, bob, {
		quiescenceMs: 0,
		hintTransport: {
			sendHint: async (endpoint, command) => {
				hints.push({ endpoint, type: command.type });
			},
		},
	});
	t.after(() => intake.controller.close());
	t.after(harness.cleanup);
	await intake.controller.scan();
	await fs.writeFile(path.join(harness.layout, "intake", "new", "hint.md"), "wake Mary");
	assert.deepEqual(await intake.controller.scan(), { state: "scanned", accepted: 1, failed: 0, remaining: 0 });
	assert.deepEqual(hints, [{ endpoint: path.join(harness.layout, "sockets", "Mary.sock"), type: "inbox_hint" }]);
	assert.equal(await (await storeFor(harness)).count(), 1);
	assert.equal(intake.errors.length, 0);
});

test("hint failure leaves the remote inbox item and processed evidence durable", async (t) => {
	const harness = await fixture();
	const bob = {
		manifestPath: harness.manifestPath,
		member: { name: "Bob", role: "dev", socketPath: path.join(harness.layout, "sockets", "Bob.sock") },
	};
	const intake = controllerFor(harness, bob, {
		quiescenceMs: 0,
		hintTransport: {
			sendHint: async () => {
				throw new Error("offline");
			},
		},
	});
	t.after(() => intake.controller.close());
	t.after(harness.cleanup);
	await intake.controller.scan();
	await fs.writeFile(path.join(harness.layout, "intake", "new", "offline.md"), "keep durable");
	assert.deepEqual(await intake.controller.scan(), { state: "scanned", accepted: 1, failed: 0, remaining: 0 });
	assert.equal(await (await storeFor(harness)).count(), 1);
	assert.equal(
		await fs.readFile(path.join(harness.layout, "intake", "processed", "offline.md"), "utf8"),
		"keep durable",
	);
	assert.equal(intake.errors.length, 0);
});

test("manifest contact changes invalidate the active intake owner", async (t) => {
	const harness = await fixture();
	const intake = controllerFor(harness);
	t.after(() => intake.controller.close());
	t.after(harness.cleanup);
	await intake.controller.scan();
	await fs.writeFile(path.join(harness.layout, "intake", "new", "later.md"), "wait for the new contact");
	await fs.writeFile(
		harness.manifestPath,
		JSON.stringify({
			version: 1,
			members: [
				{ name: "Mary", role: "po", socket: "sockets/Mary.sock" },
				{ name: "Bob", role: "dev", socket: "sockets/Bob.sock" },
			],
			intake: { contact: "Bob" },
		}),
	);
	assert.deepEqual(await intake.controller.scan(), { state: "scanned", accepted: 1, failed: 0, remaining: 0 });
	const bobMembership = {
		manifestPath: harness.manifestPath,
		member: { name: "Bob", role: "dev", socketPath: path.join(harness.layout, "sockets", "Bob.sock") },
	};
	assert.equal(await (await storeFor(harness, bobMembership.member)).count(), 1);
	assert.equal(
		await fs.readFile(path.join(harness.layout, "intake", "processed", "later.md"), "utf8"),
		"wait for the new contact",
	);
});

test("invalid UTF-8 is retained in failed with a bounded reason", async (t) => {
	const harness = await fixture();
	const intake = controllerFor(harness);
	t.after(() => intake.controller.close());
	t.after(harness.cleanup);
	await fs.mkdir(path.join(harness.layout, "intake", "new"), { recursive: true, mode: 0o700 });
	await fs.writeFile(path.join(harness.layout, "intake", "new", "broken.txt"), Buffer.from([0xc3, 0x28]));
	const result = await intake.controller.scan();
	assert.deepEqual(result, { state: "scanned", accepted: 0, failed: 1, remaining: 0 });
	assert.deepEqual(
		await fs.readFile(path.join(harness.layout, "intake", "failed", "broken.txt")),
		Buffer.from([0xc3, 0x28]),
	);
	const reason = JSON.parse(
		await fs.readFile(path.join(harness.layout, "intake", "failed", "broken.txt.reason.json"), "utf8"),
	);
	assert.equal(reason.reason, "invalid-utf8");
	intake.controller.close();
});
