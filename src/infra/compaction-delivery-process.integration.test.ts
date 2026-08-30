import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { openTrustedCompactionDeliveryJournal } from "./compaction-delivery-journal.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const child = path.join(projectRoot, "scripts", "compaction-delivery-crash-child.ts");

type ChildResult = { readonly lines: readonly string[]; readonly code: number | null; readonly signal: string | null };

function runChild(mode: string, root: string, killOn?: RegExp): Promise<ChildResult> {
	return new Promise((resolve, reject) => {
		const process = spawn(path.join(projectRoot, "node_modules", ".bin", "tsx"), [child, mode], {
			cwd: projectRoot,
			env: { ...globalThis.process.env, COMPACTION_CRASH_ROOT: root },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const lines: string[] = [];
		let stderr = "";
		let killed = false;
		let buffer = "";
		process.stdout.on("data", (chunk: Buffer) => {
			buffer += chunk.toString();
			for (const line of buffer.split("\n").slice(0, -1)) {
				lines.push(line);
				if (!killed && killOn?.test(line)) {
					killed = true;
					process.kill("SIGKILL");
				}
			}
			buffer = buffer.split("\n").at(-1) ?? "";
		});
		process.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		process.once("error", reject);
		process.once("close", (code, signal) => {
			if (stderr && !killed) reject(new Error(stderr));
			else resolve({ lines, code, signal });
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

function recordsLine(result: ChildResult): string {
	return result.lines.find((line) => line.startsWith("records:")) ?? "";
}

test("real process crash/restart preserves pending work and bounds ambiguous replay", async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "bebop-compaction-crash-"));
	t.after(() => rm(root, { recursive: true, force: true }));

	const beforeAppend = await runChild("crash-before-append", root, /^ready-before-append$/);
	assert.equal(beforeAppend.signal, "SIGKILL");
	assert.deepEqual(await (await journalAt(root)).listPending(), []);

	const afterAppend = await runChild("crash-after-append", root, /^acknowledged-after-append$/);
	assert.equal(afterAppend.signal, "SIGKILL");
	assert.deepEqual(
		(await (await journalAt(root)).listPending()).map((record) => record.state),
		["pending"],
	);

	const recoveredPending = await runChild("recover-pending", root);
	assert.match(recoveredPending.lines.join("\n"), /sent:/);
	assert.match(recordsLine(recoveredPending), /^records:\[\]$/);

	const afterHandoff = await runChild("crash-after-handoff", root, /^ready-after-handoff$/);
	assert.equal(afterHandoff.signal, "SIGKILL");
	assert.equal((await (await journalAt(root)).listPending())[0]?.state, "handing-off");

	const replay = await runChild("recover-replay", root);
	assert.match(replay.lines.find((line) => line.startsWith("sent:")) ?? "", /replayed after ambiguous restart/);
	assert.match(replay.lines.find((line) => line.startsWith("sent:")) ?? "", /delivery-crash-1/);
	assert.match(recordsLine(replay), /"state":"handing-off","replayAttempts":1/);

	const blocked = await runChild("recover-blocked", root);
	assert.doesNotMatch(blocked.lines.join("\n"), /sent:/);
	assert.match(recordsLine(blocked), /"state":"replay-blocked","replayAttempts":1/);
});

test("real process restart reconciles evidence-present handoff without replay", async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "bebop-compaction-evidence-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const afterHandoff = await runChild("crash-after-handoff", root, /^ready-after-handoff$/);
	assert.equal(afterHandoff.signal, "SIGKILL");
	const recovered = await runChild("recover-evidenced", root);
	assert.doesNotMatch(recovered.lines.join("\n"), /sent:/);
	assert.match(recordsLine(recovered), /^records:\[\]$/);
});
