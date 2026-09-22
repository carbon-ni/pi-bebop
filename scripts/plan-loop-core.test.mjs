import { test } from "node:test";
import assert from "node:assert/strict";
import {
	classifyBoard,
	decide,
	normalizeTaskId,
	parsePlanFile,
	renderDecision,
	TAG_ALL_PLANS_DONE,
	TAG_BLOCKED,
	TAG_FINALIZE,
	TAG_FIX_BOARD,
	TAG_NEXT_PLAN,
	TAG_NO_WORKERS,
	TAG_WAIT,
	EXIT_NO_WORKERS,
} from "./plan-loop-core.mjs";

const FRONTMATTER = (id, status, deps = "[]") =>
	`---
id: ${id}
title: Do the thing
status: ${status}
depends_on: ${deps}
priority: normal
---

# Body
`;

const worker = (name, kind) => ({ name, role: name === "Dave" ? "dev" : "qa", state: { kind } });

test("normalizeTaskId collapses TASK prefixes and leading zeros but keeps non-numeric ids", () => {
	assert.equal(normalizeTaskId("TASK-0171"), "171");
	assert.equal(normalizeTaskId("0171"), "171");
	assert.equal(normalizeTaskId("TASK-171"), "171");
	assert.equal(normalizeTaskId("crew-0007"), "crew-0007");
	assert.equal(normalizeTaskId(""), "");
});

test("parsePlanFile reads frontmatter fields", () => {
	const plan = parsePlanFile(FRONTMATTER("TASK-0172", "todo", "[TASK-0171, TASK-0170]"), "0172-x.md");
	assert.equal(plan.id, "172");
	assert.equal(plan.title, "Do the thing");
	assert.equal(plan.status, "todo");
	assert.deepEqual(plan.deps, ["171", "170"]);
	assert.equal(plan.fileName, "0172-x.md");
});

test("parsePlanFile reads multiline depends_on lists", () => {
	const content = `---
id: TASK-0181
title: Quickstart
status: doing
depends_on:
  - TASK-0174
  - TASK-0179
---

Body
`;
	const plan = parsePlanFile(content, "0181-x.md");
	assert.deepEqual(plan.deps, ["174", "179"]);
	assert.equal(plan.status, "doing");
});

test("parsePlanFile falls back to the filename id when frontmatter is missing", () => {
	const plan = parsePlanFile("# legacy plan without frontmatter", "0172-old-style.md");
	assert.equal(plan.id, "172");
	assert.deepEqual(plan.deps, []);
	assert.equal(plan.status, "");
});

test("classifyBoard derives doing, ready, and blocked buckets", () => {
	const done = [{ id: "170" }, { id: "171" }].map((p) => ({ ...p, title: "", status: "done", deps: [] }));
	const todo = [
		parsePlanFile(FRONTMATTER("TASK-0172", "doing", "[TASK-0171, TASK-0170]"), "0172.md"),
		parsePlanFile(FRONTMATTER("TASK-0173", "todo", "[TASK-0172]"), "0173.md"),
		parsePlanFile(FRONTMATTER("TASK-0180", "todo", "[TASK-0171]"), "0180.md"),
	];
	const board = classifyBoard({ todoPlans: todo, donePlans: done });
	assert.equal(board.todoCount, 3);
	assert.equal(board.doneCount, 2);
	assert.deepEqual(
		board.doing.map((p) => p.id),
		["172"],
	);
	assert.deepEqual(
		board.ready.map((p) => p.id),
		["180"],
	);
	assert.deepEqual(
		board.blocked.map((p) => p.id),
		["173"],
	);
});

test("decide stops when plans/todo is empty", () => {
	const board = { todoCount: 0, doneCount: 5, doneIds: new Set(), doing: [], ready: [], blocked: [] };
	const decision = decide({ board, workers: [] });
	assert.equal(decision.tag, TAG_ALL_PLANS_DONE);
	assert.equal(decision.exitCode, 0);
	assert.match(renderDecision(decision), /plans\/todo is empty/);
	assert.match(renderDecision(decision), /Stop the loop/);
});

test("decide refuses to guess when two plans are doing", () => {
	const doingPlans = [
		parsePlanFile(FRONTMATTER("TASK-0172", "doing"), "0172.md"),
		parsePlanFile(FRONTMATTER("TASK-0173", "doing"), "0173.md"),
	];
	const board = { todoCount: 2, doneCount: 0, doing: doingPlans, ready: [], blocked: [] };
	const decision = decide({ board, workers: [worker("Dave", "idle")] });
	assert.equal(decision.tag, TAG_FIX_BOARD);
	assert.equal(decision.exitCode, 2);
	assert.match(renderDecision(decision), /more than one plan is doing/);
});

