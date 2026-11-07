import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { requestMember } from "./client.ts";
import { durableSocketPath, memberRequestId, openDurableMember, prepareStoragePath, readWorkspaceFile } from "./member.ts";
import { runMemberServer } from "./server.ts";
import { openDurableInboxRuntime } from "./durable-inbox-runtime.ts";

type Options = ReadonlyMap<string, string>;

function parseOptions(args: readonly string[], allowed: readonly string[]): Options {
	const values = new Map<string, string>();
	for (let index = 0; index < args.length; index += 1) {
		const flag = args[index];
		if (!flag?.startsWith("--")) throw new Error(`Unexpected argument: ${flag ?? ""}`);
		if (!allowed.includes(flag)) throw new Error(`Unknown option: ${flag}`);
		const value = args[index + 1];
		if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
		if (values.has(flag)) throw new Error(`Duplicate option: ${flag}`);
		values.set(flag, value);
		index += 1;
	}
	return values;
}

function required(options: Options, name: string): string {
	const value = options.get(name);
	if (!value) throw new Error(`Missing required ${name}`);
	return value;
}

async function memberOptions(options: Options) {
	const workspacePath = await realpath(options.get("--workspace") ?? process.cwd());
	const instructionsFile = options.get("--instructions-file");
	const instructions = instructionsFile ? await readWorkspaceFile(workspacePath, instructionsFile) : "";
	return {
		storagePath: required(options, "--db"),
		memberId: required(options, "--member-id"),
		modelId: required(options, "--model"),
		providerId: options.get("--provider") ?? "openai",
		workspacePath,
		role: options.get("--role") ?? "member",
		instructions,
		instructionsFile,
		instructionsHash: createHash("sha256").update(instructions).digest("hex"),
	};
}

function hostEnvironment(): NodeJS.ProcessEnv {
	const allowed = [
		"HOME", "PATH", "PI_CODING_AGENT_DIR", "OPENAI_API_KEY", "TMPDIR", "TMP", "TEMP", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY",
		"NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "LANG", "LC_ALL", "TZ",
		"BEBOP_PROJECT_TRUSTED",
	];
	return Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
}

async function startHost(options: Options): Promise<void> {
	const member = await memberOptions(options);
	const { openPiModelRuntime, requirePiModel } = await import("./pi-models.ts");
	const modelRuntime = await openPiModelRuntime();
	await requirePiModel(modelRuntime, member.providerId, member.modelId);
	const projectRootOption = options.get("--trusted-project-root");
	const projectRoot = projectRootOption ? await realpath(projectRootOption) : undefined;
	const manifestPathValue = options.get("--manifest");
	const manifestPath = manifestPathValue ? await realpath(manifestPathValue) : undefined;
	if (Boolean(projectRoot) !== Boolean(manifestPath))
		throw new Error("--trusted-project-root and --manifest must be supplied together");
	if (projectRoot && process.env.BEBOP_PROJECT_TRUSTED !== "1")
		throw new Error("set BEBOP_PROJECT_TRUSTED=1 only after Pi has trusted this project");
	const db = await prepareStoragePath(member.storagePath);
	const socketPath = await durableSocketPath(db);
	try {
		const status = await requestMember(db, { type: "status" });
		if (status.status !== "running") throw new Error("member host is still initializing");
		if (
			status.memberId !== member.memberId ||
			status.providerId !== member.providerId ||
			status.role !== member.role ||
			status.modelId !== member.modelId ||
			status.workspacePath !== member.workspacePath ||
			status.instructionsHash !== member.instructionsHash ||
			status.trustedProjectRoot !== (projectRoot ? path.resolve(projectRoot) : null) ||
			status.inboxManifestPath !== (manifestPath ?? null)
		)
			throw new Error("running host configuration is different from the requested member configuration");
		console.log(`Member ${member.memberId} is already running (${String(status.conversationId)}).`);
		return;
	} catch (error) {
		if (!(error instanceof Error) || !error.message.includes("member host is not available")) throw error;
	}

	const script = fileURLToPath(import.meta.url);
	const child = spawn(
		process.execPath,
		[
			"--experimental-strip-types", script, "serve", "--db", db,
			"--member-id", member.memberId, "--provider", member.providerId, "--model", member.modelId,
			"--workspace", member.workspacePath, "--role", member.role,
			...(member.instructionsFile ? ["--instructions-file", member.instructionsFile] : []),
			...(options.get("--trusted-project-root") ? ["--trusted-project-root", options.get("--trusted-project-root")!] : []),
			...(options.get("--manifest") ? ["--manifest", options.get("--manifest")!] : []),
		],
		{ detached: true, stdio: "ignore", env: hostEnvironment() },
	);
	let exitStatus: { code: number | null; signal: NodeJS.Signals | null } | undefined;
	child.once("exit", (code, signal) => { exitStatus = { code, signal }; });
	child.unref();
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			const status = await requestMember(db, { type: "status" });
			if (status.status !== "running") {
				await delay(50);
				continue;
			}
			if (
				status.memberId !== member.memberId ||
				status.providerId !== member.providerId ||
				status.role !== member.role ||
				status.modelId !== member.modelId ||
				status.workspacePath !== member.workspacePath ||
				status.instructionsHash !== member.instructionsHash ||
				status.trustedProjectRoot !== (projectRoot ? path.resolve(projectRoot) : null) ||
				status.inboxManifestPath !== (manifestPath ?? null)
			)
				throw new Error("running host configuration is different from the requested member configuration");
			console.log(`Member ${member.memberId} is running (${String(status.conversationId)}).`);
			console.log(`Local endpoint: ${socketPath}`);
			return;
		} catch (error) {
			if (exitStatus)
				throw new Error(
					`member host failed to start (exit ${exitStatus.code ?? exitStatus.signal ?? "unknown"}); rerun the same options with 'serve' to see the startup error`,
				);
			if (attempt === 99) throw new Error(`member host did not become ready: ${error instanceof Error ? error.message : error}`);
			await delay(50);
		}
	}
}

