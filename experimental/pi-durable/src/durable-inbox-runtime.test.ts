import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openTrustedMemberInboxStore } from "./bebop-inbox-adapter.mjs";
import { durableSocketPath, openDurableMember } from "./member.ts";
import { openDurableInboxRuntime } from "./durable-inbox-runtime.ts";
import { runMemberServer } from "./server.ts";
import { requestMember } from "./client.ts";

async function waitUntilReady(storagePath: string): Promise<Record<string, unknown>> {
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline) {
		try {
			const status = await requestMember(storagePath, { type: "status" });
			if (status.status === "running") return status;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Durable Inbox host did not become ready in time");
}

test("host startup claims a real trusted Inbox before Durable resumes and transfers to one real Durable submission",  { timeout: 10_000 }, async () => {
	const root = await mkdtemp(path.join(tmpdir(), "bebop-durable-e2e-"));
	const layout = path.join(root, ".pi", "bebop");
	const manifestPath = path.join(layout, "crew.json");
	const memberSocketPath = path.join(layout, "sockets", "designer.sock");
	const workspacePath = path.join(root, "workspace");
	const storagePath = path.join(root, "state", "member.sqlite");
	await mkdir(layout, { recursive: true });
	await mkdir(workspacePath);
	await mkdir(path.dirname(storagePath), { mode: 0o700 });
	await writeFile(manifestPath, JSON.stringify({
		version: 2,
		members: [{ name: "designer", role: "designer", socket: "sockets/designer.sock" }],
	}));

	const inbox = await openTrustedMemberInboxStore({
		manifestPath,
		projectRoot: root,
		isProjectTrusted: () => true,
		member: { name: "designer", role: "designer", socketPath: memberSocketPath },
	});
	const queued = (await inbox.enqueue({ kind: "inbox", content: "Say inbox received" }, 1_000)).item;
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("inbox received")]);
	const member = await openDurableMember({
		storagePath,
		memberId: "designer",
		role: "designer",
		modelId: faux.getModel().id,
		workspacePath,
		provider: faux.provider,
		autoResume: false,
		trustedProjectRoot: root,
		inboxManifestPath: manifestPath,
	});
	const hostSocketPath = await durableSocketPath(storagePath);
	let runtime: Awaited<ReturnType<typeof openDurableInboxRuntime>> | undefined;
	let admitted: string | undefined;
	const server = runMemberServer({
		socketPath: hostSocketPath,
		memberId: "designer",
		role: "designer",
		modelId: faux.getModel().id,
		workspacePath,
		conversationId: member.conversationId,
		member,
		onListening: async () => {
			runtime = await openDurableInboxRuntime({
				manifestPath,
				projectRoot: root,
				isProjectTrusted: () => true,
				memberId: "designer",
				hostSocketPath,
				member,
			});
			assert.equal(await readlink(memberSocketPath), hostSocketPath);
			const drained = await runtime.drainOne();
			assert.equal(drained.status, "admitted");
			if (drained.status === "admitted") admitted = drained.submissionId;
			assert.equal(await inbox.count(), 0);
			member.resume();
		},
		shutdownGraceMs: 2_000,
	});

	try {
		const status = await waitUntilReady(storagePath);
		assert.equal(status.status, "running");
		assert.equal(await inbox.count(), 0);
		assert.equal(await access(memberSocketPath).then(() => true), true);
		assert.ok(admitted);
		const result = await member.awaitSubmission(admitted!);
		assert.deepEqual(result, { status: "done", answer: "inbox received" });
		assert.equal(await inbox.count(), 0);
	} finally {
		await runtime?.close();
		try { await requestMember(storagePath, { type: "stop" }); } catch {}
		await server;
		await member.close();
		await rm(root, { recursive: true, force: true });
	}
});
