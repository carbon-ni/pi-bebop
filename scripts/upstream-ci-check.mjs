import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Upstream CI watch for the Funzzy watcher.
 *
 * Local checks cannot see whether the published `main` branch is broken. This
 * job asks GitHub for the newest completed CI run on `main` of the upstream
 * repository and, when it failed, publishes ONE message to the local Crew
 * Intake dropbox. Bebop then delivers it to the configured Intake contact
 * through the durable Inbox.
 *
 * Delivery shape is deliberate: the dropbox is the only local transport that
 * needs no live joined Pi session. The member CLI send paths all resolve
 * identity from a joined source session, so an out-of-process watcher cannot
 * use them.
 *
 * Outcomes:
 * - healthy          -> newest completed run on main passed
 * - notified         -> failure published to the Intake dropbox
 * - already-notified -> same run id was published before
 * - unknown          -> GitHub unreachable, or no completed run found
 *
 * Every outcome exits 0. A remote failure is not a local gate failure, and an
 * unreachable API is infrastructure, not a finding.
 */

const REPOSITORY = "carbon-ni/pi-bebop";
const BRANCH = "main";
const RUN_FIELDS = "databaseId,status,conclusion,displayTitle,headSha,url,workflowName,createdAt";
const INTAKE_DIR = path.join(".pi", "bebop", "intake", "new");
const STATE_FILE = path.join(".tmp", "upstream-ci-notified.json");
const NOTIFIED_LIMIT = 50;
const MAX_FILENAME_BYTES = 160;
const MAX_CONTENT_BYTES = 997_952;
const EVIDENCE_LIMIT = 400;

const truncate = (text) => (text.length <= EVIDENCE_LIMIT ? text : `${text.slice(0, EVIDENCE_LIMIT)}...`);

/** Newest completed run wins: an in-progress run has no verdict yet. */
export function selectLatestCompletedRun(runs) {
	return runs.find((run) => run.status === "completed") ?? null;
}

/** Markdown facts only: the message must stay useful with no Bebop context. */
export function renderIntakeMessage(run, now = () => Date.now()) {
	const conclusion = run.conclusion ?? "unknown";
	return [
		`# Upstream CI failure: ${REPOSITORY} ${BRANCH}`,
		"",
		`An automated watcher check found that the ${BRANCH} branch of ${REPOSITORY} is not green.`,
		"",
		`- Workflow: ${run.workflowName ?? "CI"}`,
		`- Conclusion: ${conclusion}`,
		`- Run: ${run.url}`,
		`- Commit: ${run.headSha}`,
		`- Title: ${run.displayTitle}`,
		`- Detected at: ${new Date(now()).toISOString()}`,
		"",
		"Evidence: the GitHub run above. This message reports the failure; it does not",
		"contain the failing job logs and does not assign the fix to anyone.",
		"",
	].join("\n");
}

export async function runUpstreamCiCheck({ listRuns, publish, getNotified, setNotified, now = () => Date.now() } = {}) {
	let runs;
	try {
		runs = await listRuns();
	} catch (error) {
		return { outcome: { kind: "unknown", evidence: truncate(`${error?.message ?? error}`) } };
	}

	const run = selectLatestCompletedRun(runs);
	if (!run) return { outcome: { kind: "unknown", evidence: `no completed ${BRANCH} run found` } };
	if (run.conclusion !== "failure") return { outcome: { kind: "healthy", run } };

	const notified = await getNotified();
	if (notified.includes(run.databaseId)) return { outcome: { kind: "already-notified", run } };

	const publication = await publish({
		filename: `upstream-ci-${BRANCH}-${run.databaseId}.md`,
		content: renderIntakeMessage(run, now),
	});
	await setNotified([...notified, run.databaseId].slice(-NOTIFIED_LIMIT));
	return { outcome: { kind: "notified", run, publication } };
}

export function toExitCode() {
	return 0;
}

/** Publication contract from `.pi/bebop/intake/AGENTS.md`: draft, fsync, atomic rename. */
export async function publishIntakeFile({ dir, filename, content, fs = { access, mkdir, open, rename, unlink } }) {
	if (!content.trim()) throw new Error("refusing to publish an empty Intake message");
	if (Buffer.byteLength(filename, "utf8") > MAX_FILENAME_BYTES)
		throw new Error(`filename exceeds ${MAX_FILENAME_BYTES} bytes`);
	if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES)
		throw new Error(`content exceeds ${MAX_CONTENT_BYTES} bytes`);

	await fs.mkdir(dir, { recursive: true });
	const target = path.join(dir, filename);
	const existing = await fs.access(target).then(
		() => true,
		() => false,
	);
	if (existing) throw new Error(`refusing to overwrite existing Intake file ${target}`);
	const draft = path.join(
		dir,
		`.${createHash("sha256").update(`${filename}${content}`).digest("hex").slice(0, 16)}.draft`,
	);
	const handle = await fs.open(draft, "w");
	try {
		await handle.writeFile(content, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await fs.rename(draft, target);
	} catch (error) {
		await fs.unlink(draft).catch(() => {});
		throw error;
	}
	return { filename, path: target };
}

const listGithubRuns = async () => {
	const result = spawnSync(
		"gh",
		["run", "list", "--repo", REPOSITORY, "--branch", BRANCH, "--limit", "10", "--json", RUN_FIELDS],
		{ encoding: "utf8", env: process.env },
	);
	if (result.error) throw new Error(`gh unavailable: ${result.error.message}`);
	if (result.status !== 0) throw new Error(`gh exited ${result.status}: ${truncate((result.stderr ?? "").trim())}`);
	try {
		return JSON.parse(result.stdout);
	} catch {
		throw new Error(`gh returned unparseable JSON: ${truncate(result.stdout.trim())}`);
	}
};

const readNotified = async () => {
	try {
		const parsed = JSON.parse(await readFile(STATE_FILE, "utf8"));
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
};

const writeNotified = async (ids) => {
	await mkdir(path.dirname(STATE_FILE), { recursive: true });
	await writeFile(STATE_FILE, `${JSON.stringify(ids, null, "\t")}\n`, "utf8");
};

async function main() {
	const { outcome } = await runUpstreamCiCheck({
		listRuns: listGithubRuns,
		publish: (message) => publishIntakeFile({ dir: INTAKE_DIR, ...message }),
		getNotified: readNotified,
		setNotified: writeNotified,
	});

	if (outcome.kind === "healthy") {
		console.log(`upstream CI: ${REPOSITORY} ${BRANCH} is green (run ${outcome.run.databaseId})`);
		return toExitCode(outcome);
	}
	if (outcome.kind === "already-notified") {
		console.log(
			`upstream CI: ${REPOSITORY} ${BRANCH} still failing (run ${outcome.run.databaseId}); crew already notified`,
		);
		return toExitCode(outcome);
	}
	if (outcome.kind === "notified") {
		console.error(`upstream CI: ${REPOSITORY} ${BRANCH} FAILED (run ${outcome.run.databaseId}).`);
		console.error(`Published ${outcome.publication.path} for the Crew Intake contact.`);
		console.error(`Run: ${outcome.run.url}`);
		return toExitCode(outcome);
	}
	console.error(`upstream CI: unknown state - ${outcome.evidence}`);
	console.error("Recorded as infrastructure-only (not a green main); re-run when GitHub access recovers.");
	return toExitCode(outcome);
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exit(await main());