async function runServer(options: Options): Promise<void> {
	const memberOptionsValue = await memberOptions(options);
	const { openPiModelRuntime, requirePiModel } = await import("./pi-models.ts");
	const modelRuntime = await openPiModelRuntime();
	await requirePiModel(modelRuntime, memberOptionsValue.providerId, memberOptionsValue.modelId);
	const projectRootOption = options.get("--trusted-project-root");
	const projectRoot = projectRootOption ? await realpath(projectRootOption) : undefined;
	const manifestPathOption = options.get("--manifest");
	const manifestPath = manifestPathOption ? await realpath(manifestPathOption) : undefined;
	if (Boolean(projectRoot) !== Boolean(manifestPath))
		throw new Error("--trusted-project-root and --manifest must be supplied together");
	if (projectRoot && process.env.BEBOP_PROJECT_TRUSTED !== "1")
		throw new Error("set BEBOP_PROJECT_TRUSTED=1 only after Pi has trusted this project");
	const socketPath = await durableSocketPath(memberOptionsValue.storagePath);
	const member = await openDurableMember({
		...memberOptionsValue,
		models: modelRuntime,
		autoResume: false,
		trustedProjectRoot: projectRoot,
		inboxManifestPath: manifestPath,
	});
	let inboxRuntime: Awaited<ReturnType<typeof openDurableInboxRuntime>> | undefined;
	try {
		console.log(`Durable member ${memberOptionsValue.memberId} opened (${member.conversationId}).`);
		await runMemberServer({
			socketPath,
			memberId: memberOptionsValue.memberId,
			providerId: memberOptionsValue.providerId,
			role: memberOptionsValue.role,
			modelId: memberOptionsValue.modelId,
			workspacePath: memberOptionsValue.workspacePath,
			instructionsHash: memberOptionsValue.instructionsHash,
			inboxManifestPath: manifestPath ?? null,
			trustedProjectRoot: projectRoot ?? null,
			conversationId: member.conversationId,
			member,
			shutdownGraceMs: 5_000,
			onListening: async () => {
				if (projectRoot && manifestPath) {
					inboxRuntime = await openDurableInboxRuntime({
						manifestPath,
						projectRoot: await realpath(projectRoot),
						isProjectTrusted: () => process.env.BEBOP_PROJECT_TRUSTED === "1",
						memberId: memberOptionsValue.memberId,
						hostSocketPath: socketPath,
						member,
					});
					await drainAvailableInbox(inboxRuntime);
				}
				member.resume();
			},
			onRequestSettled: async () => {
				if (inboxRuntime) await drainAvailableInbox(inboxRuntime);
			},
			drainInbox: () => inboxRuntime ? drainAvailableInbox(inboxRuntime) : Promise.resolve(0),
			onShutdownTimeout: async () => {
				console.error("member shutdown exceeded 5 seconds; releasing the trusted Inbox endpoint before exit");
				await inboxRuntime?.close();
				process.exit(1);
			},
		});
	} finally {
		try {
			await inboxRuntime?.close();
		} finally {
			await member.close();
		}
	}
}

async function drainAvailableInbox(runtime: Awaited<ReturnType<typeof openDurableInboxRuntime>>): Promise<number> {
	let admitted = 0;
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const result = await runtime.drainOne();
		if (result.status !== "admitted" && result.status !== "already-removed") return admitted;
		if (result.status === "admitted") admitted += 1;
	}
	return admitted;
}

async function readMessageFromStdin(): Promise<string> {
	let message = "";
	for await (const chunk of process.stdin) {
		message += typeof chunk === "string" ? chunk : chunk.toString("utf8");
		if (Buffer.byteLength(message, "utf8") > 8_000) throw new Error("message exceeds the 8000-byte limit");
	}
	return message.trimEnd();
}

