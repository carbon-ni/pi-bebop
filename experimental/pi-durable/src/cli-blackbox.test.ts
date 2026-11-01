import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { durableSocketPath } from "./member.ts";
import { requestMember } from "./client.ts";

const mainScript = fileURLToPath(new URL("./main.ts", import.meta.url));

interface CliResult {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
}

function runCli(
	args: readonly string[],
	options: { readonly input?: string; readonly env?: NodeJS.ProcessEnv; readonly timeoutMs?: number } = {},
): Promise<CliResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", mainScript, ...args], {
			env: options.env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, options.timeoutMs ?? 2_000);
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
		child.once("error", reject);
		child.once("close", (code) => {
			clearTimeout(timeout);
			resolve({ code, stdout, stderr, timedOut });
		});
		child.stdin.end(options.input ?? "");
	});
}

async function temporaryStorage(): Promise<{ readonly directory: string; readonly storagePath: string }> {
	const directory = await mkdtemp(join(tmpdir(), "bebop-durable-cli-blackbox-"));
	const storageDirectory = join(directory, "state");
	await mkdir(storageDirectory, { mode: 0o700 });
	return { directory, storagePath: join(storageDirectory, "member.sqlite") };
}

async function stopHost(storagePath: string): Promise<void> {
	const lockPath = `${storagePath}.lock`;
	try {
		await runCli(["stop", "--db", storagePath]);
		const deadline = Date.now() + 3_000;
		while (Date.now() < deadline) {
			try {
				await access(lockPath);
				await new Promise((resolve) => setTimeout(resolve, 10));
			} catch (error) {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
				throw error;
			}
		}
		throw new Error("member host did not release its lock after stop");
	} catch {
		try {
			const lock = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number };
			if (typeof lock.pid === "number") process.kill(lock.pid, "SIGKILL");
		} catch {
			// Host is already stopped or its lock is gone.
		}
	}
}

function withoutApiKey(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.OPENAI_API_KEY;
	return env;
}

test("help works without credentials and unknown CLI inputs fail clearly", async (t) => {
	// Given no model credentials and no host.
	const help = await runCli(["--help"], { env: withoutApiKey() });
	const { directory, storagePath } = await temporaryStorage();
	t.after(() => rm(directory, { recursive: true, force: true }));
	const command = await runCli(["frobnicate"]);
	const option = await runCli(["status", "--db", storagePath, "--typo", "value"]);

	// Then help succeeds while invalid command and flag produce concise errors.
	assert.equal(help.code, 0, help.stderr);
	assert.match(help.stdout, /Commands:/);
	assert.match(help.stdout, /OPENAI_API_KEY required/i);
	assert.equal(command.code, 1);
	assert.match(command.stderr, /Unknown command: frobnicate/);
	assert.doesNotMatch(command.stderr, /\n\s+at /);
	assert.equal(option.code, 1);
	assert.match(option.stderr, /Unknown option: --typo/);
	assert.doesNotMatch(option.stderr, /\n\s+at /);
});

test("start reports missing credentials before creating its database directory", async (t) => {
	// Given a new DB path and no API credentials.
	const directory = await mkdtemp(join(tmpdir(), "bebop-durable-cli-auth-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const result = await runCli([
		"start", "--db", join(directory, "state", "member.sqlite"),
		"--member-id", "designer", "--model", "gpt-4.1-mini",
	], { env: withoutApiKey() });

	// Then the CLI reports the missing key without creating storage or a stack trace.
	assert.equal(result.code, 1);
	assert.match(result.stderr, /OPENAI_API_KEY is required/);
	assert.doesNotMatch(result.stderr, /\n\s+at /);
	await assert.rejects(access(join(directory, "state")));
});

