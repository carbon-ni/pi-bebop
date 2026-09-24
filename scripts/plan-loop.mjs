#!/usr/bin/env node

/**
 * /auto loop driver for crew plan execution (pi-bebop).
 *
 * One invocation reads one mechanical snapshot and returns one typed condition
 * action for pi-auto. The script discovers candidate workers from crew.json;
 * TypeSafe selects the worker whose role fits the current plan.
 *
 *   /auto decide 20 ./scripts/plan-loop.mjs
 *
 * Advanced overrides:
 *   node scripts/plan-loop.mjs [--plans-dir plans] [--crew-dir .pi/bebop]
 *       [--workers dev,qa] [--session <id-or-alias>]
 *       [--timeout-ms 3000] [--debug]
 *
 * Truth comes from the board on disk and the public `pi-bebop member status`
 * CLI. Nothing here trusts a model's self-report; a worker counts as idle only
 * when its current mechanical status is online, idle, and has no pending
 * messages.
 * A valid evaluation exits 0 and prints JSON with action poke, wait, complete,
 * or blocked. Usage, IO, and TypeSafe failures exit nonzero; observed member
 * unavailability returns wait so the bounded condition loop can reevaluate.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
	classifyBoard,
	decide,
	EXIT_BLOCKED,
	parsePlanFile,
	TAG_BLOCKED,
	TAG_FINALIZE,
	toConditionResult,
} from "./plan-loop-core.mjs";
import { probeMemberStatus } from "./plan-loop-probe.mjs";
import { selectWorker } from "./plan-loop-typesafe.mjs";

const HELP = `Usage: node scripts/plan-loop.mjs [options]

Options:
  --plans-dir <dir>    board root (default: ./plans; expects todo/ and done/)
  --crew-dir <dir>     crew root containing crew.json (default: .pi/bebop)
  --workers <list>     advanced role/name candidate filter, comma separated
                       (default: every member except the Intake contact)
  --session <id>       joined source Pi session id or alias (default: PI_SESSION_ID)
  --timeout-ms <ms>    per worker CLI probe timeout (default: 3000)
  --debug              print the mechanical snapshot to stderr
  --help               show this help`;

function readFlagValue(argv, flag) {
	const index = argv.indexOf(flag);
	return index === -1 ? undefined : argv[index + 1];
}

function hasFlag(argv, flag) {
	return argv.includes(flag);
}

function parseWorkers(value) {
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

export function parseArgs(argv) {
	if (hasFlag(argv, "--help")) return { help: true };
	const plansDir = readFlagValue(argv, "--plans-dir") ?? "plans";
	const crewDir = readFlagValue(argv, "--crew-dir") ?? ".pi/bebop";
	const workersRaw = readFlagValue(argv, "--workers");
	const session = readFlagValue(argv, "--session");
	const timeoutMs = Number(readFlagValue(argv, "--timeout-ms") ?? "3000");
	if (!Number.isFinite(timeoutMs) || timeoutMs < 100)
		throw new Error(`--timeout-ms must be a number >= 100; got '${readFlagValue(argv, "--timeout-ms")}'`);
	return {
		help: false,
		plansDir,
		crewDir,
		workers: workersRaw === undefined ? undefined : workersRaw === "*" ? null : parseWorkers(workersRaw),
		session,
		timeoutMs,
		debug: hasFlag(argv, "--debug"),
	};
}

async function readPlanFiles(dir) {
	const entries = await fs.promises.readdir(dir);
	const files = entries.filter((entry) => entry.endsWith(".md")).sort();
	const plans = [];
	for (const fileName of files) {
		const content = await fs.promises.readFile(path.join(dir, fileName), "utf8");
		plans.push(parsePlanFile(content, fileName));
	}
	return plans;
}

async function loadCrew(crewDir) {
	const raw = await fs.promises.readFile(path.join(crewDir, "crew.json"), "utf8");
	const manifest = JSON.parse(raw);
	if (!Array.isArray(manifest.members))
		throw new Error(`crew.json at ${path.join(crewDir, "crew.json")} has no members array`);
	return { roster: manifest.members, intakeContact: manifest.intake?.contact };
}

export function selectWorkers(roster, configured, intakeContact) {
	if (configured === null) return roster;
	if (configured === undefined) return roster.filter((member) => member.name !== intakeContact);
	return roster.filter((member) => configured.includes(member.role) || configured.includes(member.name));
}

export function independentReviewerCandidates(candidates, owner) {
	return candidates.filter((candidate) => candidate.name !== owner?.name);
}

export async function probeWorkers(workers, options = {}) {
	const probe = options.probe ?? probeMemberStatus;
	return Promise.all(
		workers.map(async (member) => ({
			name: member.name,
			role: member.role,
			state: await probe(member, {
				session: options.session,
				timeoutMs: options.timeoutMs,
			}),
		})),
	);
}

async function main() {
	let options;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.stderr.write(`${HELP}\n`);
		process.exitCode = 1;
		return;
	}
	if (options.help) {
		process.stdout.write(`${HELP}\n`);
		return;
	}
	try {
		const [todoPlans, donePlans, crew] = await Promise.all([
			readPlanFiles(path.join(options.plansDir, "todo")),
			readPlanFiles(path.join(options.plansDir, "done")),
			loadCrew(options.crewDir),
		]);
		const board = classifyBoard({ todoPlans, donePlans });
		const candidates = selectWorkers(crew.roster, options.workers, crew.intakeContact);
		const activePlan =
			board.doing.length === 1 ? board.doing[0] : board.doing.length === 0 ? board.ready[0] : undefined;
		const assignment = {};
		let states = [];
		if (activePlan && candidates.length > 0) {
			assignment.owner = await selectWorker({ plan: activePlan, candidates, purpose: "implement" });
			states = await probeWorkers([assignment.owner], {
				session: options.session,
				timeoutMs: options.timeoutMs,
			});
		}
		let decision = decide({ board, workers: states });
		if (decision.tag === TAG_FINALIZE) {
			const reviewerCandidates = independentReviewerCandidates(candidates, assignment.owner);
			if (reviewerCandidates.length === 0) {
				decision = {
					tag: TAG_BLOCKED,
					exitCode: EXIT_BLOCKED,
					summary: `plan ${decision.plan.id} has no independent reviewer candidate`,
					blocked: [],
				};
			} else {
				assignment.reviewer = await selectWorker({
					plan: decision.plan,
					candidates: reviewerCandidates,
					purpose: "verify",
				});
				states = [
					...states,
					...(await probeWorkers([assignment.reviewer], {
						session: options.session,
						timeoutMs: options.timeoutMs,
					})),
				];
				decision = decide({ board, workers: states });
			}
		}
		if (options.debug) {
			process.stderr.write(`plans/todo: ${board.todoCount}, plans/done: ${board.doneCount}\n`);
			if (assignment.owner)
				process.stderr.write(`selected owner: ${assignment.owner.name} (${assignment.owner.role})\n`);
			if (assignment.reviewer)
				process.stderr.write(`selected reviewer: ${assignment.reviewer.name} (${assignment.reviewer.role})\n`);
			for (const workerState of states)
				process.stderr.write(`worker ${workerState.name} (${workerState.role}): ${workerState.state.kind}\n`);
		}
		process.stdout.write(`${JSON.stringify(toConditionResult(decision, assignment))}\n`);
		process.exitCode = 0;
	} catch (error) {
		process.stderr.write(`plan-loop: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}
