/**
 * Pure decision logic for the crew plan loop (scripts/plan-loop.mjs entry).
 *
 * No IO: callers supply parsed plan files and mechanically observed worker
 * states. The loop exists because models can misreport; every verdict here is
 * derived from the board on disk and the public member-status contract, never
 * from what a member says about itself.
 *
 * Board rules (folder is truth, frontmatter is detail):
 * - plans/todo/*.md  -> not finished
 * - plans/done/*.md  -> finished
 * - a todo plan with frontmatter `status: doing` is in progress
 * - at most one plan may be doing at a time
 * - a todo plan is ready when every `depends_on` id exists in done/
 */

export const TAG_ALL_PLANS_DONE = "ALL_PLANS_DONE";
export const TAG_FIX_BOARD = "FIX_BOARD";
export const TAG_NEXT_PLAN = "NEXT_PLAN";
export const TAG_WAIT = "WAIT";
export const TAG_FINALIZE = "FINALIZE";
export const TAG_BLOCKED = "BLOCKED";
export const TAG_NO_WORKERS = "NO_WORKERS";

export const EXIT_ALL_PLANS_DONE = 0;
export const EXIT_USAGE_ERROR = 1;
export const EXIT_BOARD_ERROR = 2;
export const EXIT_NEXT_PLAN = 3;
export const EXIT_WAIT = 4;
export const EXIT_FINALIZE = 5;
export const EXIT_BLOCKED = 6;
export const EXIT_NO_WORKERS = 7;

/**
 * Normalizes a task id from any source so equal tasks compare equal:
 * "TASK-0171", "0171", and "TASK-171" all become "171"; non-numeric ids such
 * as "crew-0007" keep their shape. Deps are compared against done ids only
 * after this normalization.
 */
export function normalizeTaskId(value) {
	if (typeof value !== "string" || value.trim().length === 0) return "";
	const trimmed = value.trim();
	const withoutPrefix = trimmed.replace(/^TASK-/i, "");
	const numeric = /^\d+$/.test(withoutPrefix);
	return numeric ? withoutPrefix.replace(/^0+/, "") || "0" : withoutPrefix;
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const MAX_PLAN_TITLE_CHARS = 512;
const MAX_CONDITION_TEXT_CHARS = 2_000;

function readYamlKey(frontmatter, key) {
	for (const line of frontmatter.split(/\r?\n/)) {
		const match = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
		if (match && match[1] === key) return match[2].trim();
	}
	return undefined;
}

function readListValue(frontmatter, key) {
	const lines = frontmatter.split(/\r?\n/);
	const start = lines.findIndex((line) => /^[A-Za-z_][A-Za-z0-9_]*:/.test(line) && line.startsWith(`${key}:`));
	if (start === -1) return [];
	const inline = /\[([^\]]*)\]/.exec(lines[start]);
	if (inline) {
		return inline[1]
			.split(",")
			.map((item) => item.trim())
			.filter((item) => item.length > 0);
	}
	const items = [];
	for (let i = start + 1; i < lines.length; i += 1) {
		const line = lines[i];
		if (/^[A-Za-z_][A-Za-z0-9_]*:/.test(line)) break;
		const item = /^-\s*(.+)$/.exec(line.trim());
		if (item) items.push(item[1].trim());
	}
	return items;
}

function idFromFileName(fileName) {
	const base = fileName.replace(/\.md$/i, "");
	const match = /^([^-\s]+)/.exec(base);
	return match ? normalizeTaskId(match[1]) : "";
}

/**
 * Parses one board file into { id, title, status, deps }. The frontmatter id
 * wins; a missing or malformed frontmatter falls back to the numeric filename
 * prefix so an honest board never silently drops a file.
 */
export function parsePlanFile(content, fileName = "") {
	const frontmatter = FRONTMATTER_PATTERN.exec(content)?.[1];
	const id = frontmatter === undefined ? "" : normalizeTaskId(readYamlKey(frontmatter, "id") ?? "");
	const title =
		frontmatter === undefined
			? ""
			: (readYamlKey(frontmatter, "title") ?? "").trim().slice(0, MAX_PLAN_TITLE_CHARS);
	const status = frontmatter === undefined ? "" : (readYamlKey(frontmatter, "status") ?? "").trim();
	const deps = frontmatter === undefined ? [] : readListValue(frontmatter, "depends_on").map(normalizeTaskId);
	return {
		id: id || idFromFileName(fileName),
		title,
		status,
		deps: deps.filter((dep) => dep.length > 0),
		fileName,
	};
}

