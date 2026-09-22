#!/usr/bin/env node

/**
 * /auto loop driver for crew plan execution (pi-bebop).
 *
 * One invocation reads one mechanical snapshot and prints the next action for
 * the driving model. Run it repeatedly under /auto until it reports
 * ALL_PLANS_DONE:
 *
 *   node scripts/plan-loop.mjs [--plans-dir plans] [--crew-dir .pi/bebop]
 *       [--workers dev,qa] [--session <id-or-alias>]
 *       [--timeout-ms 3000] [--debug]
 *
 * Truth comes from the board on disk and the public `pi-bebop member status`
 * CLI. Nothing here trusts a model's self-report; a worker counts as idle only
 * when its current mechanical status is online, idle, and has no pending
 * messages.
 *
 * Exit codes:
 *   0 ALL_PLANS_DONE   plans/todo is empty; stop the loop
 *   1 usage / IO error
 *   2 FIX_BOARD        board inconsistent (e.g. two plans doing)
 *   3 NEXT_PLAN        mark the listed plan doing and assign it to the crew
 *   4 WAIT             crew busy or a worker unavailable; re-run later
 *   5 FINALIZE         crew idle; verify the doing plan and move it to done
 *   6 BLOCKED          nothing ready; close blocking plans first
 *   7 NO_WORKERS       --workers matches no crew.json member
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { classifyBoard, decide, parsePlanFile, renderDecision } from "./plan-loop-core.mjs";
import { probeMemberStatus } from "./plan-loop-probe.mjs";

const HELP = `Usage: node scripts/plan-loop.mjs [options]

Options:
  --plans-dir <dir>    board root (default: ./plans; expects todo/ and done/)
  --crew-dir <dir>     crew root containing crew.json (default: .pi/bebop)
  --workers <list>     worker roles/names to watch, comma separated; '*' = all
                       members (default: dev,qa)
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
	const workersRaw = readFlagValue(argv, "--workers") ?? "dev,qa";
	const session = readFlagValue(argv, "--session");
	const timeoutMs = Number(readFlagValue(argv, "--timeout-ms") ?? "3000");
	if (!Number.isFinite(timeoutMs) || timeoutMs < 100)
		throw new Error(`--timeout-ms must be a number >= 100; got '${readFlagValue(argv, "--timeout-ms")}'`);
	return {
		help: false,
		plansDir,
		crewDir,
		workers: workersRaw === "*" ? null : parseWorkers(workersRaw),
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

async function loadRoster(crewDir) {
	const raw = await fs.promises.readFile(path.join(crewDir, "crew.json"), "utf8");
	const manifest = JSON.parse(raw);
	if (!Array.isArray(manifest.members))
		throw new Error(`crew.json at ${path.join(crewDir, "crew.json")} has no members array`);
	return manifest.members;
}

function selectWorkers(roster, configured) {
	if (configured === null) return roster;
	const selected = roster.filter((member) => configured.includes(member.role) || configured.includes(member.name));
	return selected;
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
		const [todoPlans, donePlans, roster] = await Promise.all([
			readPlanFiles(path.join(options.plansDir, "todo")),
			readPlanFiles(path.join(options.plansDir, "done")),
			loadRoster(options.crewDir),
		]);
		const board = classifyBoard({ todoPlans, donePlans });
		const workers = selectWorkers(roster, options.workers);
		const states = await probeWorkers(workers, {
			session: options.session,
			timeoutMs: options.timeoutMs,
		});
		const decision = decide({ board, workers: states });
		if (options.debug) {
			process.stderr.write(`plans/todo: ${board.todoCount}, plans/done: ${board.doneCount}\n`);
			for (const workerState of states)
				process.stderr.write(`worker ${workerState.name} (${workerState.role}): ${workerState.state.kind}\n`);
		}
		process.stdout.write(`${renderDecision(decision)}\n`);
		process.exitCode = decision.exitCode;
	} catch (error) {
		process.stderr.write(`plan-loop: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}
