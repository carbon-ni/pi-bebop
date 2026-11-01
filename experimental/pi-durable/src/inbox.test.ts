import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:net";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getDefaultCrewManifestPath } from "../../../src/infra/crew-layout.ts";
import { openTrustedMemberInboxStore, type MemberInboxStore } from "../../../src/infra/member-inbox-store.ts";
import { inboxRequestId, openDurableInboxBridge } from "./inbox.ts";

const MEMBER_ID = "developer";
const ROLE = "developer";

async function listen(socketPath: string): Promise<Server> {
	await fs.mkdir(path.dirname(socketPath), { recursive: true });
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	return server;
}

async function closeServer(server: Server, socketPath: string): Promise<void> {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await fs.rm(socketPath, { force: true });
}

async function fixture() {
	const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-durable-inbox-"));
	const manifestPath = getDefaultCrewManifestPath(projectRoot);
	const layout = path.dirname(manifestPath);
	const memberSocketPath = path.join(layout, "sockets", `${MEMBER_ID}.sock`);
	await fs.mkdir(layout, { recursive: true });
	await fs.writeFile(manifestPath, JSON.stringify({
		version: 2,
		members: [{ name: MEMBER_ID, role: ROLE, socket: `sockets/${MEMBER_ID}.sock` }],
	}));
	const store = await openTrustedMemberInboxStore({
		manifestPath,
		projectRoot,
		isProjectTrusted: () => true,
		member: { name: MEMBER_ID, role: ROLE, socketPath: memberSocketPath },
	});
	return {
		projectRoot,
		manifestPath,
		memberSocketPath,
		store,
		cleanup: async () => fs.rm(projectRoot, { recursive: true, force: true }),
	};
}

function memberWithReceipts() {
	const receipts = new Map<string, { readonly messageHash: string; readonly submissionId: string }>();
	const calls: Array<{ messageHash: string; requestId: string }> = [];
	return {
		calls,
		admit: async (message: string, requestId: string) => {
			const messageHash = createHash("sha256").update(message).digest("hex");
			calls.push({ messageHash, requestId });
			const existing = receipts.get(requestId);
			if (existing) {
				if (existing.messageHash !== messageHash) throw new Error("Inbox item payload changed for an existing receipt");
				return { submissionId: existing.submissionId };
			}
			const receipt = { messageHash, submissionId: `submission-${receipts.size + 1}` };
			receipts.set(requestId, receipt);
			return { submissionId: receipt.submissionId };
		},
	};
}

test("rejects an untrusted project before opening the Inbox or claiming its endpoint", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const hostSocketPath = path.join(f.projectRoot, "host.sock");
	const server = await listen(hostSocketPath);
	t.after(() => closeServer(server, hostSocketPath));

	await assert.rejects(
		openDurableInboxBridge({
			manifestPath: f.manifestPath,
			projectRoot: f.projectRoot,
			isProjectTrusted: () => false,
			memberId: MEMBER_ID,
			hostSocketPath,
			admit: memberWithReceipts().admit,
		}),
		/untrusted project/,
	);
	await assert.rejects(fs.lstat(f.memberSocketPath), /ENOENT/);
});

test("claims the configured endpoint and removes only after Durable admission", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const item = (await f.store.enqueue({ content: "hello", kind: "inbox" }, 1_000)).item;
	const hostSocketPath = path.join(f.projectRoot, "host.sock");
	const server = await listen(hostSocketPath);
	t.after(() => closeServer(server, hostSocketPath));
	const member = memberWithReceipts();
	const order: string[] = [];
	const originalRemove = f.store.remove.bind(f.store);
	const store = Object.assign({}, f.store, {
		remove: async (id: string) => {
			order.push("remove");
			return originalRemove(id);
		},
	}) as MemberInboxStore;
	const bridge = await openDurableInboxBridge({
		manifestPath: f.manifestPath,
		projectRoot: f.projectRoot,
		isProjectTrusted: () => true,
		memberId: MEMBER_ID,
		hostSocketPath,
		admit: member.admit,
		dependencies: {
			openStore: async () => store,
			claimEndpoint: async (...args) => {
				order.push("claim");
				const { claimMemberEndpoint } = await import("../../../src/infra/member-endpoint.ts");
				return claimMemberEndpoint(...args);
			},
		},
	});
	t.after(bridge.close);

	assert.equal(await fs.readlink(f.memberSocketPath), hostSocketPath);
	assert.deepEqual(await bridge.drainOne(), {
		status: "admitted",
		itemId: item.id,
		submissionId: "submission-1",
	});
	assert.deepEqual(order, ["claim", "remove"]);
	assert.deepEqual(member.calls.map(({ requestId }) => requestId), [inboxRequestId(MEMBER_ID, item.id)]);
	assert.equal(await f.store.count(), 0);
	await bridge.close();
	await assert.rejects(fs.lstat(f.memberSocketPath), /ENOENT/);
});