test("unsafe storage configuration returns a user-facing recovery message", async (t) => {
	// Given a DB parent directory with unsafe permissions.
	const directory = await mkdtemp(join(tmpdir(), "bebop-durable-cli-config-"));
	const unsafe = join(directory, "unsafe");
	await mkdir(unsafe, { mode: 0o755 });
	await chmod(unsafe, 0o755);
	t.after(() => rm(directory, { recursive: true, force: true }));

	// When start validates storage.
	const result = await runCli([
		"start", "--db", join(unsafe, "member.sqlite"),
		"--member-id", "designer", "--model", "gpt-4.1-mini",
	], { env: { ...process.env, OPENAI_API_KEY: "test-key-not-used" } });

	// Then the error is actionable and does not expose an implementation stack.
	assert.equal(result.code, 1);
	assert.match(result.stderr, /storage directory must be owned by this user.*0700/);
	assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test("piped send reports a missing host instead of an stdin descriptor error", async (t) => {
	// Given a safe DB path with no listening host.
	const { directory, storagePath } = await temporaryStorage();
	t.after(() => rm(directory, { recursive: true, force: true }));

	// When a bounded message is piped to send.
	const result = await runCli(["send", "--db", storagePath, "--member-id", "designer"], { input: "hello" });

	// Then it reaches the transport boundary and reports the unavailable host.
	assert.equal(result.timedOut, false);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /member host is not available/i);
	assert.doesNotMatch(result.stderr, /path.*argument|received type number/i);
});

test("status times out when the private local endpoint accepts but never responds", async (t) => {
	// Given a local Unix socket that accepts data but provides no response.
	const { directory, storagePath } = await temporaryStorage();
	const socketPath = await durableSocketPath(storagePath);
	const server = createServer((socket) => socket.on("data", () => undefined));
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
	t.after(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await unlink(socketPath).catch(() => undefined);
		await rm(directory, { recursive: true, force: true });
	});

	// When a status client waits for that host.
	const result = await runCli(["status", "--db", storagePath], { timeoutMs: 1_500 });

	// Then the CLI returns a bounded timeout instead of hanging.
	assert.equal(result.timedOut, false, "status hung on an unresponsive host");
	assert.equal(result.code, 1);
	assert.match(result.stderr, /timed out/i);
});

test("status reports the effective configuration of the running member", async (t) => {
	// Given a host started with explicit member configuration.
	const { directory, storagePath } = await temporaryStorage();
	const workspace = join(directory, "workspace");
	const instructionsFile = join(workspace, "instructions.txt");
	await mkdir(workspace);
	await writeFile(instructionsFile, "Review only");
	t.after(async () => {
		await stopHost(storagePath);
		await rm(directory, { recursive: true, force: true });
	});
	const started = await runCli([
		"start", "--db", storagePath, "--member-id", "designer", "--role", "qa",
		"--model", "gpt-4.1-mini", "--workspace", workspace, "--instructions-file", instructionsFile,
	], { env: { ...process.env, OPENAI_API_KEY: "test-key-not-used" } });
	assert.equal(started.code, 0, started.stderr);

	// Then status reports identity and execution configuration without raw instructions.
	const status = await requestMember(storagePath, { type: "status" });
	assert.equal(Number.isInteger(status.pid), true);
	assert.equal(status.memberId, "designer");
	assert.equal(status.role, "qa");
	assert.equal(status.modelId, "gpt-4.1-mini");
	assert.equal(status.workspacePath, await realpath(workspace));
	assert.equal(typeof status.instructionsHash, "string");
	assert.doesNotMatch(JSON.stringify(status), /Review only/);
});

test("start rejects an already-running DB opened with a different configuration", async (t) => {
	// Given one host with a persisted configuration.
	const { directory, storagePath } = await temporaryStorage();
	const firstWorkspace = join(directory, "workspace-one");
	const secondWorkspace = join(directory, "workspace-two");
	const firstInstructions = join(firstWorkspace, "instructions.txt");
	const secondInstructions = join(secondWorkspace, "instructions.txt");
	await mkdir(firstWorkspace);
	await mkdir(secondWorkspace);
	await writeFile(firstInstructions, "Review only");
	await writeFile(secondInstructions, "Implement changes");
	t.after(async () => {
		await stopHost(storagePath);
		await rm(directory, { recursive: true, force: true });
	});
	const env = { ...process.env, OPENAI_API_KEY: "test-key-not-used" };
	const first = await runCli([
		"start", "--db", storagePath, "--member-id", "designer", "--role", "qa",
		"--model", "gpt-4.1-mini", "--workspace", firstWorkspace, "--instructions-file", firstInstructions,
	], { env });
	assert.equal(first.code, 0, first.stderr);

	// When the requested model, workspace, role, and instructions differ.
	const changed = await runCli([
		"start", "--db", storagePath, "--member-id", "designer", "--role", "developer",
		"--model", "gpt-4.1", "--workspace", secondWorkspace, "--instructions-file", secondInstructions,
	], { env });

	// Then the CLI refuses to claim the old live host satisfies the new config.
	assert.equal(changed.code, 1, changed.stdout);
	assert.match(changed.stderr, /configuration.*different|configuration.*mismatch/i);
});
