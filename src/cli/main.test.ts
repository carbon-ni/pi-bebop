import test from "node:test";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import net from "node:net";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { errorCode, runCli } from "./main.ts";
import { crewInitHelp } from "../domain/index.ts";
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

test("aborts a held-open stdin read on SIGINT within a bounded deadline", async () => {
	const script = path.resolve("dist/cli/main.js");
	const child = spawn(
		process.execPath,
		[script, "send", "--socket", "/offline.sock", "--stdin", "--format", "json"],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);
	let stdout = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
		child.once("exit", (code, signal) => resolve({ code, signal })),
	);
	await new Promise((resolve) => setTimeout(resolve, 300));
	child.kill("SIGINT");
	let timer: NodeJS.Timeout | undefined;
	try {
		const exit = await Promise.race([
			exitPromise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("CLI did not exit after SIGINT deadline")), 3000);
			}),
		]);
		assert.equal(exit.code, 1);
		assert.equal(exit.signal, null);
		assert.equal(JSON.parse(stdout).error.code, "aborted");
	} catch (error) {
		child.kill("SIGKILL");
		await exitPromise;
		throw error;
	} finally {
		if (timer) clearTimeout(timer);
	}
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
	assert.match(text, /valid commands: send, crew init/);
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
		assert.equal(manifest.version, 1);
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

test("no arguments shows compact TOON home state with crew init hint when missing", async () => {
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
		const decoded = decodeTOON(text);
		assert.equal(decoded.status, "home");
		assert.equal(decoded.data.scaffold, "missing");
		assert.equal(decoded.data.next, "pi-bebop crew init");
		assert.deepEqual(decoded.data.commands, ["send", "crew init"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

function decodeTOON(text: string): Record<string, unknown> {
	return decode(text);
}
