const MAX_METADATA_CHARS = 512;

const PURPOSE_INSTRUCTIONS = {
	implement:
		"Select the primary implementation worker whose role best matches the unfinished plan. Choose one exact candidate name.",
	verify: "Select the best independent reviewer for this plan's acceptance criteria and failure paths. Choose one exact candidate name.",
};

async function evaluateWithTypeSafe({ state, instructions, criteria }) {
	const { choice, TypeSafeClient } = await import("@typesafe-ai/sdk");
	const client = new TypeSafeClient();
	const response = await client.systemOne({
		state,
		questions: { worker: choice(instructions, criteria) },
	});
	return response.answers.worker;
}

/**
 * Selects one relevant worker; TypeSafe supplies only the semantic preference.
 * Plan bodies stay local. Only bounded plan metadata and public crew labels cross
 * the API boundary.
 */
export async function selectWorker({ plan, candidates, purpose, evaluate = evaluateWithTypeSafe }) {
	if (!Array.isArray(candidates) || candidates.length === 0) throw new Error("no worker candidates available");
	if (candidates.length === 1) return candidates[0];
	const instructions = PURPOSE_INSTRUCTIONS[purpose];
	if (!instructions) throw new Error(`unknown worker selection purpose '${purpose}'`);

	const criteria = Object.fromEntries(
		candidates.map((candidate) => [
			candidate.name,
			{
				role: String(candidate.role).slice(0, MAX_METADATA_CHARS),
				description: String(candidate.description || "No role description provided").slice(
					0,
					MAX_METADATA_CHARS,
				),
			},
		]),
	);
	const answer = await evaluate({
		state: {
			plan: {
				id: String(plan.id).slice(0, MAX_METADATA_CHARS),
				title: String(plan.title).slice(0, MAX_METADATA_CHARS),
			},
			purpose,
		},
		instructions,
		criteria,
	});
	const selected = candidates.find((candidate) => candidate.name === answer?.choice);
	if (!selected) throw new Error(`TypeSafe selected unknown worker '${answer?.choice ?? "(missing)"}'`);
	return selected;
}