/**
 * Splits parsed plans into a board. doneIds are the ids in plans/done;
 * plans in todo are doing / ready / blocked by their status and deps.
 */
export function classifyBoard({ todoPlans, donePlans }) {
	const doneIds = new Set(donePlans.map((plan) => plan.id).filter((id) => id.length > 0));
	const doing = todoPlans.filter((plan) => plan.status === "doing");
	const notStarted = todoPlans.filter((plan) => plan.status !== "doing");
	const ready = notStarted.filter((plan) => plan.deps.every((dep) => doneIds.has(dep)));
	const blocked = notStarted.filter((plan) => !plan.deps.every((dep) => doneIds.has(dep)));
	ready.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
	blocked.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
	return { todoCount: todoPlans.length, doneCount: donePlans.length, doneIds, doing, ready, blocked };
}

/**
 * Mechanically observed worker state. kind:
 * - "idle"       probe succeeded, activity idle
 * - "busy"       probe succeeded, activity busy or compacting
 * - "offline"    public member status reports the endpoint offline
 * - "error"      CLI/protocol failure or a remote rejection (e.g. not-joined)
 */
export function isWorkerBusy(worker) {
	return worker.state.kind === "busy";
}

export function isWorkerReadyForWork(worker) {
	return worker.state.kind === "idle";
}

function busyNames(workers) {
	return workers.filter(isWorkerBusy).map((worker) => worker.name);
}

function unavailableNames(workers) {
	return workers
		.filter((worker) => worker.state.kind === "offline" || worker.state.kind === "error")
		.map((worker) => worker.name);
}

function summaryLine(decision) {
	return `${decision.tag}: ${decision.summary}`;
}

/**
 * Decides the next action for the loop from board + worker states. Returns a
 * decision object; renderDecision turns it into the /auto message.
 */
export function decide({ board, workers }) {
	if (board.todoCount === 0)
		return {
			tag: TAG_ALL_PLANS_DONE,
			exitCode: EXIT_ALL_PLANS_DONE,
			summary: `plans/todo is empty; ${board.doneCount} plans done`,
		};
	if (board.doing.length > 1)
		return {
			tag: TAG_FIX_BOARD,
			exitCode: EXIT_BOARD_ERROR,
			summary: `more than one plan is doing (${board.doing.map((plan) => plan.id).join(", ")}); keep exactly one`,
			planIds: board.doing.map((plan) => plan.id),
		};
	const doingPlan = board.doing[0];
	if (doingPlan) {
		if (workers.length === 0)
			return {
				tag: TAG_NO_WORKERS,
				exitCode: EXIT_NO_WORKERS,
				summary: `plan ${doingPlan.id} is doing but no worker matches the crew configuration`,
				plan: doingPlan,
			};
		const busy = busyNames(workers);
		if (busy.length > 0)
			return {
				tag: TAG_WAIT,
				exitCode: EXIT_WAIT,
				summary: `crew busy on ${doingPlan.id}; waiting for ${busy.join(", ")}`,
				plan: doingPlan,
				busy,
			};
		const unavailable = unavailableNames(workers);
		if (unavailable.length > 0)
			return {
				tag: TAG_WAIT,
				exitCode: EXIT_WAIT,
				summary: `worker${unavailable.length === 1 ? "" : "s"} unavailable for ${doingPlan.id}: ${unavailable.join(", ")}`,
				plan: doingPlan,
				unavailable,
			};
		return {
			tag: TAG_FINALIZE,
			exitCode: EXIT_FINALIZE,
			summary: `crew idle and ${doingPlan.id} is doing; verify and move it to plans/done`,
			plan: doingPlan,
		};
	}
	if (board.ready.length === 0)
		return {
			tag: TAG_BLOCKED,
			exitCode: EXIT_BLOCKED,
			summary: `nothing ready; ${board.blocked.length} plan${board.blocked.length === 1 ? "" : "s"} waiting on unfinished dependencies`,
			blocked: board.blocked,
		};
	if (workers.length === 0)
		return {
			tag: TAG_NO_WORKERS,
			exitCode: EXIT_NO_WORKERS,
			summary: "no worker matches the crew configuration for the next plan",
			plan: board.ready[0],
		};
	const unavailable = unavailableNames(workers);
	if (unavailable.length > 0)
		return {
			tag: TAG_WAIT,
			exitCode: EXIT_WAIT,
			summary: `next plan ${board.ready[0].id} is ready but worker${unavailable.length === 1 ? "" : "s"} unavailable: ${unavailable.join(", ")}`,
			plan: board.ready[0],
			unavailable,
		};
	const busy = busyNames(workers);
	if (busy.length > 0)
		return {
			tag: TAG_WAIT,
			exitCode: EXIT_WAIT,
			summary: `next plan ${board.ready[0].id} is ready; waiting for ${busy.join(", ")} to idle before starting it`,
			plan: board.ready[0],
			busy,
		};
	return {
		tag: TAG_NEXT_PLAN,
		exitCode: EXIT_NEXT_PLAN,
		summary: `work on next plan ${board.ready[0].id}: ${board.ready[0].title || "untitled"}`,
		plan: board.ready[0],
	};
}