async function sendMessage(options: Options): Promise<void> {
	const db = required(options, "--db");
	const message = await readMessageFromStdin();
	if (!message) throw new Error("Provide message text on stdin");
	const memberId = required(options, "--member-id");
	const deliveryId = options.get("--request-id") ?? randomUUID();
	console.error(`Request ID: ${deliveryId}`);
	const result = await requestMember(db, {
		type: "submit",
		memberId,
		message,
		requestId: memberRequestId(memberId, deliveryId),
	});
	const response = result.result as { status?: string; answer?: string; reason?: string } | undefined;
	if (response?.status !== "done") {
		// Provider error bodies can contain secrets. Report only bounded, known outcome metadata.
		const reason = typeof response?.reason === "string"
			? response.reason.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80)
			: "";
		throw new Error(`Submission did not complete: ${response?.status ?? "unknown"}${reason ? ` (${reason})` : ""}. Check provider credentials and model access; retry only with the original Request ID and message.`);
	}
	console.log(response.answer ?? "Submission completed without text.");
}

async function listModels(options: Options): Promise<void> {
	const { listPiModelChoices, openPiModelRuntime } = await import("./pi-models.ts");
	const runtime = await openPiModelRuntime();
	const choices = await listPiModelChoices(runtime, options.get("--provider"));
	if (choices.length === 0) {
		const providerId = options.get("--provider");
		const scope = providerId ? ` for ${providerId}` : "";
		const recovery = providerId ? `Open Pi and run /login ${providerId}` : "Open Pi and run /login";
		throw new Error(`No saved Pi login models found${scope}. ${recovery} to sign in. The existing OPENAI_API_KEY route still supports explicit OpenAI model selection.`);
	}
	for (const choice of choices)
		console.log(`${choice.providerId}/${choice.modelId} (${choice.authType}; ${choice.providerName}: ${choice.modelName})`);
}

function printHelp(): void {
	console.log(`Local persistent Pi Durable member (Node >=22.19; uses Pi's saved login by default)

Commands:
  models [--provider <provider-id>]  # list models for saved Pi logins; no database or model request
  start --db <sqlite-file> --member-id <id> --provider <provider-id> --model <model-id> [--role <role>] [--workspace <dir>] [--instructions-file <path>] [--trusted-project-root <root> --manifest <path>]
  serve --db <sqlite-file> --member-id <id> --provider <provider-id> --model <model-id> [same member and Inbox options]  # foreground diagnostics
  send --db <sqlite-file> --member-id <id> [--request-id <stable-delivery-id>]  # message from stdin
  drain-inbox --db <sqlite-file>
  status --db <sqlite-file>
  stop --db <sqlite-file>

The runtime uses Pi's public ModelRuntime and reads saved credentials from the normal Pi agent directory (including PI_CODING_AGENT_DIR). The models command lists catalog models for saved login metadata without reading token values, opening the Durable database, refreshing OAuth, or sending a model request. Select a provider/model shown by that command. The existing OPENAI_API_KEY environment route remains supported for explicit OpenAI provider/model selection.

The host runs separately over a private local Unix socket. One host owns one database. Inbox drain is explicitly opt-in on start/serve with --trusted-project-root <root> --manifest <trusted-manifest> and BEBOP_PROJECT_TRUSTED=1; the host claims the configured recipient endpoint before resuming Durable work. It drains pending items at startup and after settled submissions; drain-inbox requests an immediate manual drain. The host releases the endpoint on shutdown. If detached start fails, rerun the same options with serve in the foreground for detailed diagnostics.
`);
}

async function main(): Promise<void> {
	const [command, ...args] = process.argv.slice(2);
	if (!command || command === "--help" || command === "-h") return printHelp();
	const allowedOptions: Readonly<Record<string, readonly string[]>> = {
		start: ["--db", "--member-id", "--provider", "--model", "--workspace", "--role", "--instructions-file", "--trusted-project-root", "--manifest"],
		serve: ["--db", "--member-id", "--provider", "--model", "--workspace", "--role", "--instructions-file", "--trusted-project-root", "--manifest"],
		send: ["--db", "--member-id", "--request-id"],
		status: ["--db"],
		stop: ["--db"],
		"drain-inbox": ["--db"],
		models: ["--provider"],
	};
	const allowed = allowedOptions[command];
	if (!allowed) throw new Error(`Unknown command: ${command}`);
	const options = parseOptions(args, allowed);
	if (command === "models") return listModels(options);
	if (command === "start") return startHost(options);
	if (command === "serve") return runServer(options);
	if (command === "send") return sendMessage(options);
	if (command === "status" || command === "stop" || command === "drain-inbox") {
		const result = await requestMember(required(options, "--db"), { type: command === "drain-inbox" ? "drainInbox" : command });
		console.log(JSON.stringify(result, null, 2));
		return;
	}
	throw new Error(`Unknown command: ${command}`);
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
