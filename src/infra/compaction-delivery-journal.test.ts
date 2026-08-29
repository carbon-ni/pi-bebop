import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { openTrustedCompactionDeliveryJournal } from "./compaction-delivery-journal.ts";

const envelope = (id: string) => ({
	id,
	bytes: 32,
	message: { customType: "crew", content: id },
	delivery: { triggerTurn: true },
	metadata: { deliveryId: id },
});

function memoryDeps() {
	const files = new Map<string, Buffer>();
	return {
		files,
		deps: {
			readFile: async (filePath: string) => {
				const value = files.get(filePath);
				if (!value) throw Object.assign(new Error("missing"), { code: "ENOENT" });
				return value;
			},
			writeFile: async (filePath: string, data: string) => files.set(filePath, Buffer.from(data)),
			rename: async (from: string, to: string) => files.set(to, files.get(from)!),
			mkdir: async () => undefined,
			acquireLock: async () => async () => undefined,
			syncDirectory: async () => undefined,
		},
	};
}

test("journal appends FIFO records and acknowledges delivery", async () => {
	const memory = memoryDeps();
	const journal = await openTrustedCompactionDeliveryJournal({
		manifestPath: "/project/.pi/bebop/crew.json",
		projectRoot: "/project",
		isProjectTrusted: () => true,
		memberName: "Dave",
		deps: memory.deps,
	});
	await journal.append(envelope("a"), 1);
	await journal.append(envelope("b"), 2);
	assert.deepEqual(
		(await journal.listPending()).map((record) => record.id),
		["a", "b"],
	);
	await journal.markHandingOff("a");
	assert.equal((await journal.listPending())[0].state, "handing-off");
	await journal.markDelivered("a");
	assert.deepEqual(
		(await journal.listPending()).map((record) => record.id),
		["b"],
	);
});

test("journal rejects unserializable records with a bounded error", async () => {
	const memory = memoryDeps();
	const journal = await openTrustedCompactionDeliveryJournal({
		manifestPath: "/project/.pi/bebop/crew.json",
		projectRoot: "/project",
		isProjectTrusted: () => true,
		memberName: "Dave",
		deps: memory.deps,
	});
	const message: Record<string, unknown> = {};
	message.self = message;
	await assert.rejects(() => journal.append({ ...envelope("bad"), message }, 1), { code: "invalid-record" });
});

test("journal reconciliation removes a handoff with session evidence", async () => {
	const memory = memoryDeps();
	const journal = await openTrustedCompactionDeliveryJournal({
		manifestPath: "/project/.pi/bebop/crew.json",
		projectRoot: "/project",
		isProjectTrusted: () => true,
		memberName: "Dave",
		deps: memory.deps,
	});
	await journal.append(envelope("evidenced"), 1);
	await journal.markHandingOff("evidenced");
	await journal.reconcile((id) => id === "evidenced");
	assert.deepEqual(await journal.listPending(), []);
});

test("journal writers in separate instances retain both records under the filesystem lock", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-delivery-"));
	const manifestPath = path.join(root, ".pi", "bebop", "crew.json");
	await fs.mkdir(path.dirname(manifestPath), { recursive: true });
	await fs.writeFile(manifestPath, "{}\\n");
	const options = { manifestPath, projectRoot: root, isProjectTrusted: () => true, memberName: "Dave" };
	const first = await openTrustedCompactionDeliveryJournal(options);
	const second = await openTrustedCompactionDeliveryJournal(options);
	await Promise.all([first.append(envelope("a"), 1), second.append(envelope("b"), 2)]);
	assert.deepEqual((await first.listPending()).map((record) => record.id).sort(), ["a", "b"]);
	await fs.rm(root, { recursive: true, force: true });
});

test("journal reconciliation requeues an unacknowledged handoff", async () => {
	const memory = memoryDeps();
	const journal = await openTrustedCompactionDeliveryJournal({
		manifestPath: "/project/.pi/bebop/crew.json",
		projectRoot: "/project",
		isProjectTrusted: () => true,
		memberName: "Dave",
		deps: memory.deps,
	});
	await journal.append(envelope("a"), 1);
	await journal.markHandingOff("a");
	await journal.reconcile(() => false);
	assert.equal((await journal.listPending())[0].state, "pending");
});
