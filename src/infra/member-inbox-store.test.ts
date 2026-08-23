import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	MemberInboxStoreError,
	openTrustedMemberInboxStore,
	type MemberInboxStoreDependencies,
} from "./member-inbox-store.ts";
import { MAX_INBOX_ITEMS, type MessagePayload } from "../domain/index.ts";

const CONTENT = "please review the PR";

interface Fixture {
	root: string;
	manifestPath: string;
	memberSocketPath: string;
	cleanup(): Promise<void>;
}

async function makeFixture(layout: "bebop" | "crew" = "bebop"): Promise<Fixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `intray-inbox-${layout}-`));
	const layoutDir = path.join(root, ".pi", layout);
	await fs.mkdir(path.join(layoutDir, "sockets"), { recursive: true });
	const manifestPath = path.join(layoutDir, "crew.json");
	await fs.writeFile(manifestPath, JSON.stringify({ version: 1, members: [] }));
	return {
		root,
		manifestPath,
		memberSocketPath: path.join(layoutDir, "sockets", "Bob.sock"),
		cleanup: async () => {
			await fs.rm(root, { recursive: true, force: true });
		},
	};
}

const payload = (content = CONTENT, extra: Partial<MessagePayload> = {}): MessagePayload => ({
	content,
	...extra,
});

const open = (fixture: Fixture, deps?: MemberInboxStoreDependencies) =>
	openTrustedMemberInboxStore({
		manifestPath: fixture.manifestPath,
		projectRoot: fixture.root,
		isProjectTrusted: () => true,
		member: { name: "Bob", role: "dev", socketPath: fixture.memberSocketPath },
		deps,
	});

const rejectsInboxStore = async (promise: Promise<unknown>, code: string, mustNotInclude?: string) => {
	await assert.rejects(
		() => promise,
		(error: unknown) => {
			assert.ok(error instanceof MemberInboxStoreError, `expected MemberInboxStoreError, got ${error}`);
			assert.equal(error.code, code);
			if (mustNotInclude) assert.ok(!error.message.includes(mustNotInclude), `message leaked: ${error.message}`);
			return true;
		},
	);
};

let fixture: Fixture;

before(async () => {
	fixture = await makeFixture();
});

after(async () => {
	await fixture.cleanup();
});

describe("durable enqueue and restart", () => {
	test("enqueues durably, FIFO order survives repository restart", async () => {
		const repo = await open(fixture);
		await repo.enqueue(payload("first"), 1000);
		await repo.enqueue(payload("second"), 1001);
		await repo.enqueue(payload("third"), 1002);

		const reopened = await open(fixture);
		const items = await reopened.list();
		assert.deepEqual(
			items.map((summary) => summary.sequence),
			[0, 1, 2],
		);
		assert.deepEqual(
			items.map((summary) => summary.id),
			(await repo.list()).map((summary) => summary.id),
		);
		await repo.remove(items[0]!.id);
		await repo.remove(items[1]!.id);
		await repo.remove(items[2]!.id);
	});

	test("each item is one versioned file beneath the trusted layout inbox", async () => {
		const repo = await open(fixture);
		const { item } = await repo.enqueue(payload("file-backed"), 2000);
		const inboxDir = path.join(path.dirname(fixture.manifestPath), "inbox", repo.memberKey);
		const entries = await fs.readdir(inboxDir);
		assert.ok(entries.includes(`${item.id}.json`));
		const raw = JSON.parse(await fs.readFile(path.join(inboxDir, `${item.id}.json`), "utf8"));
		assert.equal(raw.version, 1);
		assert.equal(raw.id, item.id);
		await repo.remove(item.id);
	});

	test("peek returns the oldest full item; list returns bounded metadata without content", async () => {
		const repo = await open(fixture);
		await repo.enqueue(payload("metadata-first"), 3000);
		const { item } = await repo.enqueue(payload("metadata-secret-marker"), 3001);
		const peeked = await repo.peekOldest();
		assert.equal(peeked?.payload.content, "metadata-first");

		const summaries = await repo.list();
		assert.equal(summaries.length, 2);
		for (const summary of summaries) {
			assert.ok(!("payload" in summary));
			assert.deepEqual(Object.keys(summary).sort(), ["bytes", "enqueuedAt", "id", "sequence"]);
			assert.ok(summary.bytes > 0);
		}
		assert.ok(!JSON.stringify(summaries).includes("metadata-secret-marker"));

		await repo.remove(peeked!.id);
		await repo.remove(item.id);
	});

	test("remove and cancel are idempotent and count reflects valid items", async () => {
		const repo = await open(fixture);
		const { item } = await repo.enqueue(payload(), 4000);
		assert.equal(await repo.count(), 1);
		assert.deepEqual(await repo.cancel(item.id), { removed: true });
		assert.equal(await repo.count(), 0);
		assert.deepEqual(await repo.remove(item.id), { removed: false });
		assert.deepEqual(await repo.cancel(item.id), { removed: false });
	});
});

