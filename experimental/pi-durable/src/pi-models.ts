import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface PiModelChoice {
	readonly providerId: string;
	readonly providerName: string;
	readonly authType: "api_key" | "oauth";
	readonly modelId: string;
	readonly modelName: string;
}

/**
 * Reads Pi's normal agent-directory auth and model configuration without network refresh.
 * The runtime's default authPath honors PI_CODING_AGENT_DIR.
 */
export function openPiModelRuntime(): Promise<ModelRuntime> {
	return ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
}

/** Lists catalog chat models for stored Pi credentials without reading credential values. */
export async function listPiModelChoices(
	runtime: ModelRuntime,
	providerFilter?: string,
): Promise<readonly PiModelChoice[]> {
	const credentials = await runtime.listCredentials();
	const choices = credentials
		.filter((credential) => !providerFilter || credential.providerId === providerFilter)
		.flatMap((credential) => {
			const provider = runtime.getProvider(credential.providerId);
			if (!provider) return [];
			return runtime.getModels(credential.providerId).map((model) => ({
				providerId: credential.providerId,
				providerName: provider.name,
				authType: credential.type,
				modelId: model.id,
				modelName: model.name,
			}));
		});
	return choices.sort((left, right) =>
		left.providerId.localeCompare(right.providerId) || left.modelId.localeCompare(right.modelId),
	);
}

export async function requirePiModel(runtime: ModelRuntime, providerId: string, modelId: string): Promise<void> {
	if (!runtime.getModel(providerId, modelId))
		throw new Error(`unknown Pi model ${providerId}/${modelId}; run the models command to list saved-login models`);
	let auth: Awaited<ReturnType<ModelRuntime["checkAuth"]>>;
	try {
		auth = await runtime.checkAuth(providerId);
	} catch {
		throw new Error(`Unable to verify ${providerId} credentials. Open Pi and run /login ${providerId}.`);
	}
	if (!auth)
		throw new Error(`No credentials configured for ${providerId}. Open Pi and run /login ${providerId}.`);
}