function planLine(plan, prefix = "") {
	return `${prefix}${plan.id}${plan.title ? ` - ${plan.title}` : ""}`;
}

/** Renders a decision as the generated message the condition loop sends. */
export function renderDecision(decision, assignment = {}) {
	const lines = [summaryLine(decision)];
	switch (decision.tag) {
		case TAG_ALL_PLANS_DONE:
			lines.push("Stop the loop; every plan is closed.");
			break;
		case TAG_FIX_BOARD:
			lines.push("Fix the board before the crew can continue; do not pick a plan while it is inconsistent.");
			break;
		case TAG_NEXT_PLAN:
			if (assignment.owner) lines.push(`Primary worker: ${assignment.owner.name} (${assignment.owner.role}).`);
			lines.push(
				assignment.owner
					? `Mark it doing, send ${assignment.owner.name} the file path, and coordinate the crew through completion.`
					: "Mark it doing, assign it to the crew, and hand them the file path.",
			);
			lines.push(`plans/todo/${decision.plan.fileName}`);
			break;
		case TAG_FINALIZE:
			if (assignment.reviewer)
				lines.push(`Independent reviewer: ${assignment.reviewer.name} (${assignment.reviewer.role}).`);
			lines.push("Verify the plan against its definition of done (independent QA verdict), then:");
			lines.push(`git mv plans/todo/${decision.plan.fileName} plans/done/`);
			lines.push("commit the code and the board move, then continue the loop.");
			break;
		case TAG_WAIT:
			lines.push("Do not start new work and do not claim progress; re-run after the crew idles.");
			break;
		case TAG_BLOCKED:
			if (decision.blocked.length > 0) {
				lines.push("Blocked plans:");
				for (const plan of decision.blocked) lines.push(planLine(plan, "- "));
			}
			lines.push("Close the blocking plans first; the board never advances out of order.");
			break;
		case TAG_NO_WORKERS:
			lines.push("Check --workers against the roles and names in crew.json.");
			break;
		default:
			break;
	}
	if (decision.plan) lines.push(`File: plans/todo/${decision.plan.fileName}`);
	return lines.join("\n");
}

/** Converts a mechanical decision into pi-auto's typed condition protocol. */
export function toConditionResult(decision, assignment = {}) {
	const reason = String(decision.summary).slice(0, MAX_CONDITION_TEXT_CHARS);
	const base = { version: 1, reason };
	if (decision.tag === TAG_ALL_PLANS_DONE) return { ...base, action: "complete" };
	if (decision.tag === TAG_WAIT) return { ...base, action: "wait" };
	if (decision.tag === TAG_BLOCKED || decision.tag === TAG_NO_WORKERS) return { ...base, action: "blocked" };
	return {
		...base,
		action: "poke",
		message: renderDecision(decision, assignment).slice(0, MAX_CONDITION_TEXT_CHARS),
	};
}