describe("quarantine and malformed data", () => {
	test("malformed record is quarantined and does not block the healthy queue", async () => {
		const repo = await open(fixture);
		const { item } = await repo.enqueue(payload("healthy"), 5000);
		const inboxDir = path.join(path.dirname(fixture.manifestPath), "inbox", repo.memberKey);
		await fs.writeFile(path.join(inboxDir, "deadbeef.json"), "{ not json");
		await fs.writeFile(
			path.join(inboxDir, "cafebabe.json"),
			JSON.stringify({ version: 1, id: "inbox-0-x", junk: true }),
		);

		const items = await repo.list();
		assert.equal(items.length, 1);
		assert.equal(items[0]?.id, item.id);
		const quarantined = await fs.readdir(path.join(inboxDir, "quarantine"));
		assert.deepEqual([...quarantined].sort(), ["cafebabe.json", "deadbeef.json"]);
		await repo.remove(item.id);
	});

	test("oversized record is quarantined without reading it whole", async () => {
		const repo = await open(fixture);
		const inboxDir = path.join(path.dirname(fixture.manifestPath), "inbox", repo.memberKey);
		await fs.mkdir(inboxDir, { recursive: true });
		await fs.writeFile(path.join(inboxDir, "huge.json"), "x".repeat(2 * 1024 * 1024));
		assert.deepEqual(await repo.list(), []);
		assert.ok((await fs.readdir(path.join(inboxDir, "quarantine"))).includes("huge.json"));
	});

	test("record for a foreign member target is quarantined", async () => {
		const repo = await open(fixture);
		const inboxDir = path.join(path.dirname(fixture.manifestPath), "inbox", repo.memberKey);
		await fs.mkdir(inboxDir, { recursive: true });
		const foreign = {
			version: 1,
			id: "inbox-0-foreign",
			target: { name: "Eve", socketPath: "/elsewhere/.pi/bebop/sockets/Eve.sock" },
			payload: { content: "foreign" },
			enqueuedAt: 1,
			sequence: 0,
		};
		await fs.writeFile(path.join(inboxDir, "foreign.json"), JSON.stringify(foreign));
		assert.deepEqual(await repo.list(), []);
		assert.ok((await fs.readdir(path.join(inboxDir, "quarantine"))).includes("foreign.json"));
	});
});