test("decide finalizes the doing plan only when every worker is idle", () => {
	const plan = parsePlanFile(FRONTMATTER("TASK-0172", "doing"), "0172.md");
	const board = { todoCount: 1, doneCount: 0, doing: [plan], ready: [], blocked: [] };
	const idleCrew = [worker("Dave", "idle"), worker("Kelly", "idle")];
	const decision = decide({ board, workers: idleCrew });
	assert.equal(decision.tag, TAG_FINALIZE);
	assert.equal(decision.exitCode, 5);
	const message = renderDecision(decision);
	assert.match(message, /crew idle and 172 is doing/);
	assert.match(message, /git mv plans\/todo\/0172.md plans\/done\//);
});

test("decide waits while any worker is busy, naming the busy worker", () => {
	const plan = parsePlanFile(FRONTMATTER("TASK-0172", "doing"), "0172.md");
	const board = { todoCount: 1, doneCount: 0, doing: [plan], ready: [], blocked: [] };
	const decision = decide({ board, workers: [worker("Dave", "busy"), worker("Kelly", "idle")] });
	assert.equal(decision.tag, TAG_WAIT);
	assert.equal(decision.exitCode, 4);
	assert.match(renderDecision(decision), /Dave/);
	assert.doesNotMatch(renderDecision(decision), /Kelly/);
});

test("decide waits when a worker is offline instead of trusting an idle claim", () => {
	const plan = parsePlanFile(FRONTMATTER("TASK-0172", "doing"), "0172.md");
	const board = { todoCount: 1, doneCount: 0, doing: [plan], ready: [], blocked: [] };
	const decision = decide({ board, workers: [worker("Dave", "offline"), worker("Kelly", "idle")] });
	assert.equal(decision.tag, TAG_WAIT);
	assert.match(renderDecision(decision), /unavailable/);
});

test("decide picks the next ready plan only when workers are idle", () => {
	const ready = [parsePlanFile(FRONTMATTER("TASK-0180", "todo"), "0180.md")];
	const board = { todoCount: 1, doneCount: 10, doing: [], ready, blocked: [] };
	const decision = decide({ board, workers: [worker("Dave", "idle"), worker("Kelly", "idle")] });
	assert.equal(decision.tag, TAG_NEXT_PLAN);
	assert.equal(decision.exitCode, 3);
	assert.match(renderDecision(decision), /work on next plan 180/);
	assert.match(renderDecision(decision), /Mark it doing/);
});

test("decide does not start the next plan while workers are busy", () => {
	const ready = [parsePlanFile(FRONTMATTER("TASK-0180", "todo"), "0180.md")];
	const board = { todoCount: 1, doneCount: 10, doing: [], ready, blocked: [] };
	const decision = decide({ board, workers: [worker("Dave", "busy")] });
	assert.equal(decision.tag, TAG_WAIT);
	assert.match(renderDecision(decision), /before starting it/);
});

test("decide reports no workers when a ready plan has no selected workers", () => {
	const ready = [parsePlanFile(FRONTMATTER("TASK-0180", "todo"), "0180.md")];
	const board = { todoCount: 1, doneCount: 10, doing: [], ready, blocked: [] };
	const decision = decide({ board, workers: [] });
	assert.equal(decision.tag, TAG_NO_WORKERS);
	assert.equal(decision.exitCode, EXIT_NO_WORKERS);
});

test("decide reports blocked plans when nothing is ready", () => {
	const blocked = [parsePlanFile(FRONTMATTER("TASK-0173", "todo", "[TASK-0172]"), "0173.md")];
	const board = { todoCount: 1, doneCount: 0, doing: [], ready: [], blocked };
	const decision = decide({ board, workers: [worker("Dave", "idle")] });
	assert.equal(decision.tag, TAG_BLOCKED);
	assert.equal(decision.exitCode, 6);
	assert.match(renderDecision(decision), /173 - Do the thing/);
});

test("decide reports a missing worker configuration instead of guessing", () => {
	const plan = parsePlanFile(FRONTMATTER("TASK-0172", "doing"), "0172.md");
	const board = { todoCount: 1, doneCount: 0, doing: [plan], ready: [], blocked: [] };
	const decision = decide({ board, workers: [] });
	assert.equal(decision.tag, TAG_NO_WORKERS);
	assert.equal(decision.exitCode, 7);
});
