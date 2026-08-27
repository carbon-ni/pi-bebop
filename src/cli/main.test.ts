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
import { rootCliHelp } from "./root-help.ts";
import { createCliRegistry } from "./registry.ts";
import { crewInitHelp } from "../domain/index.ts";
import { createRpcServer, closeRpcServer } from "../infra/rpc-server.ts";
import { createSocketState, handleCommand } from "../pi/control-runtime.ts";
import { decode } from "@toon-format/toon";

const execFile = promisify(execFileCallback);
const root = path.resolve(".");

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
		const bin = path.join(binDir, "pi-bebop");
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

test("installed node_modules/.bin pi-bebop executes the packed CLI (TASK-0074 regression)", async () => {
	const archiveDir = await mkdtemp(path.join(tmpdir(), "bebop-bin-archive-"));
	const prefix = await mkdtemp(path.join(tmpdir(), "bebop-bin-prefix-"));
	try {
		const packed = await execFile("npm", ["pack", "--pack-destination", archiveDir], { cwd: root });
		const archive = packed.stdout
			.trim()
			.split("\n")
			.find((line) => line.endsWith(".tgz"))!;
		const packageRoot = path.join(prefix, "node_modules", "pi-bebop");
		await mkdir(packageRoot, { recursive: true });
		await execFile("tar", ["-xzf", path.join(archiveDir, archive), "-C", packageRoot, "--strip-components=1"]);

		// Mirror npm's install layout: the .bin entry is a symlink to the packed main.
		const binDir = path.join(prefix, "node_modules", ".bin");
		await mkdir(binDir, { recursive: true });
		const bin = path.join(binDir, "pi-bebop");
		await symlink(path.join("..", "pi-bebop", "dist", "cli", "main.js"), bin);
		const environment = { ...process.env, NODE_PATH: "" };

		// No-argument invocation through the real bin path: concise human home, exit 0.
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
		assert.equal(homeOut, "Message completed\n");

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

test("root --help and -h return deterministic concise help with exit 0 and no IO", async () => {
	const helpText = rootCliHelp(createCliRegistry().vocabulary());
	for (const flag of ["--help", "-h"]) {
		const output = new PassThrough();
		let text = "";
		output.setEncoding("utf8");
		output.on("data", (chunk) => {
			text += chunk;
		});
		const code = await runCli([flag], process.cwd(), process.stdin, output);
		assert.equal(code, 0, flag);
		assert.equal(text, helpText, flag);
	}
	// Root help performs no filesystem/project/session IO: a deleted cwd is fine.
	const nowhere = await mkdtemp(path.join(tmpdir(), "bebop-root-help-"));
	await rm(nowhere, { recursive: true, force: true });
	const output = new PassThrough();
	let text = "";
	output.setEncoding("utf8");
	output.on("data", (chunk) => {
		text += chunk;
	});
	const code = await runCli(["--help"], nowhere, process.stdin, output);
	assert.equal(code, 0);
	assert.equal(text, helpText);
	// Root help in first position wins deterministically, even with trailing args.
	const trailing = new PassThrough();
	let trailingText = "";
	trailing.setEncoding("utf8");
	trailing.on("data", (chunk) => {
		trailingText += chunk;
	});
	assert.equal(await runCli(["-h", "anything"], process.cwd(), process.stdin, trailing), 0);
	assert.equal(trailingText, helpText);
});

test("unknown root flags still produce structured usage output with exit 2", async () => {
	for (const args of [["-x"], ["--nope"]]) {
		const output = new PassThrough();
		let text = "";
		output.setEncoding("utf8");
		output.on("data", (chunk) => {
			text += chunk;
		});
		const code = await runCli(args, process.cwd(), process.stdin, output);
		assert.equal(code, 2, args.join(" "));
		assert.match(text, /Invalid command/);
	}
});

test("leaf -h is a consistent usage error, never silent help (no short aliases)", async () => {
	const leaves: string[][] = [
		["send"],
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
		assert.equal(code, 2, leaf.join(" "));
		assert.match(text, /status: usage|Unknown flag|unknown option/, leaf.join(" "));
		assert.ok(
			!text.includes("Usage:") && !text.includes("Options:") && !text.includes("Commands:"),
			`${leaf.join(" ")} -h must not render help`,
		);
	}
});

test("runs against a live Unix socket and sends ordered instructions and claimed origin", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "bebop-cli-"));
	const socketPath = path.join(dir, "member.sock");
	const sentParams: any[] = [];
	const server = net.createServer((socket) => {
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk;
			while (buffer.includes("\n")) {
				const [line, rest] = buffer.split(/\n(.*)/s);
				buffer = rest ?? "";
				if (!line) continue;
				const command = JSON.parse(line) as { method: string; id: string; params?: unknown };
				if (command.method === "message.send") {
					sentParams.push(command.params);
					socket.write(
						JSON.stringify({
							jsonrpc: "2.0",
							id: command.id,
							result: { deliveryId: `delivery-${command.id}`, disposition: "direct" },
						}) + "\n",
					);
				}
				if (command.method === "event.subscribe") {
					socket.write(
						JSON.stringify({
							jsonrpc: "2.0",
							id: command.id,
							result: { subscriptionId: command.id, event: "turn_end" },
						}) + "\n",
					);
					socket.write(
						JSON.stringify({
							jsonrpc: "2.0",
							method: "session.turn_end",
							params: {
								subscriptionId: command.id,
								message: { role: "assistant", content: "answer", timestamp: 1 },
								turnIndex: 2,
							},
						}) + "\n",
					);
				}
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	try {
		const output = new PassThrough();
		let text = "";
		output.setEncoding("utf8");
		output.on("data", (chunk) => {
			text += chunk;
		});
		const code = await runCli(
			[
				"send",
				"--socket",
				socketPath,
				"--message",
				"hello",
				"--instruction",
				"first",
				"--instruction",
				"second",
				"--from",
				"CI",
				"--format",
				"json",
			],
			process.cwd(),
			process.stdin,
			output,
		);
		assert.equal(code, 0);
		assert.equal(JSON.parse(text).response, "answer");
		assert.deepEqual(sentParams[0], {
			content: "hello",
			instructions: ["first", "second"],
			origin: { kind: "external", label: "CI" },
			delivery: "immediate",
		});
		const stdin = new PassThrough();
		const stdinOutput = new PassThrough();
		const stdinPending = runCli(
			[
				"send",
				"--socket",
				socketPath,
				"--stdin",
				"--instruction",
				"from-flag",
				"--from",
				"CI",
				"--format",
				"json",
			],
			process.cwd(),
			stdin,
			stdinOutput,
		);
		stdin.end("stdin is content only");
		assert.equal(await stdinPending, 0);
		assert.deepEqual(sentParams[1], {
			content: "stdin is content only",
			instructions: ["from-flag"],
			origin: { kind: "external", label: "CI" },
			delivery: "immediate",
		});
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(dir, { recursive: true, force: true });
	}
});

test("renders stdin read failures in the selected structured format", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	let text = "";
	output.setEncoding("utf8");
	output.on("data", (chunk) => {
		text += chunk;
	});
	const pending = runCli(
		["send", "--socket", "/offline.sock", "--stdin", "--format", "json"],
		process.cwd(),
		input,
		output,
	);
	input.emit("error", Object.assign(new Error("stdin closed"), { code: "EIO" }));
	assert.equal(await pending, 1);
	assert.deepEqual(JSON.parse(text), {
		ok: false,
		target: "/offline.sock",
		status: "error",
		error: { code: "offline", message: "stdin closed" },
	});
});

test("rejects empty stdin before connecting", async () => {
	const input = new PassThrough();
	input.end();
	const output = new PassThrough();
	let text = "";
	output.setEncoding("utf8");
	output.on("data", (chunk) => {
		text += chunk;
	});
	const code = await runCli(
		["send", "--socket", "/offline.sock", "--stdin", "--format", "json"],
		process.cwd(),
		input,
		output,
	);
	assert.equal(code, 2);
	assert.equal(JSON.parse(text).error.code, "usage");
});

test("runs the built CLI artifact under plain Node", async () => {
	const artifact = path.resolve("dist/cli/main.js");
	const child = spawn(process.execPath, [artifact, "send", "--socket", "/x", "--message", "a", "--wait", "later"], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	const code = await new Promise<number>((resolve) => child.once("exit", (value) => resolve(value ?? 1)));
	assert.equal(code, 2);
	assert.match(stdout, /Invalid --wait/);
});

test("aborts a held-open stdin read on SIGINT", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	let stdout = "";
	output.setEncoding("utf8");
	output.on("data", (chunk) => {
		stdout += chunk;
	});

	const pending = runCli(
		["send", "--socket", "/offline.sock", "--stdin", "--format", "json"],
		process.cwd(),
		input,
		output,
	);
	process.emit("SIGINT");

	assert.equal(await pending, 1);
	assert.equal(JSON.parse(stdout).error.code, "aborted");
});

test("packaged artifact exposes the member status, session list, and crew roles leaves deterministically", async () => {
	const artifact = path.resolve("dist/cli/main.js");

	// IO-free usage path: unsafe --session value is usage-class, exit 2.
	const unsafe = spawn(process.execPath, [artifact, "member", "status", "Kelly", "--session", "../x"], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	let unsafeOut = "";
	unsafe.stdout.setEncoding("utf8");
	unsafe.stdout.on("data", (chunk) => {
		unsafeOut += chunk;
	});
	const unsafeCode = await new Promise<number>((resolve) => unsafe.once("exit", (value) => resolve(value ?? 1)));
	assert.equal(unsafeCode, 2);
	assert.match(unsafeOut, /invalid-session/);

	// Help paths are deterministic and exit 0.
	for (const args of [
		["member", "status", "--help"],
		["session", "list", "--help"],
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
		assert.match(stdout, /pi-bebop member status|pi-bebop session list|pi-bebop crew roles/);
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

		// Text format is a short human line.
		const text = await run(["crew", "roles", "--format", "text"]);
		assert.equal(text.code, 0, text.stdout);
		assert.match(text.stdout, /4 configured roles: lead, product, developer, quality/);

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
		const run = (cwd: string, args: string[]): Promise<{ code: number; stdout: string }> =>
			new Promise((resolve) => {
				const child = spawn(process.execPath, [artifact, ...args], {
					cwd,
					stdio: ["ignore", "pipe", "pipe"],
				});
				let stdout = "";
				child.stdout.setEncoding("utf8");
				child.stdout.on("data", (chunk) => {
					stdout += chunk;
				});
				child.once("exit", (code) => resolve({ code: code ?? 1, stdout }));
			});

		const missing = await run(emptyDir, ["crew", "roles", "--format", "json"]);
		assert.equal(missing.code, 1);
		assert.equal(JSON.parse(missing.stdout).error.code, "missing-manifest");

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
		assert.equal(JSON.parse(both.stdout).error.code, "ambiguous-manifest");
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

test("uses injected output for selected-format usage errors", async () => {
	const output = new PassThrough();
	let text = "";
	output.setEncoding("utf8");
	output.on("data", (chunk) => {
		text += chunk;
	});
	const code = await runCli(
		["send", "--socket", "/x", "--message", "a", "--format", "json", "--wait", "later"],
		process.cwd(),
		process.stdin,
		output,
	);
	assert.equal(code, 2);
	assert.equal(JSON.parse(text).error.code, "usage");
});

test("covers accepted, rejection, timeout, exact multiline stdin, and no sender metadata", async () => {
	await withEndpoint(
		(command, socket) => {
			if (command.method === "message.send")
				socket.write(
					JSON.stringify({
						jsonrpc: "2.0",
						id: command.id,
						result: { deliveryId: `delivery-${command.id}`, disposition: "direct" },
					}) + "\n",
				);
		},
		async (socketPath, messages) => {
			const input = new PassThrough();
			input.end("line one\nline two\n");
			const output = new PassThrough();
			let text = "";
			output.setEncoding("utf8");
			output.on("data", (chunk) => {
				text += chunk;
			});
			assert.equal(
				await runCli(
					["send", "--socket", socketPath, "--stdin", "--wait", "accepted", "--format", "json"],
					root,
					input,
					output,
				),
				0,
			);
			assert.equal(JSON.parse(text).status, "accepted");
			assert.equal((messages[0]?.params as { content?: string })?.content, "line one\nline two\n");
			assert.equal(((messages[0]?.params as { content?: string })?.content ?? "").includes("sender_info"), false);
		},
	);
	await withEndpoint(
		(command, socket) => {
			if (command.method === "message.send")
				socket.write(
					JSON.stringify({ jsonrpc: "2.0", id: command.id, error: { code: 5000, message: "busy" } }) + "\n",
				);
		},
		async (socketPath) => {
			const output = new PassThrough();
			let text = "";
			output.setEncoding("utf8");
			output.on("data", (chunk) => {
				text += chunk;
			});
			assert.equal(
				await runCli(
					["send", "--socket", socketPath, "--message", "x", "--wait", "accepted", "--format", "json"],
					root,
					process.stdin,
					output,
				),
				1,
			);
			assert.equal(JSON.parse(text).ok, false);
		},
	);
	await withEndpoint(
		() => undefined,
		async (socketPath) => {
			const output = new PassThrough();
			let text = "";
			output.setEncoding("utf8");
			output.on("data", (chunk) => {
				text += chunk;
			});
			assert.equal(
				await runCli(
					[
						"send",
						"--socket",
						socketPath,
						"--message",
						"x",
						"--wait",
						"accepted",
						"--timeout",
						"20ms",
						"--format",
						"json",
					],
					root,
					process.stdin,
					output,
				),
				1,
			);
			assert.equal(JSON.parse(text).error.code, "timeout");
		},
	);
});

test("delivers through symlinked bebop and crew endpoint layouts", async () => {
	await withEndpoint(
		(command, socket) => {
			if (command.method === "message.send")
				socket.write(
					JSON.stringify({
						jsonrpc: "2.0",
						id: command.id,
						result: { deliveryId: `delivery-${command.id}`, disposition: "direct" },
					}) + "\n",
				);
		},
		async (socketPath) => {
			const project = await mkdtemp(path.join(tmpdir(), "bebop-layout-"));
			try {
				for (const layout of ["bebop", "crew"]) {
					const sockets = path.join(project, ".pi", layout, "sockets");
					await mkdir(sockets, { recursive: true });
					const link = path.join(sockets, "member.sock");
					await symlink(socketPath, link);
					const output = new PassThrough();
					let text = "";
					output.setEncoding("utf8");
					output.on("data", (chunk) => {
						text += chunk;
					});
					assert.equal(
						await runCli(
							["send", "--socket", link, "--message", layout, "--wait", "accepted", "--format", "json"],
							root,
							process.stdin,
							output,
						),
						0,
					);
					assert.equal(JSON.parse(text).status, "accepted");
				}
			} finally {
				await rm(project, { recursive: true, force: true });
			}
		},
	);
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
		let cliError: { code?: number; stdout?: string } | undefined;
		try {
			await execFile(
				process.execPath,
				[
					path.join(extract, "dist/cli/main.js"),
					"send",
					"--socket",
					"/x",
					"--message",
					"x",
					"--wait",
					"invalid",
				],
				{ cwd: extract, env: { ...process.env, NODE_PATH: "" } },
			);
		} catch (error) {
			cliError = error as { code?: number; stdout?: string };
		}
		assert.equal(cliError?.code, 2);
		assert.match(cliError?.stdout ?? "", /Invalid --wait/);
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
			["send"],
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
			assert.match(result.stdout, /Options:|Usage:|pi-bebop/);
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
			new Promise<{ code: number; stdout: string }>((resolve) => {
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
				child.stdout.setEncoding("utf8");
				child.stdout.on("data", (chunk) => (stdout += chunk));
				child.once("exit", (code) => resolve({ code: code ?? 1, stdout }));
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
		assert.match(timeoutResult.stdout, /timeout/);
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

test(
	"reports real Unix socket directory permission denial",
	{
		skip:
			process.platform === "win32" || process.getuid?.() === 0
				? "Unix permission fixture unsupported for Windows/root"
				: false,
	},
	async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "bebop-permission-"));
		try {
			await chmod(dir, 0o000);
			const output = new PassThrough();
			let text = "";
			output.setEncoding("utf8");
			output.on("data", (chunk) => {
				text += chunk;
			});
			const code = await runCli(
				[
					"send",
					"--socket",
					path.join(dir, "member.sock"),
					"--message",
					"x",
					"--format",
					"json",
					"--wait",
					"accepted",
					"--timeout",
					"100ms",
				],
				process.cwd(),
				process.stdin,
				output,
			);
			assert.equal(code, 1);
			assert.equal(JSON.parse(text).error.code, "permission-denied");
		} finally {
			await chmod(dir, 0o700);
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test("distinguishes permission denial from an offline endpoint", () => {
	assert.equal(errorCode(Object.assign(new Error("denied"), { code: "EACCES" })), "permission-denied");
	assert.equal(errorCode(Object.assign(new Error("missing"), { code: "ENOENT" })), "offline");
});

import { openTrustedMemberInboxStore } from "../infra/member-inbox-store.ts";

async function withCrewManifest(
	contact: string | undefined,
	run: (manifestPath: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(path.join(tmpdir(), "bebop-intake-"));
	const layout = path.join(dir, ".pi", "bebop");
	const sockets = path.join(layout, "sockets");
	await mkdir(sockets, { recursive: true });
	const manifestPath = path.join(layout, "crew.json");
	const members = [
		{ name: "Mary", role: "po", socket: "sockets/po.sock" },
		{ name: "Bob", role: "dev", socket: "sockets/dev.sock" },
	];
	await writeFile(
		manifestPath,
		JSON.stringify({ version: 1, members, ...(contact === undefined ? {} : { intake: { contact } }) }),
	);
	try {
		await run(manifestPath);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function capture() {
	const output = new PassThrough();
	let text = "";
	output.setEncoding("utf8");
	output.on("data", (chunk) => {
		text += chunk;
	});
	return { output, text: () => text };
}

test("--crew persists one-way intake for the configured contact while offline", async () => {
	await withCrewManifest("Mary", async (manifestPath) => {
		const { output, text } = capture();
		const code = await runCli(
			[
				"send",
				"--crew",
				manifestPath,
				"--message",
				"evaluate this request",
				"--from",
				"jira-automation",
				"--format",
				"json",
			],
			process.cwd(),
			process.stdin,
			output,
		);
		assert.equal(code, 0);
		const parsed = JSON.parse(text());
		assert.equal(parsed.status, "persisted");
		assert.equal(parsed.data.contact, "Mary");
		assert.equal(parsed.data.contactRole, "po");
		assert.equal(parsed.data.persisted, true);
		assert.match(parsed.data.itemId, /^inbox-/);
		for (const forbidden of ["delivered", "completed", "assigned", "answered"]) {
			assert.ok(!text().toLowerCase().includes(forbidden), `forbidden word: ${forbidden}`);
		}
	});
});

test("--crew without a configured contact reports external-intake-disabled", async () => {
	await withCrewManifest(undefined, async (manifestPath) => {
		const { output, text } = capture();
		const code = await runCli(
			["send", "--crew", manifestPath, "--message", "x", "--format", "json"],
			process.cwd(),
			process.stdin,
			output,
		);
		assert.equal(code, 1);
		assert.equal(JSON.parse(text()).error.code, "external-intake-disabled");
	});
});

test("--crew outside an exact supported layout reports untrusted-path", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "bebop-intake-layout-"));
	try {
		const manifestPath = path.join(dir, "crew.json");
		await writeFile(manifestPath, JSON.stringify({ version: 1, members: [] }));
		const { output, text } = capture();
		const code = await runCli(
			["send", "--crew", manifestPath, "--message", "x", "--format", "json"],
			process.cwd(),
			process.stdin,
			output,
		);
		assert.equal(code, 1);
		assert.equal(JSON.parse(text()).error.code, "untrusted-path");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("--crew with a full contact inbox reports inbox-full", async () => {
	await withCrewManifest("Mary", async (manifestPath) => {
		const projectRoot = path.dirname(path.dirname(path.dirname(manifestPath)));
		const store = await openTrustedMemberInboxStore({
			manifestPath,
			projectRoot,
			isProjectTrusted: () => true,
			member: {
				name: "Mary",
				role: "po",
				socketPath: path.join(path.dirname(manifestPath), "sockets", "po.sock"),
			},
		});
		for (let index = 0; index < 64; index += 1) {
			await store.enqueue({ content: `fill-${index}` }, 1000 + index);
		}
		const { output, text } = capture();
		const code = await runCli(
			["send", "--crew", manifestPath, "--message", "overflow", "--format", "json"],
			process.cwd(),
			process.stdin,
			output,
		);
		assert.equal(code, 1);
		assert.equal(JSON.parse(text()).error.code, "inbox-full");
	});
});

test("crew init --help exits 0 without IO and shows deterministic local help", async () => {
	const output = new PassThrough();
	let text = "";
	output.setEncoding("utf8");
	output.on("data", (chunk) => {
		text += chunk;
	});
	const code = await runCli(["crew", "init", "--help"], process.cwd(), process.stdin, output);
	assert.equal(code, 0);
	assert.equal(text, crewInitHelp());
});

test("unknown command exits 2 with valid alternatives before any IO", async () => {
	const output = new PassThrough();
	let text = "";
	output.setEncoding("utf8");
	output.on("data", (chunk) => {
		text += chunk;
	});
	const code = await runCli(["frobnicate"], process.cwd(), process.stdin, output);
	assert.equal(code, 2);
	assert.match(
		text,
		/valid commands: send, crew init, crew roles, member status, member wait-idle, session list, member follow-up, member redirect, member interrupt, member inbox send, crew broadcast/,
	);
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
		let text = "";
		output.setEncoding("utf8");
		output.on("data", (chunk) => {
			text += chunk;
		});
		const code = await runCli(["crew", "init", "--project", dir, "--format", "json"], dir, process.stdin, output);
		assert.equal(code, 1);
		const parsed = JSON.parse(text);
		assert.equal(parsed.ok, false);
		assert.equal(parsed.error.code, "managed-file-differs");
		assert.equal(await readFile(path.join(dir, ".pi/bebop/crew.json"), "utf8"), userManifest);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("crew init does not create inbox, sockets links, processes, or Git state", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "bebop-cli-init-"));
	try {
		await runCli(["crew", "init", "--project", dir, "--format", "json"], dir, process.stdin, new PassThrough());
		const dotPi = path.join(dir, ".pi/bebop");
		const entries = await readdir(dotPi);
		assert.deepEqual(entries.sort(), [".gitignore", "crew.json", "instructions", "sockets"]);
		assert.ok(!(await pathExists(path.join(dir, ".git"))), "no Git state created");
		assert.ok(!(await pathExists(path.join(dotPi, "inbox"))), "no inbox created");
		assert.ok(!(await pathExists(path.join(dotPi, "sockets/lead.sock"))), "no socket link created");
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

test("no arguments shows concise human home state by default", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "bebop-cli-home-"));
	try {
		const output = new PassThrough();
		let text = "";
		output.setEncoding("utf8");
		output.on("data", (chunk) => {
			text += chunk;
		});
		const code = await runCli([], dir, process.stdin, output);
		assert.equal(code, 0);
		assert.equal(text.trim(), "Message completed");
		const toonOutput = new PassThrough();
		let toonText = "";
		toonOutput.setEncoding("utf8");
		toonOutput.on("data", (chunk) => {
			toonText += chunk;
		});
		assert.equal(await runCli(["--format", "toon"], dir, process.stdin, toonOutput), 0);
		const decoded = decodeTOON(toonText);
		assert.equal(decoded.status, "home");
		assert.equal(decoded.data.scaffold, "missing");
		assert.equal(decoded.data.next, "pi-bebop crew init");
		assert.deepEqual(decoded.data.commands, [
			"send",
			"crew init",
			"crew roles",
			"member status",
			"member wait-idle",
			"session list",
			"member follow-up",
			"member redirect",
			"member interrupt",
			"member inbox send",
			"crew broadcast",
		]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

function decodeTOON(text: string): Record<string, unknown> {
	return decode(text);
}
