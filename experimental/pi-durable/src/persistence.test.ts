import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { memberRequestId, openDurableMember } from "./member.ts";

test("reopen restores a completed submission without a new model request", { timeout: 10_000 }, async () => {
	// Given a real SQLite-backed member that has completed one request.
	const directory = await mkdtemp(join(tmpdir(), "bebop-durable-persistence-"));
	const workspacePath = join(directory, "workspace");
	const storagePath = join(directory, "member.sqlite");
	const requestId = memberRequestId("designer", "persistent-delivery-1");
	await mkdir(workspacePath);

	const firstProvider = fauxProvider();
	firstProvider.setResponses([fauxAssistantMessage("persisted answer")]);
	let member: Awaited<ReturnType<typeof openDurableMember>> | undefined;
	let reopened: Awaited<ReturnType<typeof openDurableMember>> | undefined;
	try {
		member = await openDurableMember({
			storagePath,
			memberId: "designer",
			modelId: firstProvider.getModel().id,
			workspacePath,
			provider: firstProvider.provider,
		});
		assert.deepEqual(await member.submit("known request", requestId), {
			status: "done",
			answer: "persisted answer",
		});
		assert.equal(firstProvider.state.callCount, 1);
		await member.close();
		member = undefined;

		// When the same DB is reopened with no scripted response available.
		const reopenedProvider = fauxProvider();
		reopened = await openDurableMember({
			storagePath,
			memberId: "designer",
			modelId: reopenedProvider.getModel().id,
			workspacePath,
			provider: reopenedProvider.provider,
		});
		const retry = await reopened.submit("known request", requestId);

		// Then the original answer is returned from persisted state, without contacting the provider again.
		assert.deepEqual(retry, { status: "done", answer: "persisted answer" });
		assert.equal(reopenedProvider.state.callCount, 0);

		// A reused id with changed content is rejected from the persisted request hash.
		await assert.rejects(reopened.submit("changed request", requestId), /different message content/);
		assert.equal(reopenedProvider.state.callCount, 0);
	} finally {
		await reopened?.close();
		await member?.close();
		await rm(directory, { recursive: true, force: true });
	}
});
