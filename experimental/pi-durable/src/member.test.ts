import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { memberRequestId, openDurableMember, readWorkspaceFile, requestContentHash } from "./member.ts";

test("request IDs are deterministic and scoped to a stable member and delivery", () => {
	const first = memberRequestId("designer", "inbox-42");
	assert.equal(first, memberRequestId("designer", "inbox-42"));
	assert.notEqual(first, memberRequestId("reviewer", "inbox-42"));
	assert.notEqual(first, memberRequestId("designer", "inbox-43"));
	assert.throws(() => memberRequestId("", "inbox-42"), /must not be empty/);
	const requestId = memberRequestId("designer", "delivery-1");
	const payloadHash = createHash("sha256").update("same payload").digest("hex");
	const known = { [requestId]: requestContentHash({}, requestId, payloadHash) };
	assert.equal(requestContentHash(known, requestId, payloadHash), known[requestId]);
	assert.throws(
		() => requestContentHash(known, requestId, createHash("sha256").update("different payload").digest("hex")),
		/different message content/,
	);
	assert.throws(() => requestContentHash({}, "__proto__", "payload"), /not a valid Bebop delivery key/);
});

test("read-only file access is bounded to regular files inside the workspace", async () => {
	const directory = await mkdtemp(join(tmpdir(), "bebop-durable-read-"));
	const workspace = join(directory, "workspace");
	const outside = join(directory, "outside.txt");
	try {
		await mkdir(workspace);
		await writeFile(join(workspace, "notes.txt"), "crew notes");
		await writeFile(join(workspace, "large.txt"), "x".repeat(64 * 1024 + 1));
		await writeFile(outside, "private");
		await symlink(outside, join(workspace, "escape.txt"));
		assert.equal(await readWorkspaceFile(workspace, "notes.txt"), "crew notes");
		await assert.rejects(readWorkspaceFile(workspace, "../outside.txt"), /must stay inside/);
		await assert.rejects(readWorkspaceFile(workspace, "escape.txt"), /must stay inside/);
		await assert.rejects(readWorkspaceFile(workspace, "large.txt"), /exceeds the 65536-byte/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Inbox admission is idempotent and rejects a reused item key with another payload", async () => {
	const directory = await mkdtemp(join(tmpdir(), "bebop-durable-inbox-"));
	const workspacePath = join(directory, "workspace");
	await mkdir(workspacePath);
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("received")]);
	const member = await openDurableMember({
		storagePath: join(directory, "member.sqlite"),
		memberId: "designer",
		modelId: faux.getModel().id,
		workspacePath,
		provider: faux.provider,
	});
	try {
		const payloadHash = createHash("sha256").update('{"content":"hello"}').digest("hex");
		const first = await member.admitInbox("item-17", "[inbox item item-17] hello", payloadHash);
		const retry = await member.admitInbox("item-17", "[inbox item item-17] hello", payloadHash);
		assert.deepEqual(retry, first);
		await assert.rejects(
			member.admitInbox("item-17", "[inbox item item-17] changed", createHash("sha256").update('{"content":"changed"}').digest("hex")),
			/different message content/,
		);
	} finally {
		await member.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("storage paths through symlinked directories are rejected", async () => {
	const directory = await mkdtemp(join(tmpdir(), "bebop-durable-storage-"));
	const realStorage = join(directory, "real");
	const alias = join(directory, "alias");
	const workspacePath = join(directory, "workspace");
	try {
		await mkdir(realStorage);
		await mkdir(workspacePath);
		await symlink(realStorage, alias);
		await assert.rejects(
			openDurableMember({ storagePath: join(alias, "member.sqlite"), memberId: "designer", modelId: "gpt-4.1-mini", workspacePath }),
			/storage directory must be a real directory/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("reopening the same database restores the same independent member conversation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "bebop-durable-"));
	const storagePath = join(directory, "member.sqlite");
	let first: Awaited<ReturnType<typeof openDurableMember>> | undefined;
	let reopened: Awaited<ReturnType<typeof openDurableMember>> | undefined;
	try {
		const workspacePath = join(directory, "workspace");
		await mkdir(workspacePath);
		first = await openDurableMember({ storagePath, memberId: "designer", modelId: "gpt-4.1-mini", workspacePath });
		const originalId = first.conversationId;
		await assert.rejects(
			openDurableMember({ storagePath, memberId: "reviewer", modelId: "gpt-4.1-mini", workspacePath: join(directory, "workspace") }),
			/already open by process/,
		);
		await first.close();
		first = undefined;

		reopened = await openDurableMember({ storagePath, memberId: "designer", modelId: "gpt-4.1-mini", workspacePath: join(directory, "workspace") });
		assert.equal(reopened.conversationId, originalId);
		await reopened.close();
		reopened = undefined;
		await assert.rejects(
			openDurableMember({ storagePath, memberId: "reviewer", modelId: "gpt-4.1-mini", workspacePath: join(directory, "workspace") }),
			/database is bound to a different member configuration/,
		);
		await assert.rejects(
			openDurableMember({ storagePath, memberId: "designer", modelId: "gpt-4.1", workspacePath: join(directory, "workspace") }),
			/database is bound to a different member configuration/,
		);
		await assert.rejects(
			openDurableMember({ storagePath, memberId: "designer", modelId: "gpt-4.1-mini", workspacePath: join(directory, "workspace"), role: "reviewer" }),
			/database is bound to a different member configuration/,
		);
		await writeFile(join(directory, "crew.json"), "{}");
		await assert.rejects(
			openDurableMember({
				storagePath,
				memberId: "designer",
				modelId: "gpt-4.1-mini",
				workspacePath: join(directory, "workspace"),
				trustedProjectRoot: directory,
				inboxManifestPath: join(directory, "crew.json"),
			}),
			/database is bound to a different member configuration/,
		);
	} finally {
		await reopened?.close();
		await first?.close();
		await rm(directory, { recursive: true, force: true });
	}
});
