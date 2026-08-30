import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { openTrustedCompactionDeliveryJournal } from "../infra/compaction-delivery-journal.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const child = path.join(projectRoot, "scripts", "compaction-delivery-pi-crash-child.ts");

function runChild(mode: string, root: string): Promise<{ lines: readonly string[]; signal: string | null }> {
	return new Promise((resolve, reject) => {
		const childProcess = spawn(
			process.execPath,
			[
				"--require",
				path.join(projectRoot, "node_modules", "tsx", "dist", "preflight.cjs"),
				"--import",
				`file://${path.join(projectRoot, "node_modules", "tsx", "dist", "loader.mjs")}`,
				child,
				mode,
			],
			{
				cwd: projectRoot,
				env: { ...process.env, COMPACTION_PI_CRASH_ROOT: root },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		const lines: string[] = [];
		let buffer = "";
		let stderr = "";
		childProcess.stdout.on("data", (chunk: Buffer) => {
			buffer += chunk.toString();
			for (const line of buffer.split("\n").slice(0, -1)) lines.push(line);
			buffer = buffer.split("\n").at(-1) ?? "";
		});
		childProcess.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		childProcess.once("error", reject);
		childProcess.once("close", (_code, signal) => {
			if (stderr && signal !== "SIGKILL") reject(new Error(stderr));
			else resolve({ lines, signal });
		});
	});
}

async function journalAt(root: string) {
	return openTrustedCompactionDeliveryJournal({
		manifestPath: path.join(root, ".pi", "bebop", "crew.json"),
		projectRoot: root,
		isProjectTrusted: () => true,
		memberName: "Dave",
	});
}

test("real Pi host crash at adapter send preserves ambiguous handoff and bounds replay", async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "bebop-pi-crash-window-"));
	t.after(() => rm(root, { recursive: true, force: true }));

	const initialCrash = await runChild("crash-after-pi", root);
	assert.equal(initialCrash.signal, "SIGKILL");
	assert.match(initialCrash.lines.find((line) => line.startsWith("pi-send:")) ?? "", /delivery-1/);
	const firstRecord = (await (await journalAt(root)).listPending())[0];
	assert.equal(firstRecord?.state, "handing-off");
	assert.equal(firstRecord?.replayAttempts, 0);
	const sessionPath = (await fs.readFile(path.join(root, "session-path"), "utf8")).trim();
	assert.doesNotMatch(await fs.readFile(sessionPath, "utf8"), /delivery-1/);

	const replayCrash = await runChild("recover-replay-crash", root);
	assert.equal(replayCrash.signal, "SIGKILL");
	assert.match(replayCrash.lines.find((line) => line.startsWith("pi-send:")) ?? "", /delivery-1/);
	assert.match(
		replayCrash.lines.find((line) => line.startsWith("pi-send:")) ?? "",
		/replayed after ambiguous restart/,
	);
	const reservedRecord = (await (await journalAt(root)).listPending())[0];
	assert.equal(reservedRecord?.state, "handing-off");
	assert.equal(reservedRecord?.replayAttempts, 1);
	assert.doesNotMatch(await fs.readFile(sessionPath, "utf8"), /delivery-1/);

	const blocked = await runChild("recover-blocked", root);
	assert.equal(blocked.signal, null);
	assert.doesNotMatch(blocked.lines.join("\n"), /pi-send:/);
	assert.deepEqual(
		(await (await journalAt(root)).listPending()).map((record) => ({
			state: record.state,
			replayAttempts: record.replayAttempts,
		})),
		[{ state: "replay-blocked", replayAttempts: 1 }],
	);
});
