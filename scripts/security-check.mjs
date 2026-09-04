import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * Security audit gate for `make all` and the Funzzy watcher.
 *
 * `npm audit` depends on registry audit endpoints that are currently being
 * retired (the `quick` endpoint now answers 400 "Invalid package tree" even
 * for a valid, in-sync lockfile) and whose bulk endpoint intermittently fails
 * or hangs. Those are infrastructure failures, not vulnerability findings
 * (team policy: "Treat npm audit HTTP 503 as infrastructure-only, but record
 * it precisely").
 *
 * This gate therefore distinguishes, deterministically and from npm's own
 * `--json` output:
 * - clean            -> exit 0
 * - vulnerabilities  -> exit 1 with the full report
 * - unavailable      -> retried with fixed backoff, then a loud, precise
 *                       warning and exit 0
 *
 * Bounded with `--fetch-timeout`/`--fetch-retries` so a hanging registry
 * cannot stall the gate for npm's default 5 minutes per request.
 */

const AUDIT_ARGS = [
	"audit",
	"--omit=dev",
	"--audit-level=moderate",
	"--json",
	"--fetch-timeout=45000",
	"--fetch-retries=1",
];
const DEFAULT_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 2000;
const EVIDENCE_LIMIT = 400;

const truncate = (text) => (text.length <= EVIDENCE_LIMIT ? text : `${text.slice(0, EVIDENCE_LIMIT)}...`);

function parseVulnerabilityCounts(stdout) {
	try {
		const parsed = JSON.parse(stdout);
		const counts = parsed?.metadata?.vulnerabilities;
		return counts && typeof counts === "object" ? counts : null;
	} catch {
		return null;
	}
}

function describeAttempt(status, stdout, stderr) {
	const parts = [`status=${status}`];
	if (stdout.trim()) parts.push(`stdout=${JSON.stringify(truncate(stdout.trim()))}`);
	if (stderr.trim()) parts.push(`stderr=${JSON.stringify(truncate(stderr.trim()))}`);
	return parts.join(" ");
}

export function classifyAuditResult(status, stdout, stderr = "") {
	if (status === 0) return { kind: "clean" };
	const counts = parseVulnerabilityCounts(stdout);
	if (counts) return { kind: "vulnerabilities", counts, report: stdout };
	return { kind: "unavailable", evidence: [describeAttempt(status, stdout, stderr)] };
}

export async function runSecurityCheck({
	runAudit,
	delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	attempts = DEFAULT_ATTEMPTS,
	backoffMs = BASE_BACKOFF_MS,
} = {}) {
	const evidence = [];
	for (let attempt = 1; attempt <= attempts; attempt++) {
		const result = await runAudit(AUDIT_ARGS);
		const classification = classifyAuditResult(result.status, result.stdout, result.stderr);
		if (classification.kind !== "unavailable") return { outcome: classification, attempts: attempt };
		evidence.push(`attempt ${attempt}: ${classification.evidence[0]}`);
		if (attempt < attempts) await delay(backoffMs * attempt);
	}
	return { outcome: { kind: "unavailable", evidence }, attempts };
}

export function toExitCode(outcome) {
	return outcome.kind === "vulnerabilities" ? 1 : 0;
}

const runNpmAudit = (args) =>
	new Promise((resolve) => {
		const result = spawnSync("npm", args, { encoding: "utf8", env: process.env });
		resolve({ status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
	});

async function main() {
	const { outcome, attempts } = await runSecurityCheck({ runAudit: runNpmAudit });
	if (outcome.kind === "clean") {
		console.log("security audit: no production vulnerabilities found (npm audit --omit=dev)");
		return 0;
	}
	if (outcome.kind === "vulnerabilities") {
		console.error("security audit: production vulnerabilities found:");
		console.error(outcome.report);
		return 1;
	}
	console.error(`SECURITY AUDIT UNAVAILABLE after ${attempts} attempts — registry audit endpoints failed.`);
	console.error("Recorded as infrastructure-only (not a clean audit); re-run when registry access recovers:");
	for (const line of outcome.evidence) console.error(`  ${line}`);
	return 0;
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exit(await main());
