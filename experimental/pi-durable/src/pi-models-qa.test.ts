import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { listPiModelChoices } from "./pi-models.ts";

const mainScript = fileURLToPath(new URL("./main.ts", import.meta.url));

interface CliResult {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
}

function runCli(args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs = 3_000): Promise<CliResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", mainScript, ...args], {
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
		child.once("error", reject);
		child.once("close", (code) => {
			clearTimeout(timeout);
			resolve({ code, stdout, stderr, timedOut });
		});
	});
}

function assertLoginRecovery(output: string, providerId: string): void {
	assert.match(output, /open Pi and run/i);
	assert.match(output, new RegExp(`/login\\s+${providerId}`));
}

function withoutCredentials(agentDirectory: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agentDirectory };
	delete env.OPENAI_API_KEY;
	delete env.ANTHROPIC_API_KEY;
	return env;
}

async function stopHost(storagePath: string, env: NodeJS.ProcessEnv): Promise<void> {
	const lockPath = `${storagePath}.lock`;
	try {
		const stopped = await runCli(["stop", "--db", storagePath], env);
		if (stopped.code !== 0) throw new Error("member host stop request failed");
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
	} catch {
		try {
			const lock = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number };
			if (typeof lock.pid === "number") process.kill(lock.pid, "SIGKILL");
		} catch {
			// The host was never started or already exited.
		}
	}
}

test("saved OAuth metadata discovers actual Pi provider models offline without reading credential values", async () => {
	let reads = 0;
	const entries: readonly CredentialInfo[] = [{ providerId: "openai-codex", type: "oauth" }];
	const credentials: CredentialStore = {
		read: async () => {
			reads += 1;
			throw new Error("catalog discovery must not read token values");
		},
		list: async () => entries,
		modify: async () => undefined,
		delete: async () => undefined,
	};
	const runtime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	const provider = runtime.getProvider("openai-codex");
	assert.ok(provider?.auth.oauth, "fixture must target a built-in OAuth provider");

	const choices = await listPiModelChoices(runtime, "openai-codex");

	assert.ok(choices.length > 0);
	assert.ok(choices.every((choice) => choice.providerId === "openai-codex" && choice.authType === "oauth"));
	assert.ok(choices.every((choice) => runtime.getModel(choice.providerId, choice.modelId)));
	assert.equal(reads, 0);
});

for (const providerCase of [
	{ provider: "openai", model: "gpt-4.1-mini" },
	{ provider: "anthropic", model: "claude-haiku-4-5" },
]) {
	test(`start refuses ${providerCase.provider} without saved login or provider credentials before creating storage`, async (t) => {
		const directory = await mkdtemp(join(tmpdir(), "bebop-durable-no-login-"));
		const agentDirectory = join(directory, "pi-agent");
		const workspace = join(directory, "workspace");
		const storagePath = join(directory, "state", "member.sqlite");
		await mkdir(agentDirectory);
		await mkdir(workspace);
		const env = withoutCredentials(agentDirectory);
		t.after(async () => {
			await stopHost(storagePath, env);
			await rm(directory, { recursive: true, force: true });
		});

		const result = await runCli([
			"start", "--db", storagePath, "--member-id", "designer",
			"--provider", providerCase.provider, "--model", providerCase.model,
			"--workspace", workspace,
		], env);

		assert.equal(result.timedOut, false);
		assert.equal(result.code, 1, result.stdout);
		assertLoginRecovery(`${result.stdout}\n${result.stderr}`, providerCase.provider);
		assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /\n\s+at /);
		await assert.rejects(access(join(directory, "state")), /ENOENT/);
	});
}

test("does not treat an OpenAI API key as credentials for a selected Anthropic model", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "bebop-durable-provider-auth-"));
	const agentDirectory = join(directory, "pi-agent");
	const workspace = join(directory, "workspace");
	const storagePath = join(directory, "state", "member.sqlite");
	await mkdir(agentDirectory);
	await mkdir(workspace);
	const env = withoutCredentials(agentDirectory);
	const unrelatedKey = "qa-openai-key-must-not-be-used";
	env.OPENAI_API_KEY = unrelatedKey;
	t.after(async () => {
		await stopHost(storagePath, env);
		await rm(directory, { recursive: true, force: true });
	});

	const result = await runCli([
		"start", "--db", storagePath, "--member-id", "designer",
		"--provider", "anthropic", "--model", "claude-haiku-4-5",
		"--workspace", workspace,
	], env);

	assert.equal(result.timedOut, false);
	assert.equal(result.code, 1);
	assertLoginRecovery(`${result.stdout}\n${result.stderr}`, "anthropic");
	assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(unrelatedKey));
	await assert.rejects(access(join(directory, "state")), /ENOENT/);
});

test("models gives exact Pi login recovery when the configured agent directory has no saved credentials", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "bebop-durable-models-no-login-"));
	const env = withoutCredentials(join(directory, "pi-agent"));
	t.after(() => rm(directory, { recursive: true, force: true }));

	const result = await runCli(["models", "--provider", "openai-codex"], env);

	assert.equal(result.timedOut, false);
	assert.equal(result.code, 1);
	assertLoginRecovery(`${result.stdout}\n${result.stderr}`, "openai-codex");
	assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /access|refresh|token/i);
});