test("retries the same receipt after admission succeeds but Inbox removal fails", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const item = (await f.store.enqueue({ content: "retry me", kind: "inbox" }, 2_000)).item;
	const hostSocketPath = path.join(f.projectRoot, "host.sock");
	const server = await listen(hostSocketPath);
	t.after(() => closeServer(server, hostSocketPath));
	const member = memberWithReceipts();
	const originalRemove = f.store.remove.bind(f.store);
	let removals = 0;
	const store = Object.assign({}, f.store, {
		remove: async (id: string) => {
			removals += 1;
			if (removals === 1) throw new Error("simulated crash before Inbox removal");
			return originalRemove(id);
		},
	}) as MemberInboxStore;
	const bridge = await openDurableInboxBridge({
		manifestPath: f.manifestPath,
		projectRoot: f.projectRoot,
		isProjectTrusted: () => true,
		memberId: MEMBER_ID,
		hostSocketPath,
		admit: member.admit,
		dependencies: { openStore: async () => store },
	});
	t.after(bridge.close);

	await assert.rejects(bridge.drainOne(), /simulated crash/);
	assert.equal(await f.store.count(), 1);
	assert.deepEqual(await bridge.drainOne(), {
		status: "admitted",
		itemId: item.id,
		submissionId: "submission-1",
	});
	assert.equal(member.calls.length, 2);
	assert.equal(member.calls[0]?.requestId, member.calls[1]?.requestId);
	assert.equal(member.calls[0]?.messageHash, member.calls[1]?.messageHash);
	assert.equal(await f.store.count(), 0);
});

test("rejects a retried Inbox ID with changed payload content", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	await f.store.enqueue({ content: "original", kind: "inbox" }, 2_500);
	const hostSocketPath = path.join(f.projectRoot, "host.sock");
	const server = await listen(hostSocketPath);
	t.after(() => closeServer(server, hostSocketPath));
	const member = memberWithReceipts();
	const originalPeek = f.store.peekOldest.bind(f.store);
	const originalRemove = f.store.remove.bind(f.store);
	let peeks = 0;
	let removals = 0;
	const store = Object.assign({}, f.store, {
		peekOldest: async () => {
			const current = await originalPeek();
			peeks += 1;
			return peeks === 1 || current === null
				? current
				: { ...current, payload: { ...current.payload, content: "changed" } };
		},
		remove: async (id: string) => {
			removals += 1;
			if (removals === 1) throw new Error("simulated crash before Inbox removal");
			return originalRemove(id);
		},
	}) as MemberInboxStore;
	const bridge = await openDurableInboxBridge({
		manifestPath: f.manifestPath,
		projectRoot: f.projectRoot,
		isProjectTrusted: () => true,
		memberId: MEMBER_ID,
		hostSocketPath,
		admit: member.admit,
		dependencies: { openStore: async () => store },
	});
	t.after(bridge.close);

	await assert.rejects(bridge.drainOne(), /simulated crash/);
	await assert.rejects(bridge.drainOne(), /payload changed/);
	assert.equal(member.calls.length, 2);
	assert.notEqual(member.calls[0]?.messageHash, member.calls[1]?.messageHash);
	assert.equal(await f.store.count(), 1);
});

test("does not drain if another runtime takes the configured endpoint", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const item = (await f.store.enqueue({ content: "leave pending", kind: "inbox" }, 3_000)).item;
	const hostSocketPath = path.join(f.projectRoot, "host.sock");
	const otherSocketPath = path.join(f.projectRoot, "other.sock");
	const server = await listen(hostSocketPath);
	const otherServer = await listen(otherSocketPath);
	t.after(() => closeServer(server, hostSocketPath));
	t.after(() => closeServer(otherServer, otherSocketPath));
	const member = memberWithReceipts();
	const bridge = await openDurableInboxBridge({
		manifestPath: f.manifestPath,
		projectRoot: f.projectRoot,
		isProjectTrusted: () => true,
		memberId: MEMBER_ID,
		hostSocketPath,
		admit: member.admit,
	});
	t.after(bridge.close);

	await fs.unlink(f.memberSocketPath);
	await fs.symlink(otherSocketPath, f.memberSocketPath);
	assert.deepEqual(await bridge.drainOne(), { status: "not-owner" });
	assert.equal(member.calls.length, 0);
	assert.equal(await f.store.count(), 1);
	await bridge.close();
	assert.equal(await fs.readlink(f.memberSocketPath), otherSocketPath);
});

test("refuses to claim an endpoint already owned by a live Pi member", async (t) => {
	const f = await fixture();
	t.after(f.cleanup);
	const hostSocketPath = path.join(f.projectRoot, "durable.sock");
	const livePiSocketPath = path.join(f.projectRoot, "pi.sock");
	const host = await listen(hostSocketPath);
	const pi = await listen(livePiSocketPath);
	t.after(() => closeServer(host, hostSocketPath));
	t.after(() => closeServer(pi, livePiSocketPath));
	await fs.mkdir(path.dirname(f.memberSocketPath), { recursive: true });
	await fs.symlink(livePiSocketPath, f.memberSocketPath);

	await assert.rejects(
		openDurableInboxBridge({
			manifestPath: f.manifestPath,
			projectRoot: f.projectRoot,
			isProjectTrusted: () => true,
			memberId: MEMBER_ID,
			hostSocketPath,
			admit: memberWithReceipts().admit,
		}),
		(error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "live-foreign",
	);
	assert.equal(await fs.readlink(f.memberSocketPath), livePiSocketPath);
});
