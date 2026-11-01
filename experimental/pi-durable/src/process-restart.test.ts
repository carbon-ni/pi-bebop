import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { requestMember } from "./client.ts";
import { durableSocketPath, memberRequestId, prepareStoragePath } from "./member.ts";

const script = fileURLToPath(new URL("./main.ts", import.meta.url));

function runCli(args: readonly string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", script, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
		child.once("error", reject);
		child.once("close", (code) => resolve({ code, stdout, stderr }));
	});
}

function launchRecoveryHost(storagePath: string, workspacePath: string, markerPath: string, env: NodeJS.ProcessEnv) {
	const worker = fileURLToPath(new URL("./recovery-host.ts", import.meta.url));
	return spawn(process.execPath, ["--experimental-strip-types", worker, storagePath, workspacePath, markerPath], {
		env,
		stdio: "ignore",
	});
}

async function sendAndDisconnect(storagePath: string, request: unknown): Promise<Socket> {
	const socketPath = await durableSocketPath(storagePath);
	const socket = createConnection(socketPath);
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	socket.write(`${JSON.stringify(request)}\n`);
	return socket;
}

async function eventually<T>(operation: () => Promise<T>, timeoutMs = 3_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try { return await operation(); } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
	}
	throw new Error("condition did not become true before timeout");
}

async function waitForExit(pid: number): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline) {
		try { process.kill(pid, 0); } catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return;
			throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`process ${pid} did not exit`);
}

test("separate host survives clients and recovers the same member after process crash", { timeout: 20_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "bebop-durable-process-"));
	const storageDir = join(directory, "state");
	const workspace = join(directory, "workspace");
	const storagePath = join(storageDir, "designer.sqlite");
	await mkdir(storageDir, { mode: 0o700 });
	await mkdir(workspace);
	await writeFile(join(workspace, "notes.txt"), "safe notes");
	const env = { ...process.env, OPENAI_API_KEY: "test-key-not-used" };
	let activePid: number | undefined;
	const args = ["start", "--db", storagePath, "--member-id", "designer", "--model", "gpt-4.1-mini", "--workspace", workspace];
	try {
		const firstStart = await runCli(args, env);
		assert.equal(firstStart.code, 0, firstStart.stderr);
		const firstStatus = await requestMember(storagePath, { type: "status" });
		assert.equal(firstStatus.memberId, "designer");
		const lockPath = `${await prepareStoragePath(storagePath)}.lock`;
		const lock = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
		activePid = lock.pid;
		process.kill(lock.pid, "SIGKILL");
		await waitForExit(lock.pid);
		activePid = undefined;

		const secondStart = await runCli(args, env);
		assert.equal(secondStart.code, 0, secondStart.stderr);
		const secondStatus = await requestMember(storagePath, { type: "status" });
		assert.equal(secondStatus.conversationId, firstStatus.conversationId);
		const stopped = await requestMember(storagePath, { type: "stop" });
		assert.equal(stopped.status, "stopping");
		activePid = (JSON.parse(await readFile(lockPath, "utf8")) as { pid: number }).pid;
		await waitForExit(activePid);
		activePid = undefined;
	} finally {
		if (activePid !== undefined) {
			try { process.kill(activePid, "SIGKILL"); } catch {}
			await waitForExit(activePid).catch(() => undefined);
		}
		await rm(directory, { recursive: true, force: true });
	}
});

test("an interrupted replay-safe tool resumes its original submission after SIGKILL", { timeout: 20_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "bdp-recovery-"));
	const storageDir = join(directory, "state");
	const workspace = join(directory, "workspace");
	const storagePath = join(storageDir, "designer.sqlite");
	const marker = join(directory, "tool-started");
	await mkdir(storageDir, { mode: 0o700 });
	await mkdir(workspace);
	await writeFile(join(workspace, "notes.txt"), "source notes");
	const baseEnv = { ...process.env };
	const inboxItem = { text: "Read the notes" };
	const payloadHash = createHash("sha256").update(JSON.stringify(inboxItem)).digest("hex");
	let hostPid: number | undefined;
	let firstPid: number | undefined;
	let restartedPid: number | undefined;
	try {
		const first = launchRecoveryHost(storagePath, workspace, marker, { ...baseEnv, BLOCK_MEMBER_READ: "1" });
		firstPid = first.pid ?? undefined;
		await eventually(() => requestMember(storagePath, { type: "status" }));
		const seed = await requestMember(storagePath, {
			type: "admit",
			memberId: "designer",
			message: "Persist this earlier record",
			requestId: memberRequestId("designer", "pre-crash-seed"),
		});
		const seedResult = await requestMember(storagePath, {
			type: "awaitSubmission",
			memberId: "designer",
			submissionId: seed.submissionId as string,
		});
		assert.deepEqual(seedResult.result, { status: "done", answer: "Seeded prior state" });
		const firstAdmission = await requestMember(storagePath, {
			type: "admitInbox",
			memberId: "designer",
			itemId: "crash-window-1",
			message: inboxItem.text,
			payloadHash,
		});
		assert.equal(typeof firstAdmission.submissionId, "string");
		assert.notEqual(firstAdmission.submissionId, seed.submissionId);
		await eventually(() => access(marker));
		const lockPath = `${await prepareStoragePath(storagePath)}.lock`;
		hostPid = (JSON.parse(await readFile(lockPath, "utf8")) as { pid: number }).pid;
		assert.equal(hostPid, first.pid);
		process.kill(hostPid, "SIGKILL");
		await waitForExit(hostPid);
		hostPid = undefined;
		firstPid = undefined;

		const restarted = launchRecoveryHost(storagePath, workspace, marker, baseEnv);
		restartedPid = restarted.pid ?? undefined;
		await eventually(() => requestMember(storagePath, { type: "status" }));
		const retriedAdmission = await requestMember(storagePath, {
			type: "admitInbox",
			memberId: "designer",
			itemId: "crash-window-1",
			message: inboxItem.text,
			payloadHash,
		});
		assert.equal(retriedAdmission.submissionId, firstAdmission.submissionId);
		assert.equal(retriedAdmission.requestId, firstAdmission.requestId);
		const recovered = await requestMember(storagePath, {
			type: "awaitSubmission",
			memberId: "designer",
			submissionId: firstAdmission.submissionId as string,
		});
		assert.deepEqual(recovered.result, { status: "done", answer: "Recovered result" });
		const lock = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
		hostPid = lock.pid;
		await requestMember(storagePath, { type: "stop" });
		await waitForExit(hostPid);
		hostPid = undefined;
		restartedPid = undefined;
	} finally {
		for (const pid of [hostPid, firstPid, restartedPid]) {
			if (pid === undefined) continue;
			try { process.kill(pid, "SIGKILL"); } catch {}
			await waitForExit(pid).catch(() => undefined);
		}
		await rm(directory, { recursive: true, force: true });
	}
});