describe("atomicity, failures, and concurrency", () => {
	test("crash between temp write and rename leaves no partial record", async (t) => {
		const local = await makeFixture();
		t.after(local.cleanup);
		const failOnce = { used: false };
		const deps: MemberInboxStoreDependencies = {
			rename: async (from, to) => {
				if (!failOnce.used) {
					failOnce.used = true;
					throw Object.assign(new Error("simulated crash before rename"), { code: "EIO" });
				}
				await fs.rename(from, to);
			},
		};
		const repo = await open(local, deps);
		await rejectsInboxStore(repo.enqueue(payload(), 100), "write-failed", CONTENT);
		assert.deepEqual(await repo.list(), []);

		const healthy = await open(local);
		const { item } = await healthy.enqueue(payload("after restart"), 101);
		assert.equal((await healthy.list()).length, 1);
		assert.equal(item.sequence, 0);
	});

	test("disk-full on write fails bounded and never creates the final file", async (t) => {
		const local = await makeFixture();
		t.after(local.cleanup);
		const repo = await open(local, {
			writeFile: async () => {
				throw Object.assign(new Error("no space"), { code: "ENOSPC" });
			},
		});
		await rejectsInboxStore(repo.enqueue(payload(), 100), "write-failed", CONTENT);
		const inboxDir = path.join(local.root, ".pi", "bebop", "inbox", repo.memberKey);
		const entries = await fs.readdir(inboxDir);
		assert.ok(entries.every((name) => name.startsWith(".tmp") || name === ".lock" || name === "quarantine"));
	});

	test("lock conflict surfaces a bounded actionable error", async (t) => {
		const local = await makeFixture();
		t.after(local.cleanup);
		const repo = await open(local, {
			openLock: async () => {
				throw Object.assign(new Error("lock held"), { code: "EEXIST" });
			},
			lockDeadlineMs: 40,
			lockPollMs: 10,
		});
		await rejectsInboxStore(repo.enqueue(payload(), 100), "lock-conflict");
	});

	test("unreadable directory fails bounded on read", async (t) => {
		const local = await makeFixture();
		t.after(local.cleanup);
		const repo = await open(local, {
			readdir: async () => {
				throw Object.assign(new Error("denied"), { code: "EACCES" });
			},
		});
		await rejectsInboxStore(repo.list(), "read-failed");
	});

	test("concurrent enqueues never lose items or duplicate sequences", async (t) => {
		const local = await makeFixture();
		t.after(local.cleanup);
		const repo = await open(local);
		const results = await Promise.all(
			Array.from({ length: 5 }, (_, index) => repo.enqueue(payload(`concurrent-${index}`), 6000 + index)),
		);
		const sequences = results.map((result) => result.item.sequence).sort((a, b) => a - b);
		assert.deepEqual(sequences, [0, 1, 2, 3, 4]);
		assert.equal(new Set(sequences).size, 5);
		assert.equal(await repo.count(), 5);
		for (const result of results) await repo.remove(result.item.id);
	});

	test("capacity limit rejects the enqueue beyond MAX_INBOX_ITEMS", async (t) => {
		const local = await makeFixture();
		t.after(local.cleanup);
		const repo = await open(local);
		for (let index = 0; index < MAX_INBOX_ITEMS; index += 1) await repo.enqueue(payload(`cap-${index}`), 7000);
		await rejectsInboxStore(repo.enqueue(payload("overflow"), 7100), "capacity-exceeded");
		assert.equal(await repo.count(), MAX_INBOX_ITEMS);
	});
});

