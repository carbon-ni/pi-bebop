import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openTrustedMemberInboxStore } from "./bebop-inbox-adapter.mjs";
import { openDurableInboxRuntime } from "./durable-inbox-runtime.ts";
import { durableSocketPath, openDurableMember } from "./member.ts";
import { requestMember } from "./client.ts";
import { runMemberServer } from "./server.ts";

const MEMBER_ID = "designer";
const ROLE = "designer";

async function listen(socketPath: string): Promise<Server> {
	await mkdir(path.dirname(socketPath), { recursive: true });
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
	return server;
}

async function closeServer(server: Server): Promise<void> {
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function fixture() {
	const projectRoot = await mkdtemp(path.join(tmpdir(), "bebop-durable-inbox-runtime-"));
	const layout = path.join(projectRoot, ".pi", "bebop");
	const manifestPath = path.join(layout, "crew.json");
	const memberSocketPath = path.join(layout, "sockets", `${MEMBER_ID}.sock`);
	const workspacePath = path.join(projectRoot, "workspace");
	const storagePath = path.join(projectRoot, "state", "member.sqlite");
	await mkdir(layout, { recursive: true });
	await mkdir(workspacePath);
	await mkdir(path.dirname(storagePath), { mode: 0o700 });
	await writeFile(manifestPath, JSON.stringify({
		version: 2,
		members: [{ name: MEMBER_ID, role: ROLE, socket: `sockets/${MEMBER_ID}.sock` }],
	}));
	const inbox = await openTrustedMemberInboxStore({
		manifestPath,
		projectRoot,
		isProjectTrusted: () => true,
		member: { name: MEMBER_ID, role: ROLE, socketPath: memberSocketPath },
	});
	const queued = (await inbox.enqueue({ kind: "inbox", content: "Say inbox received" }, 1_000)).item;
	const faux = fauxProvider();
	const member = await openDurableMember({
		storagePath,
		memberId: MEMBER_ID,
		role: ROLE,
		modelId: faux.getModel().id,
		workspacePath,
		provider: faux.provider,
		autoResume: false,
		trustedProjectRoot: projectRoot,
		inboxManifestPath: manifestPath,
	});
	const hostSocketPath = await durableSocketPath(storagePath);
	return {
		projectRoot,
		manifestPath,
		memberSocketPath,
		workspacePath,
		storagePath,
		hostSocketPath,
		inbox,
		queued,
		faux,
		member,
	};
}

async function cleanupHost(options: {
	storagePath: string;
	member: Awaited<ReturnType<typeof openDurableMember>>;
	host: Promise<void>;
	runtime?: Awaited<ReturnType<typeof openDurableInboxRuntime>>;
}): Promise<void> {
	await options.runtime?.close();
	try {
		await requestMember(options.storagePath, { type: "stop" });
	} catch {
		// Startup-hook failures close the host before a stop request can be sent.
	}
	await options.host.catch(() => undefined);
	await options.member.close();
}

function isLiveForeignEndpoint(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "live-foreign";
}

test("a live Pi endpoint refuses startup and leaves its Inbox item queued", { timeout: 10_000 }, async () => {
	const f = await fixture();
	const piSocketPath = path.join(f.projectRoot, "pi-member.sock");
	const piServer = await listen(piSocketPath);
	let runtime: Awaited<ReturnType<typeof openDurableInboxRuntime>> | undefined;
	await mkdir(path.dirname(f.memberSocketPath), { recursive: true });
	await symlink(piSocketPath, f.memberSocketPath);
	const host = runMemberServer({
		socketPath: f.hostSocketPath,
		memberId: MEMBER_ID,
		role: ROLE,
		modelId: f.faux.getModel().id,
		workspacePath: f.workspacePath,
		conversationId: f.member.conversationId,
		member: f.member,
		onListening: async () => {
			runtime = await openDurableInboxRuntime({
				manifestPath: f.manifestPath,
				projectRoot: f.projectRoot,
				isProjectTrusted: () => true,
				memberId: MEMBER_ID,
				hostSocketPath: f.hostSocketPath,
				member: f.member,
			});
			f.member.resume();
		},
	});

	try {
		await assert.rejects(host, isLiveForeignEndpoint);
		assert.equal(await f.inbox.count(), 1);
		assert.equal((await f.inbox.peekOldest())?.id, f.queued.id);
		assert.equal(await readlink(f.memberSocketPath), piSocketPath);
	} finally {
		await cleanupHost({ storagePath: f.storagePath, member: f.member, host, runtime });
		await closeServer(piServer);
		await rm(f.projectRoot, { recursive: true, force: true });
	}
});

test("a startup-hook failure propagates and cleanup releases the endpoint and member lock", { timeout: 10_000 }, async () => {
	const f = await fixture();
	let runtime: Awaited<ReturnType<typeof openDurableInboxRuntime>> | undefined;
	const host = runMemberServer({
		socketPath: f.hostSocketPath,
		memberId: MEMBER_ID,
		role: ROLE,
		modelId: f.faux.getModel().id,
		workspacePath: f.workspacePath,
		conversationId: f.member.conversationId,
		member: f.member,
		onListening: async () => {
			runtime = await openDurableInboxRuntime({
				manifestPath: f.manifestPath,
				projectRoot: f.projectRoot,
				isProjectTrusted: () => true,
				memberId: MEMBER_ID,
				hostSocketPath: f.hostSocketPath,
				member: f.member,
			});
			throw new Error("simulated startup failure after endpoint claim");
		},
	});

	try {
		await assert.rejects(host, /simulated startup failure after endpoint claim/);
		assert.equal(await f.inbox.count(), 1);
	} finally {
		await cleanupHost({ storagePath: f.storagePath, member: f.member, host, runtime });
	}

	try {
		await assert.rejects(access(f.memberSocketPath), /ENOENT/);
		await assert.rejects(access(`${f.storagePath}.lock`), /ENOENT/);
		const reopened = await openDurableMember({
			storagePath: f.storagePath,
			memberId: MEMBER_ID,
			role: ROLE,
			modelId: f.faux.getModel().id,
			workspacePath: f.workspacePath,
			provider: f.faux.provider,
			autoResume: false,
			trustedProjectRoot: f.projectRoot,
			inboxManifestPath: f.manifestPath,
		});
		await reopened.close();
	} finally {
		await rm(f.projectRoot, { recursive: true, force: true });
	}
});
