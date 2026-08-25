#!/usr/bin/env node
/**
 * TASK-0080 docs regression gate (Kelly QA BLOCK re-check).
 *
 * Verifies the public workflow documentation exposes the approved terminal
 * outcome union and never leaks the removed public `Idle without Response`
 * outcome or the contradictory 1-7200 max_wait range.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(join(root, "docs/MEMBER-REQUEST-WORKFLOW.md"), "utf8");
const readme = readFileSync(join(root, "README.md"), "utf8");
const ul = readFileSync(join(root, "UL.md"), "utf8");
const all = `${workflow}\n${readme}\n${ul}`;

const failures = [];

const STALE_OUTCOME = /idle[-\s]?without[-\s]?response/i;
if (STALE_OUTCOME.test(all)) {
	failures.push("stale public 'Idle without Response' outcome still present in docs/README/UL");
}
if (/\b1\s?[–-]\s?7200\b/.test(all)) {
	failures.push("contradictory max_wait range '1-7200' still present; canonical is 60-7200");
}

const TERMINALS = ["Response", "Offline", "Timeout after idle", "Timeout max-wait"];
for (const terminal of TERMINALS) {
	if (!workflow.includes(terminal)) {
		failures.push(`MEMBER-REQUEST-WORKFLOW.md missing terminal outcome '${terminal}'`);
	}
}

for (const required of [
	"Awaiting Response (nonterminal, internal)",
	"post-idle Response grace",
	"max_wait_seconds",
	"strictly greater than",
	"60-7200",
	"already-terminal",
	"reminder",
	"response > offline > grace-expiry > hard-expiry > idle-signal",
]) {
	if (!workflow.includes(required)) {
		failures.push(`MEMBER-REQUEST-WORKFLOW.md missing required phrase '${required}'`);
	}
}

// Kelly QA: `response-after-idle` is ONLY the exact grace/hard timer tie, never
// a Response/idle boundary. Guard both directions.
const TIE_ONLY = "The `response-after-idle` reason applies only";
if (!workflow.includes(TIE_ONLY)) {
	failures.push("response-after-idle must be documented as a timer-tie-only outcome");
}
if (/resolves as `?response-after-idle`?/.test(workflow) || /boundary[^\n]*response-after-idle/.test(workflow)) {
	failures.push("response-after-idle incorrectly paired with a Response/idle boundary");
}

if (failures.length > 0) {
	console.error("Member Request docs contract violations:");
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}
console.log("Member Request docs contract OK");