describe("trust, layout, and security", () => {
	test("untrusted project rejects before any filesystem IO", async (t) => {
		const local = await makeFixture();
		t.after(local.cleanup);
		let reads = 0;
		const deps: MemberInboxStoreDependencies = {
			readdir: async (dir) => {
				reads += 1;
				return fs.readdir(dir);
			},
		};
		await assert.rejects(
			() =>
				openTrustedMemberInboxStore({
					manifestPath: local.manifestPath,
					projectRoot: local.root,
					isProjectTrusted: () => false,
					member: { name: "Bob", role: "dev", socketPath: local.memberSocketPath },
					deps,
				}),
			(error: unknown) => error instanceof MemberInboxStoreError && error.code === "untrusted-project",
		);
		assert.equal(reads, 0);
	});

	test("unsupported manifest layout is rejected", async (t) => {
		const local = await makeFixture();
		t.after(local.cleanup);
		const stray = path.join(local.root, ".pi", "other", "crew.json");
		await fs.mkdir(path.dirname(stray), { recursive: true });
		await fs.writeFile(stray, "{}");
		await assert.rejects(
			() =>
				openTrustedMemberInboxStore({
					manifestPath: stray,
					projectRoot: local.root,
					isProjectTrusted: () => true,
					member: { name: "Bob", role: "dev", socketPath: local.memberSocketPath },
				}),
			(error: unknown) => error instanceof MemberInboxStoreError && error.code === "untrusted-path",
		);
	});

	test("member socket outside the manifest sockets directory is rejected", async (t) => {
		const local = await makeFixture();
		t.after(local.cleanup);
		await assert.rejects(
			() =>
				openTrustedMemberInboxStore({
					manifestPath: local.manifestPath,
					projectRoot: local.root,
					isProjectTrusted: () => true,
					member: { name: "Eve", role: "dev", socketPath: "/tmp/evil.sock" },
				}),
			(error: unknown) => error instanceof MemberInboxStoreError && error.code === "invalid-member",
		);
	});

	test("inbox directory symlink escape is rejected", async (t) => {
		const local = await makeFixture();
		t.after(local.cleanup);
		const repo = await open(local);
		await repo.enqueue(payload("escape-seed"), 100);
		await repo.remove((await repo.list())[0]!.id);
		const layoutDir = path.dirname(local.manifestPath);
		const outside = path.join(local.root, "outside-inbox");
		await fs.mkdir(outside, { recursive: true });
		await fs.rm(path.join(layoutDir, "inbox"), { recursive: true, force: true });
		await fs.symlink(outside, path.join(layoutDir, "inbox"));
		await assert.rejects(
			() => open(local),
			(error: unknown) => error instanceof MemberInboxStoreError && error.code === "untrusted-path",
		);
	});

	test("planted member directory symlink escape is rejected on use", async (t) => {
		const local = await makeFixture();
		t.after(local.cleanup);
		const layoutDir = path.dirname(local.manifestPath);
		const inboxRoot = path.join(layoutDir, "inbox");
		await fs.mkdir(inboxRoot, { recursive: true });
		const outside = path.join(local.root, "outside-member");
		await fs.mkdir(outside, { recursive: true });
		const repo = await open(local);
		await fs.symlink(outside, path.join(inboxRoot, repo.memberKey));
		await rejectsInboxStore(repo.enqueue(payload(), 100), "untrusted-path");
		await rejectsInboxStore(repo.list(), "untrusted-path");
	});

	test("both trusted layouts use manifest-adjacent isolated storage", async (t) => {
		for (const layout of ["bebop", "crew"] as const) {
			const local = await makeFixture(layout);
			t.after(local.cleanup);
			const repo = await open(local);
			const { item } = await repo.enqueue(payload(`layout-${layout}`), 100);
			const storagePath = path.join(local.root, ".pi", layout, "inbox", repo.memberKey, `${item.id}.json`);
			assert.ok(
				await fs
					.stat(storagePath)
					.then(() => true)
					.catch(() => false),
			);
			await repo.remove(item.id);
		}
	});

	test("storage key isolates members and is stable across name/role changes", async (t) => {
		const local = await makeFixture();
		t.after(local.cleanup);
		const otherSocket = path.join(path.dirname(local.manifestPath), "sockets", "Dave.sock");
		const bobRepo = await openTrustedMemberInboxStore({
			manifestPath: local.manifestPath,
			projectRoot: local.root,
			isProjectTrusted: () => true,
			member: { name: "Bob", role: "dev", socketPath: local.memberSocketPath },
		});
		const lookalikeRepo = await openTrustedMemberInboxStore({
			manifestPath: local.manifestPath,
			projectRoot: local.root,
			isProjectTrusted: () => true,
			member: { name: "Вob", role: "dev", socketPath: otherSocket },
		});
		assert.notEqual(bobRepo.memberKey, lookalikeRepo.memberKey);

		const { item } = await bobRepo.enqueue(payload("rename-me"), 100);
		const renamedRepo = await openTrustedMemberInboxStore({
			manifestPath: local.manifestPath,
			projectRoot: local.root,
			isProjectTrusted: () => true,
			member: { name: "Bobby", role: "reviewer", socketPath: local.memberSocketPath },
		});
		assert.equal(renamedRepo.memberKey, bobRepo.memberKey);
		assert.equal(await renamedRepo.count(), 1);
		await renamedRepo.remove(item.id);
		assert.equal(await lookalikeRepo.count(), 0);
	});
});

describe("traversal and attribution-only origin", () => {
	test("item id traversal is rejected by remove and cancel", async (t) => {
		const local = await makeFixture();
		t.after(local.cleanup);
		const repo = await open(local);
		const { item } = await repo.enqueue(payload("keep-me"), 8000);
		for (const unsafe of ["../../etc/passwd", "..%2f..%2fetc%2fpasswd", "sub/../escape", "a\\b"]) {
			await rejectsInboxStore(repo.remove(unsafe), "invalid-item-id");
			await rejectsInboxStore(repo.cancel(unsafe), "invalid-item-id");
		}
		assert.equal(await repo.count(), 1);
		assert.equal((await repo.list())[0]?.id, item.id);
		await repo.remove(item.id);
	});

	test("claimed origin is attribution only: any valid-shaped origin is stored and never grants authority", async (t) => {
		const local = await makeFixture();
		t.after(local.cleanup);
		const repo = await open(local);
		const spoofed = payload("spoofed-origin", {
			origin: { kind: "crew", name: "lead", role: "lead" },
		});
		const { item } = await repo.enqueue(spoofed, 8100);
		const peeked = await repo.peekOldest();
		assert.deepEqual(peeked?.payload.origin, { kind: "crew", name: "lead", role: "lead" });
		// Storage is transport-only: the claim is preserved for display but does not
		// change which member queue the item lands in or who may read it.
		assert.equal(peeked?.target.socketPath, local.memberSocketPath);
		await repo.remove(item.id);
	});
});

