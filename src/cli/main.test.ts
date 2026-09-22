import test from "node:test";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import net from "node:net";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { errorCode, isCliEntrypoint, runCli } from "./main.ts";
import { createRpcServer, closeRpcServer } from "../infra/rpc-server.ts";
import { createSocketState, handleCommand } from "../pi/control-runtime.ts";
import { decode } from "@toon-format/toon";

const execFile = promisify(execFileCallback);
const root = path.resolve(".");

test("package publishes only the canonical bebop executable", async () => {
	const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
	assert.deepEqual(manifest.bin, { bebop: "./dist/cli/main.js" });
	assert.equal(Object.hasOwn(manifest.bin, "pi-bebop"), false);
});

async function withEndpoint(
	handler: (command: Record<string, unknown>, socket: net.Socket, messages: Record<string, unknown>[]) => void,
	run: (socketPath: string, messages: Record<string, unknown>[]) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(path.join(tmpdir(), "bebop-cli-endpoint-"));
	const socketPath = path.join(dir, "member.sock");
	const messages: Record<string, unknown>[] = [];
	const server = net.createServer((socket) => {
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk;
			let index = buffer.indexOf("\n");
			while (index !== -1) {
				const line = buffer.slice(0, index).trim();
				buffer = buffer.slice(index + 1);
				index = buffer.indexOf("\n");
				if (line) {
					const command = JSON.parse(line) as Record<string, unknown>;
					messages.push(command);
					handler(command, socket, messages);
				}
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	try {
		await run(socketPath, messages);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(dir, { recursive: true, force: true });
	}
}

test("CLI entrypoint detection canonically matches the invoked executable to the packaged module", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "bebop-entrypoint-"));
	try {
		const distDir = path.join(dir, "dist", "cli");
		await mkdir(distDir, { recursive: true });
		const main = path.join(distDir, "main.js");
		await writeFile(main, "// fixture\n");
		const other = path.join(distDir, "other.js");
		await writeFile(other, "// fixture\n");
		const mainUrl = pathToFileURL(main).href;

		// Direct packaged invocation: the invoked path is the packaged module.
		assert.equal(isCliEntrypoint(main, mainUrl), true);

		// npm bin shim: node preserves the invoked symlink path in argv[1], so the
		// guard must canonicalize it before comparing (TASK-0074 regression).
		const binDir = path.join(dir, "node_modules", ".bin");
		await mkdir(binDir, { recursive: true });
		const bin = path.join(binDir, "bebop");
		await symlink(main, bin);
		assert.equal(isCliEntrypoint(bin, mainUrl), true);

		// A symlink resolving to a different module must not pass.
		const otherBin = path.join(binDir, "other");
		await symlink(other, otherBin);
		assert.equal(isCliEntrypoint(otherBin, mainUrl), false);

		// Module mismatch at the packaged path.
		assert.equal(isCliEntrypoint(other, mainUrl), false);
		assert.equal(isCliEntrypoint(main, pathToFileURL(other).href), false);

		// Missing/empty/unknown argv1 are safe.
		assert.equal(isCliEntrypoint(undefined, mainUrl), false);
		assert.equal(isCliEntrypoint("", mainUrl), false);
		assert.equal(isCliEntrypoint(path.join(dir, "missing.js"), mainUrl), false);

		// Non-file module URLs are safe.
		assert.equal(isCliEntrypoint(main, "http://example.invalid/main.js"), false);

		// Importing the source module directly never starts the CLI: canonical
		// equality alone is not enough — the module must be the packaged main,
		// so no basename-only or equality-only check can run imported modules.
		const srcDir = path.join(dir, "src", "cli");
		await mkdir(srcDir, { recursive: true });
		const srcMain = path.join(srcDir, "main.ts");
		await writeFile(srcMain, "// fixture\n");
		assert.equal(isCliEntrypoint(srcMain, pathToFileURL(srcMain).href), false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("installed node_modules/.bin bebop executes the packed CLI (TASK-0074 regression)", async () => {
	const archiveDir = await mkdtemp(path.join(tmpdir(), "bebop-bin-archive-"));
	const prefix = await mkdtemp(path.join(tmpdir(), "bebop-bin-prefix-"));
	try {
		const packed = await execFile("npm", ["pack", "--pack-destination", archiveDir], { cwd: root });
		const archive = packed.stdout
			.trim()
			.split("\n")
			.find((line) => line.endsWith(".tgz"))!;
		const packageRoot = path.join(prefix, "node_modules", "bebop");
		await mkdir(packageRoot, { recursive: true });
		await execFile("tar", ["-xzf", path.join(archiveDir, archive), "-C", packageRoot, "--strip-components=1"]);

		// Mirror npm's install layout: the .bin entry is a symlink to the packed main.
		const binDir = path.join(prefix, "node_modules", ".bin");
		await mkdir(binDir, { recursive: true });
		const bin = path.join(binDir, "bebop");
		await symlink(path.join("..", "bebop", "dist", "cli", "main.js"), bin);
		const environment = { ...process.env, NODE_PATH: "" };

		// No-argument invocation through the real bin path: Commander root help, exit 0.
		const child = spawn(process.execPath, [bin], {
			cwd: prefix,
			env: environment,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let homeOut = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			homeOut += chunk;
		});
		const homeCode = await new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
		assert.equal(homeCode, 0, homeOut);
		assert.match(homeOut, /^Usage: bebop/);
		assert.match(homeOut, /Commands:/);

		// Real commands through the bin symlink match direct artifact semantics exactly.
		const artifact = path.join(packageRoot, "dist/cli/main.js");
		for (const args of [["crew", "init", "--help"], ["member", "status", "--help"], ["--help"]]) {
			const viaBin = await execFile(process.execPath, [bin, ...args], { cwd: prefix, env: environment });
			const viaArtifact = await execFile(process.execPath, [artifact, ...args], {
				cwd: prefix,
				env: environment,
			});
			assert.equal(viaBin.status ?? 0, viaArtifact.status ?? 0, args.join(" "));
			assert.equal(viaBin.stdout, viaArtifact.stdout, args.join(" "));
			assert.equal(viaBin.stderr, viaArtifact.stderr, args.join(" "));
		}
	} finally {
		await rm(archiveDir, { recursive: true, force: true });
		await rm(prefix, { recursive: true, force: true });
	}
});

test("root --help and -h return Commander-owned help with exit 0 and no IO", async () => {
	async function capture(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
		const output = new PassThrough();
		const err = new PassThrough();
		let text = "";
		let errText = "";
		output.setEncoding("utf8");
		err.setEncoding("utf8");
		output.on("data", (chunk) => {
			text += chunk;
		});
		err.on("data", (chunk) => {
			errText += chunk;
		});
		const code = await runCli(args, process.cwd(), process.stdin, output, err);
		return { code, stdout: text, stderr: errText };
	}
	for (const flag of ["--help", "-h"]) {
		const first = await capture([flag]);
		const second = await capture([flag]);
		assert.equal(first.code, 0, flag);
		assert.equal(first.stdout, second.stdout, flag);
		assert.equal(first.stderr, "", flag);
		assert.match(first.stdout, /^Usage: bebop/);
		assert.match(first.stdout, /Commands:/);
	}
	// Root help performs no filesystem/project/session IO: a deleted cwd is fine.
	const nowhere = await mkdtemp(path.join(tmpdir(), "bebop-root-help-"));
	await rm(nowhere, { recursive: true, force: true });
	const nowhereRun = await capture(["--help"]);
	assert.equal(nowhereRun.code, 0);
	assert.match(nowhereRun.stdout, /^Usage: bebop/);
	// No arguments render the same root help and exit 0.
	const noArgs = await capture([]);
	assert.equal(noArgs.code, 0);
	assert.match(noArgs.stdout, /^Usage: bebop/);
});

test("unknown root options are usage failures: plain stderr, exit 2, empty stdout", async () => {
	for (const args of [["-x"], ["--nope"]]) {
		const output = new PassThrough();
		const err = new PassThrough();
		let text = "";
		let errText = "";
		output.setEncoding("utf8");
		err.setEncoding("utf8");
		output.on("data", (chunk) => {
			text += chunk;
		});
		err.on("data", (chunk) => {
			errText += chunk;
		});
		const code = await runCli(args, process.cwd(), process.stdin, output, err);
		assert.equal(code, 2, args.join(" "));
		assert.match(errText, /error: (unknown|invalid) option/, args.join(" "));
		assert.equal(text, "", args.join(" "));
	}
});

test("leaf -h is standard help and never reaches a handler", async () => {
	const leaves: string[][] = [
		["ask"],
		["crew", "init"],
		["member", "status"],
		["member", "wait-idle"],
		["session", "list"],
		["member", "follow-up"],
		["member", "redirect"],
		["member", "interrupt"],
		["member", "inbox", "send"],
		["crew", "broadcast"],
	];
	for (const leaf of leaves) {
		const output = new PassThrough();
		let text = "";
		output.setEncoding("utf8");
		output.on("data", (chunk) => {
			text += chunk;
		});
		const code = await runCli([...leaf, "-h"], process.cwd(), process.stdin, output);
		assert.equal(code, 0, leaf.join(" "));
		assert.match(text, /Usage:|Options:/, leaf.join(" "));
	}
});

test("packaged artifact exposes the member status, session live, and crew roles leaves deterministically", async () => {
	const artifact = path.resolve("dist/cli/main.js");

	// IO-free usage path: unsafe --session value is usage-class — stderr, exit 2, empty stdout.
	const unsafe = spawn(process.execPath, [artifact, "member", "status", "Kelly", "--session", "../x"], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	let unsafeErr = "";
	unsafe.stderr.setEncoding("utf8");
	unsafe.stderr.on("data", (chunk) => {
		unsafeErr += chunk;
	});
	let unsafeOut = "";
	unsafe.stdout.setEncoding("utf8");
	unsafe.stdout.on("data", (chunk) => {
		unsafeOut += chunk;
	});
	const unsafeCode = await new Promise<number>((resolve) => unsafe.once("exit", (value) => resolve(value ?? 1)));
	assert.equal(unsafeCode, 2);
	assert.equal(unsafeOut, "");
	assert.match(unsafeErr, /Invalid --session/);

	// Help paths are deterministic and exit 0.
	for (const args of [
		["ask", "--help"],
		["member", "status", "--help"],
		["session", "live", "--help"],
		["crew", "roles", "--help"],
	]) {
		const child = spawn(process.execPath, [artifact, ...args], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		const code = await new Promise<number>((resolve) => child.once("exit", (value) => resolve(value ?? 1)));
		assert.equal(code, 0, args.join(" "));
		assert.match(stdout, /bebop ask|bebop member status|bebop session live|bebop crew roles/);
	}
});

test("packaged crew roles reads a real scaffolded manifest and exits 0 without mutation", async () => {
	const artifact = path.resolve("dist/cli/main.js");
	const dir = await mkdtemp(path.join(tmpdir(), "bebop-cli-roles-"));
	try {
		// Scaffold a canonical manifest, then discover roles through the packaged CLI.
		const scaffold = await new Promise<{ code: number; stdout: string }>((resolve) => {
			const child = spawn(process.execPath, [artifact, "crew", "init", "--project", dir, "--format", "json"], {
				cwd: dir,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk) => {
				stdout += chunk;
			});
			child.once("exit", (code) => resolve({ code: code ?? 1, stdout }));
		});
		assert.equal(scaffold.code, 0, scaffold.stdout);

		const run = (args: string[]): Promise<{ code: number; stdout: string }> =>
			new Promise((resolve) => {
				const child = spawn(process.execPath, [artifact, ...args], {
					cwd: dir,
					stdio: ["ignore", "pipe", "pipe"],
				});
				let stdout = "";
				child.stdout.setEncoding("utf8");
				child.stdout.on("data", (chunk) => {
					stdout += chunk;
				});
				child.once("exit", (code) => resolve({ code: code ?? 1, stdout }));
			});

		const listed = await run(["crew", "roles", "--format", "json"]);
		assert.equal(listed.code, 0, listed.stdout);
		const parsed = JSON.parse(listed.stdout) as {
			ok: boolean;
			status: string;
			data: { roles: string[]; roleCount: number; memberCount: number };
		};
		assert.equal(parsed.ok, true);
		assert.equal(parsed.status, "listed");
		assert.deepEqual(parsed.data.roles, ["lead", "product", "developer", "quality"]);
		assert.equal(parsed.data.roleCount, 4);
		assert.equal(parsed.data.memberCount, 4);

		// Text is the concise default and remains available explicitly.
		const text = await run(["crew", "roles"]);
		assert.equal(text.code, 0, text.stdout);
		assert.match(text.stdout, /4 configured roles: lead, product, developer, quality/);
		const explicitText = await run(["crew", "roles", "--format", "text"]);
		assert.equal(explicitText.code, 0, explicitText.stdout);
		assert.equal(explicitText.stdout, text.stdout);

		// Manifest is byte-identical after discovery (no mutation).
		const manifestPath = path.join(dir, ".pi/bebop/crew.json");
		assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).version, 2);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("packaged crew roles fails explicitly on missing and ambiguous manifests", async () => {
	const artifact = path.resolve("dist/cli/main.js");
	const emptyDir = await mkdtemp(path.join(tmpdir(), "bebop-cli-roles-empty-"));
	const ambiguousDir = await mkdtemp(path.join(tmpdir(), "bebop-cli-roles-both-"));
	try {
		const run = (cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
			new Promise((resolve) => {
				const child = spawn(process.execPath, [artifact, ...args], {
					cwd,
					stdio: ["ignore", "pipe", "pipe"],
				});
				let stdout = "";
				let stderr = "";
				child.stdout.setEncoding("utf8");
				child.stdout.on("data", (chunk) => {
					stdout += chunk;
				});
				child.stderr.setEncoding("utf8");
				child.stderr.on("data", (chunk) => {
					stderr += chunk;
				});
				child.once("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
			});

		const missing = await run(emptyDir, ["crew", "roles", "--format", "json"]);
		assert.equal(missing.code, 1);
		assert.equal(missing.stdout, "");
		assert.match(missing.stderr, /missing-manifest|no supported crew manifest/);

		// Both supported layouts present -> ambiguous dual-layout failure.
		const scaffold = {
			version: 1,
			members: [{ name: "Tony", role: "lead", socket: "sockets/lead.sock" }],
			presence: { notifications: true },
		};
		await mkdir(path.join(ambiguousDir, ".pi/bebop/sockets"), { recursive: true });
		await mkdir(path.join(ambiguousDir, ".pi/crew/sockets"), { recursive: true });
		await writeFile(path.join(ambiguousDir, ".pi/bebop/crew.json"), JSON.stringify(scaffold));
		await writeFile(path.join(ambiguousDir, ".pi/crew/crew.json"), JSON.stringify(scaffold));
		const both = await run(ambiguousDir, ["crew", "roles", "--format", "json"]);
		assert.equal(both.code, 1);
		assert.equal(both.stdout, "");
		assert.match(both.stderr, /ambiguous-manifest|both supported crew manifests/);
	} finally {
		await rm(emptyDir, { recursive: true, force: true });
		await rm(ambiguousDir, { recursive: true, force: true });
	}
});

/**
 * Packaged proof (TASK-0061): the built dist CLI, a joined source session, and
 * a configured target member through real temporary Unix control sockets —
 * no mocked CLI handler, dispatcher, renderer, or RPC codec, and no manual
 * command handling. Both sessions run the real production dispatcher
 * (`createSocketState` + `handleCommand` through the RPC server), exactly as
 * `startControlServer` wires them. Online and offline semantic results are
 * asserted end to end.
 */
async function packagedMemberStatusQuery(options: {
	envHome: string;
	sessionId: string;
	target: string;
	format?: string;
}): Promise<{ code: number; stdout: string }> {
	const artifact = path.resolve("dist/cli/main.js");
	const args = [
		artifact,
		"member",
		"status",
		options.target,
		"--session",
		options.sessionId,
		...(options.format === undefined ? [] : ["--format", options.format]),
	];
	const child = spawn(process.execPath, args, {
		env: { ...process.env, HOME: options.envHome },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	const code = await new Promise<number>((resolve) => child.once("exit", (value) => resolve(value ?? 1)));
	return { code, stdout };
}

function joinedRuntimeState(socketPath: string, roster: Array<{ name: string; role: string; socketPath: string }>) {
	const state = createSocketState();
	state.membershipRuntime = {
		getMembership: () => ({
			manifestPath: "/project/.pi/bebop/crew.json",
			socketPath,
			member: roster.find((member) => member.socketPath === socketPath) ?? roster[0]!,
			manifest: { members: roster },
		}),
	} as never;
	state.context = {
		hasUI: false,
		sessionManager: {
			getSessionId: () => "session",
			getSessionName: () => null,
			getEntries: () => entries,
		},
		isIdle: () => false,
		hasPendingMessages: () => true,
		isProjectTrusted: () => true,
	} as never;
	const entries: unknown[] = [];
	return { state, entries };
}

test("packaged CLI proves a real end-to-end status query with online then offline target", async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), "bebop-packaged-"));
	const controlDir = path.join(root, ".pi", "bebop");
	await mkdir(controlDir, { recursive: true });
	const sourceSocket = path.join(controlDir, "source-session-1.sock");
	const targetSocket = path.join(controlDir, "target.sock");

	// Target session: real dispatcher, joined runtime.
	const target = joinedRuntimeState(targetSocket, [{ name: "Kelly", role: "qa", socketPath: targetSocket }]);
	const targetServer = await createRpcServer(targetSocket, (command, socket) =>
		handleCommand({} as never, target.state, command, socket),
	);

	// Source session: real dispatcher + joined runtime; the delegated handler
	// derives membership/trust from this runtime and probes/queries the target.
	const source = joinedRuntimeState(sourceSocket, [
		{ name: "Tony", role: "lead", socketPath: sourceSocket },
		{ name: "Kelly", role: "qa", socketPath: targetSocket },
	]);
	const sourceServer = await createRpcServer(sourceSocket, (command, socket) =>
		handleCommand({} as never, source.state, command, socket),
	);
	t.after(async () => {
		await closeRpcServer(sourceServer);
		await closeRpcServer(targetServer);
		await rm(root, { recursive: true, force: true });
	});

	// Online: the target answers through its own real dispatcher; exit 0.
	const online = await packagedMemberStatusQuery({
		envHome: root,
		sessionId: "source-session-1",
		target: "Kelly",
		format: "json",
	});
	assert.equal(online.code, 0, online.stdout);
	const onlineDecoded = JSON.parse(online.stdout);
	assert.equal(onlineDecoded.status, "observed");
	assert.equal(onlineDecoded.data.status.presence, "online");
	assert.equal(onlineDecoded.data.status.member.name, "Kelly");
	assert.match(onlineDecoded.data.status.observedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

	// Offline: the target stops; the source's probe terminates and records its
	// own observation time; still a successful exit 0 result.
	await closeRpcServer(targetServer);
	const offline = await packagedMemberStatusQuery({
		envHome: root,
		sessionId: "source-session-1",
		target: "Kelly",
		format: "json",
	});
	assert.equal(offline.code, 0, offline.stdout);
	const offlineDecoded = JSON.parse(offline.stdout);
	assert.equal(offlineDecoded.status, "observed");
	assert.equal(offlineDecoded.data.status.presence, "offline");
	assert.equal(offlineDecoded.data.status.activity, "unavailable");
});

test("packs and executes the bundled CLI locally without registry access", async () => {
	const archiveDir = await mkdtemp(path.join(tmpdir(), "bebop-pack-"));
	const extract = await mkdtemp(path.join(tmpdir(), "bebop-extracted-"));
	try {
		const packed = await execFile("npm", ["pack", "--pack-destination", archiveDir], { cwd: root });
		const archive = packed.stdout
			.trim()
			.split("\n")
			.find((line) => line.endsWith(".tgz"))!;
		await execFile("tar", ["-xzf", path.join(archiveDir, archive), "-C", extract, "--strip-components=1"]);
		const packageJson = JSON.parse(await readFile(path.join(extract, "package.json"))) as { main?: string };
		assert.equal(packageJson.main, "./dist/extension.js");
		assert.equal((await readFile(path.join(extract, "dist/extension.js"))).includes("send_follow_up"), true);
		let cliError: { code?: number; stdout?: string; stderr?: string } | undefined;
		try {
			await execFile(
				process.execPath,
				[path.join(extract, "dist/cli/main.js"), "send", "--socket", "/x", "--message", "x"],
				{ cwd: extract, env: { ...process.env, NODE_PATH: "" } },
			);
		} catch (error) {
			cliError = error as { code?: number; stdout?: string; stderr?: string };
		}
		assert.equal(cliError?.code, 2);
		assert.match(cliError?.stderr ?? "", /unknown command 'send'/);
	} finally {
		await rm(archiveDir, { recursive: true, force: true });
		await rm(extract, { recursive: true, force: true });
	}
});

test("packaged CLI proves all leaf help and member idle-wait idle/timeout/SIGINT paths", async (t) => {
	const archiveDir = await mkdtemp(path.join(tmpdir(), "bebop-pack-idle-archive-"));
	const extract = await mkdtemp(path.join(tmpdir(), "bebop-pack-idle-extract-"));
	const home = await mkdtemp(path.join(tmpdir(), "bebop-pack-idle-home-"));
	try {
		const packed = await execFile("npm", ["pack", "--pack-destination", archiveDir], { cwd: root });
		const archive = packed.stdout
			.trim()
			.split("\n")
			.find((line) => line.endsWith(".tgz"))!;
		await execFile("tar", ["-xzf", path.join(archiveDir, archive), "-C", extract, "--strip-components=1"]);
		const artifact = path.join(extract, "dist/cli/main.js");
		const helpLeaves = [
			["crew", "init"],
			["member", "status"],
			["member", "follow-up"],
			["member", "redirect"],
			["member", "inbox", "send"],
			["member", "interrupt"],
			["member", "wait-idle"],
			["crew", "broadcast"],
			["session", "list"],
		];
		for (const leaf of helpLeaves) {
			const result = await execFile(process.execPath, [artifact, ...leaf, "--help"], {
				cwd: extract,
				env: { ...process.env, HOME: home, NODE_PATH: "" },
			});
			assert.match(result.stdout, /Options:|Usage:|bebop/);
		}

		const socketDir = path.join(home, ".pi", "bebop");
		await mkdir(socketDir, { recursive: true });
		const socketPath = path.join(socketDir, "packaged-idle.sock");
		const respond = async (mode: "idle" | "timeout") => {
			const server = net.createServer((socket) => {
				socket.setEncoding("utf8");
				let buffer = "";
				socket.on("data", (chunk) => {
					buffer += chunk;
					const index = buffer.indexOf("\n");
					if (index < 0) return;
					const request = JSON.parse(buffer.slice(0, index)) as { id: string | number };
					const subscriptionId = String(request.id);
					socket.write(
						JSON.stringify({
							jsonrpc: "2.0",
							id: request.id,
							result: { subscriptionId, event: "member_idle" },
						}) + "\n",
					);
					if (mode === "idle") {
						socket.write(
							JSON.stringify({
								jsonrpc: "2.0",
								method: "member.idle_wait",
								params: {
									subscriptionId,
									result: {
										member: { name: "Bob", role: "developer" },
										outcome: "idle",
										disposition: "already-idle",
										observedAt: "2026-08-24T12:00:00.000Z",
									},
								},
							}) + "\n",
						);
					}
				});
			});
			await new Promise<void>((resolve) => server.listen(socketPath, resolve));
			return server;
		};
		const runWait = async (format: "toon" | "json" | "text", timeout = "1s") =>
			new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
				const child = spawn(
					process.execPath,
					[artifact, "member", "wait-idle", "Bob", "--timeout", timeout, "--format", format],
					{
						env: { ...process.env, HOME: home, PI_SESSION_ID: "packaged-idle", NODE_PATH: "" },
						cwd: extract,
						stdio: ["ignore", "pipe", "pipe"],
					},
				);
				let stdout = "";
				let stderr = "";
				child.stdout.setEncoding("utf8");
				child.stdout.on("data", (chunk) => (stdout += chunk));
				child.stderr.setEncoding("utf8");
				child.stderr.on("data", (chunk) => (stderr += chunk));
				child.once("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
			});

		const idleServers: net.Server[] = [];
		const idleByteCounts: Record<string, number> = {};
		for (const format of ["json", "toon", "text"] as const) {
			const server = await respond("idle");
			idleServers.push(server);
			const result = await runWait(format);
			assert.equal(result.code, 0, result.stdout);
			idleByteCounts[format] = Buffer.byteLength(result.stdout, "utf8");
			if (format === "json") assert.equal(JSON.parse(result.stdout).data.result.outcome, "idle");
			if (format === "toon") assert.equal((decode(result.stdout) as any).data.result.outcome, "idle");
			if (format === "text") assert.match(result.stdout, /idle/);
			await closeRpcServer(server);
		}
		assert.deepEqual(idleByteCounts, { json: 345, text: 68, toon: 343 });
		const timeoutServer = await respond("timeout");
		const timeoutResult = await runWait("json", "1s");
		assert.equal(timeoutResult.code, 1);
		assert.equal(timeoutResult.stdout, "");
		assert.match(timeoutResult.stderr, /timeout/);
		await closeRpcServer(timeoutServer);

		const signalServer = await respond("timeout");
		const child = spawn(process.execPath, [artifact, "member", "wait-idle", "Bob", "--timeout", "10m"], {
			env: { ...process.env, HOME: home, PI_SESSION_ID: "packaged-idle", NODE_PATH: "" },
			cwd: extract,
			stdio: ["ignore", "pipe", "ignore"],
		});
		setTimeout(() => child.kill("SIGINT"), 100);
		const signalCode = await new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
		assert.notEqual(signalCode, 0);
		await closeRpcServer(signalServer);
		t.after(async () => {
			for (const server of idleServers) await closeRpcServer(server).catch(() => undefined);
		});
	} finally {
		await rm(archiveDir, { recursive: true, force: true });
		await rm(extract, { recursive: true, force: true });
		await rm(home, { recursive: true, force: true });
	}
});

test("unknown command exits 2 with local usage before any IO", async () => {
	const output = new PassThrough();
	const err = new PassThrough();
	let text = "";
	let errText = "";
	output.setEncoding("utf8");
	err.setEncoding("utf8");
	output.on("data", (chunk) => {
		text += chunk;
	});
	err.on("data", (chunk) => {
		errText += chunk;
	});
	const code = await runCli(["frobnicate"], process.cwd(), process.stdin, output, err);
	assert.equal(code, 2);
	assert.equal(text, "");
	assert.match(errText, /error: unknown command 'frobnicate'/);
	assert.match(errText, /Usage: bebop/);
	// No full flattened leaf vocabulary dump.
	assert.equal(errText.includes("member request respond"), false);
});

test("crew init creates a fresh canonical scaffold in a temp project with created status", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "bebop-cli-init-"));
	try {
		const output = new PassThrough();
		let text = "";
		output.setEncoding("utf8");
		output.on("data", (chunk) => {
			text += chunk;
		});
		const code = await runCli(["crew", "init", "--project", dir, "--format", "json"], dir, process.stdin, output);
		assert.equal(code, 0);
		const parsed = JSON.parse(text);
		assert.equal(parsed.status, "created");
		assert.equal(parsed.data.manifestPath, ".pi/bebop/crew.json");
		assert.ok(parsed.data.createdPaths.includes(".pi/bebop/crew.json"));
		// Real files exist and manifest parses.
		const manifest = JSON.parse(await readFile(path.join(dir, ".pi/bebop/crew.json"), "utf8"));
		assert.equal(manifest.version, 2);
		assert.equal(manifest.commonInstructionsFile, "instructions/common.md");
		assert.equal(manifest.intake.contact, "product");
		assert.equal((await readFile(path.join(dir, ".pi/bebop/instructions/lead.md"), "utf8")) !== "", true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("crew init exact rerun is unchanged with zero writes and preserved mtimes", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "bebop-cli-init-"));
	try {
		const run = async () => {
			const output = new PassThrough();
			let text = "";
			output.setEncoding("utf8");
			output.on("data", (chunk) => {
				text += chunk;
			});
			const code = await runCli(
				["crew", "init", "--project", dir, "--format", "json"],
				dir,
				process.stdin,
				output,
			);
			return { code, text };
		};
		await run();
		const manifestPath = path.join(dir, ".pi/bebop/crew.json");
		const before = (await stat(manifestPath)).mtimeMs;
		const second = await run();
		assert.equal(second.code, 0);
		assert.equal(JSON.parse(second.text).status, "unchanged");
		const after = (await stat(manifestPath)).mtimeMs;
		assert.equal(after, before, "mtime must be preserved on exact rerun");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("crew init conflict leaves user content untouched and exits 1", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "bebop-cli-init-"));
	try {
		await mkdir(path.join(dir, ".pi/bebop"), { recursive: true });
		const userManifest = '{"version":999}';
		await writeFile(path.join(dir, ".pi/bebop/crew.json"), userManifest);
		const output = new PassThrough();
		const err = new PassThrough();
		let text = "";
		let errText = "";
		output.setEncoding("utf8");
		err.setEncoding("utf8");
		output.on("data", (chunk) => {
			text += chunk;
		});
		err.on("data", (chunk) => {
			errText += chunk;
		});
		const code = await runCli(
			["crew", "init", "--project", dir, "--format", "json"],
			dir,
			process.stdin,
			output,
			err,
		);
		assert.equal(code, 1);
		assert.equal(text, "");
		assert.match(errText, /managed-file-differs|conflict/);
		assert.equal(await readFile(path.join(dir, ".pi/bebop/crew.json"), "utf8"), userManifest);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("crew init creates only managed Intake guidance, never Inbox or root AGENTS content", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "bebop-cli-init-"));
	try {
		const rootAgents = path.join(dir, "AGENTS.md");
		await writeFile(rootAgents, "project-owned guidance\n");
		await runCli(["crew", "init", "--project", dir, "--format", "json"], dir, process.stdin, new PassThrough());
		const dotPi = path.join(dir, ".pi/bebop");
		const entries = await readdir(dotPi);
		assert.deepEqual(entries.sort(), [".gitignore", "crew.json", "instructions", "intake", "sockets"]);
		const intakeGuide = await readFile(path.join(dotPi, "intake/AGENTS.md"), "utf8");
		assert.match(intakeGuide, /external transport boundary, not the crew Inbox/);
		assert.match(intakeGuide, /997,952 UTF-8 bytes/);
		assert.match(intakeGuide, /\.pi\/bebop\/sockets/);
		assert.equal(await readFile(rootAgents, "utf8"), "project-owned guidance\n");
		assert.ok(!(await pathExists(path.join(dir, ".git"))), "no Git state created");
		assert.ok(!(await pathExists(path.join(dotPi, "inbox"))), "no inbox created");
		assert.ok(!(await pathExists(path.join(dotPi, "sockets/lead.sock"))), "no socket link created");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("crew init gitignore tracks Intake guidance and ignores runtime artifacts", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "bebop-cli-gitignore-"));
	try {
		await runCli(["crew", "init", "--project", dir, "--format", "json"], dir, process.stdin, new PassThrough());
		await execFile("git", ["init", "-q"], { cwd: dir });
		const runtimePaths = [
			".pi/bebop/intake/new",
			".pi/bebop/intake/new/item.md",
			".pi/bebop/intake/processed",
			".pi/bebop/intake/.scan.lock",
		];
		await mkdir(path.join(dir, ".pi/bebop/intake/new"), { recursive: true });
		await writeFile(path.join(dir, ".pi/bebop/intake/new/item.md"), "runtime");
		await mkdir(path.join(dir, ".pi/bebop/intake/processed"), { recursive: true });
		await writeFile(path.join(dir, ".pi/bebop/intake/.scan.lock"), "runtime");
		const isIgnored = async (relative: string): Promise<boolean> => {
			try {
				await execFile(
					"git",
					["-c", "core.excludesFile=/dev/null", "check-ignore", "--no-index", "-q", relative],
					{
						cwd: dir,
					},
				);
				return true;
			} catch (error) {
				if (
					typeof error === "object" &&
					error !== null &&
					"code" in error &&
					(error as { code?: number }).code === 1
				)
					return false;
				throw error;
			}
		};
		assert.equal(await isIgnored(".pi/bebop/intake/AGENTS.md"), false);
		for (const runtimePath of runtimePaths) assert.equal(await isIgnored(runtimePath), true, runtimePath);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

async function pathExists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

function decodeTOON(text: string): Record<string, unknown> {
	return decode(text);
}
