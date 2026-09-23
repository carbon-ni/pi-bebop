import { test } from "node:test";
import assert from "node:assert/strict";
import { selectWorker } from "./plan-loop-typesafe.mjs";

const plan = {
	id: "217",
	title: "Automate crew plan assignment",
	content: "Implement a condition evaluator and verify its failure paths.",
	fileName: "0217-plan.md",
};
const candidates = [
	{ name: "Dave", role: "dev", description: "Builds domain and application changes" },
	{ name: "Kelly", role: "qa", description: "Verifies acceptance and failure paths" },
];

test("uses TypeSafe Choice to select the relevant worker", async () => {
	let request;
	const selected = await selectWorker({
		plan,
		candidates,
		purpose: "implement",
		evaluate: async (input) => {
			request = input;
			return { choice: "Dave", confidence: 0.71 };
		},
	});

	assert.equal(selected, candidates[0]);
	assert.deepEqual(request.state.plan, {
		id: "217",
		title: "Automate crew plan assignment",
	});
	assert.equal("content" in request.state.plan, false);
	assert.deepEqual(request.criteria, {
		Dave: { role: "dev", description: "Builds domain and application changes" },
		Kelly: { role: "qa", description: "Verifies acceptance and failure paths" },
	});
	assert.match(request.instructions, /primary implementation worker/);
});

test("selects the only candidate without an AI call", async () => {
	const selected = await selectWorker({
		plan,
		candidates: [candidates[0]],
		purpose: "implement",
		evaluate: async () => {
			throw new Error("must not run");
		},
	});

	assert.equal(selected, candidates[0]);
});

test("fails closed when TypeSafe selects an unknown worker", async () => {
	await assert.rejects(
		selectWorker({
			plan,
			candidates,
			purpose: "verify",
			evaluate: async () => ({ choice: "Unknown", confidence: 0.9 }),
		}),
		/unknown worker/,
	);
});
