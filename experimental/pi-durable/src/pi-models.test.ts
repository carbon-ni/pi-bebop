import assert from "node:assert/strict";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { listPiModelChoices, requirePiModel } from "./pi-models.ts";

test("saved-login discovery uses credential metadata and static models only", async () => {
	let credentialReads = 0;
	const providerId = "openai-codex";
	const credentialInfo: readonly CredentialInfo[] = [{ providerId, type: "oauth" }];
	const credentials: CredentialStore = {
		read: async () => {
			credentialReads += 1;
			throw new Error("credential values must not be read during model discovery");
		},
		list: async () => credentialInfo,
		modify: async (_providerId: string, _update: (current: Credential | undefined) => Promise<Credential | undefined>) => undefined,
		delete: async () => undefined,
	};
	const runtime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});

	const choices = await listPiModelChoices(runtime, providerId);

	assert.ok(runtime.getProvider(providerId)?.auth.oauth, `${providerId} must be a catalog OAuth provider`);
	assert.ok(choices.length > 0);
	assert.ok(choices.every((choice) => choice.providerId === providerId && choice.authType === "oauth"));
	assert.equal(credentialReads, 0);
});

test("selected-provider preflight recognizes saved OAuth without refreshing its token", async () => {
	const providerId = "openai-codex";
	let credentialReads = 0;
	let credentialWrites = 0;
	const credentials: CredentialStore = {
		read: async () => {
			credentialReads += 1;
			return { type: "oauth", refresh: "refresh-token", access: "expired-token", expires: 0 };
		},
		list: async () => [{ providerId, type: "oauth" }],
		modify: async () => {
			credentialWrites += 1;
			return undefined;
		},
		delete: async () => undefined,
	};
	const runtime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const model = runtime.getModels(providerId)[0];
	assert.ok(model, `${providerId} must have a static model`);

	await requirePiModel(runtime, providerId, model.id);

	assert.equal(credentialReads, 1);
	assert.equal(credentialWrites, 0);
});