describe("enqueueWithId (broadcast seam)", () => {
	test("persists under the caller-supplied deterministic id", async (t) => {
		const local = await makeFixture();
		t.after(local.cleanup);
		const repo = await open(local);
		const result = await repo.enqueueWithId(payload("broadcast!"), 500, "broadcast-abc-123");
		assert.ok("item" in result, "expected a persisted item");
		assert.equal(result.item.id, "broadcast-abc-123");
		assert.equal(result.item.sequence, 0);
		assert.equal(await repo.count(), 1);

		// Deterministic id survives a restart (no rewrite by the store).
		const reopened = await open(local);
		const [stored] = (await reopened.list()) as Array<{ id: string }>;
		assert.equal(stored.id, "broadcast-abc-123");
	});

	test("already-persisted is idempotent and does not consume capacity", async (t) => {
		const local = await makeFixture();
		t.after(local.cleanup);
		const repo = await open(local);
		const first = await repo.enqueueWithId(payload("msg"), 600, "broadcast-id-1");
		assert.ok("item" in first);
		const second = await repo.enqueueWithId(payload("msg"), 601, "broadcast-id-1");
		assert.ok("alreadyPersisted" in second);
		assert.equal(second.itemId, "broadcast-id-1");
		assert.equal(await repo.count(), 1, "duplicate id must not add an item");
	});

	test("coexists with sequence-derived enqueue items (distinct id spaces)", async (t) => {
		const local = await makeFixture();
		t.after(local.cleanup);
		const repo = await open(local);
		await repo.enqueue(payload("normal"), 900);
		const broadcast = await repo.enqueueWithId(payload("broadcast"), 901, "broadcast-x");
		assert.ok("item" in broadcast);
		assert.equal(await repo.count(), 2);
		const listed = await repo.list();
		// FIFO by sequence regardless of id scheme: normal first (seq 0), broadcast second (seq 1).
		assert.equal(listed[0]!.id.startsWith("inbox-"), true);
		assert.equal(listed[1]!.id, "broadcast-x");
	});

	test("rejects an unsafe explicit id", async (t) => {
		const local = await makeFixture();
		t.after(local.cleanup);
		const repo = await open(local);
		await rejectsInboxStore(repo.enqueueWithId(payload("x"), 100, "../evil"), "invalid-item-id");
		await rejectsInboxStore(repo.enqueueWithId(payload("x"), 100, "a/b"), "invalid-item-id");
		await rejectsInboxStore(repo.enqueueWithId(payload("x"), 100, ""), "invalid-item-id");
		await rejectsInboxStore(repo.enqueueWithId(payload("x"), 100, "a\0b"), "invalid-item-id");
		assert.equal(await repo.count(), 0);
	});

	test("enforces capacity even for a fresh explicit id", async (t) => {
		const local = await makeFixture();
		t.after(local.cleanup);
		const repo = await open(local);
		for (let index = 0; index < MAX_INBOX_ITEMS; index += 1)
			await repo.enqueue(payload(`cap-${index}`), 1000 + index);
		await rejectsInboxStore(
			repo.enqueueWithId(payload("overflow"), 99999, "broadcast-overflow"),
			"capacity-exceeded",
		);
		assert.equal(await repo.count(), MAX_INBOX_ITEMS);
	});

	test("already-persisted wins over capacity on retry", async (t) => {
		const local = await makeFixture();
		t.after(local.cleanup);
		const repo = await open(local);
		const first = await repo.enqueueWithId(payload("keep"), 700, "broadcast-keep");
		assert.ok("item" in first);
		for (let index = 0; index < MAX_INBOX_ITEMS - 1; index += 1)
			await repo.enqueue(payload(`fill-${index}`), 2000 + index);
		// Inbox is now full, but the existing item id must still resolve as already-persisted.
		const retry = await repo.enqueueWithId(payload("keep"), 99999, "broadcast-keep");
		assert.ok("alreadyPersisted" in retry);
		assert.equal(await repo.count(), MAX_INBOX_ITEMS);
	});

	test("rejects an invalid payload even with a valid id", async (t) => {
		const local = await makeFixture();
		t.after(local.cleanup);
		const repo = await open(local);
		await rejectsInboxStore(repo.enqueueWithId({ nope: true }, 100, "broadcast-badpayload"), "invalid-payload");
	});
});
