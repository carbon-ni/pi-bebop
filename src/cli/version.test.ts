import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PassThrough } from "node:stream";
import { formatCliVersion, cliVersionOutput } from "./version.ts";
import { runCli } from "./run.ts";

const execFile = promisify(execFileCallback);
const root = path.resolve(".");

test("formats the CLI version with the package version and full build commit", () => {
	assert.equal(
		formatCliVersion("1.2.3", "ABCDEF0123456789ABCDEF0123456789ABCDEF01"),
		"pi-bebop 1.2.3 (commit abcdef0123456789abcdef0123456789abcdef01)",
	);
});

test("rejects an abbreviated or malformed build commit", () => {
	assert.throws(() => formatCliVersion("1.2.3", "abc"), /full 40-character hexadecimal commit SHA/);
});

test("root -v and --version return the same concise output without project IO", async () => {
	const outputs: string[] = [];
	for (const flag of ["-v", "--version"]) {
		const output = new PassThrough();
		let text = "";
		output.setEncoding("utf8");
		output.on("data", (chunk) => (text += chunk));
		const code = await runCli([flag], "/path/that/does/not/exist", process.stdin, output);
		assert.equal(code, 0, flag);
		outputs.push(text);
	}
	assert.equal(outputs[0], outputs[1]);
	assert.equal(outputs[0], `${cliVersionOutput()}\n`);
	assert.match(outputs[0], /^pi-bebop [^\n]+ \(commit [0-9a-f]{40}\)\n$/);
});

test("packed CLI preserves the built version and commit provenance", async () => {
	const archiveDir = await mkdtemp(path.join(tmpdir(), "bebop-version-archive-"));
	const extractDir = await mkdtemp(path.join(tmpdir(), "bebop-version-extract-"));
	try {
		const artifact = path.resolve("dist/cli/main.js");
		const direct = await execFile(process.execPath, [artifact, "--version"], { cwd: root });
		assert.match(direct.stdout, /^pi-bebop 0\.1\.0 \(commit [0-9a-f]{40}\)\n$/);
		const packed = await execFile("npm", ["pack", "--pack-destination", archiveDir], { cwd: root });
		const archive = packed.stdout
			.trim()
			.split("\n")
			.find((line) => line.endsWith(".tgz"));
		assert.ok(archive);
		await execFile("tar", ["-xzf", path.join(archiveDir, archive), "-C", extractDir, "--strip-components=1"]);
		const packageJson = JSON.parse(await readFile(path.join(extractDir, "package.json"), "utf8"));
		assert.equal(packageJson.version, "0.1.0");
		for (const flag of ["-v", "--version"]) {
			const result = await execFile(process.execPath, [path.join(extractDir, "dist/cli/main.js"), flag], {
				cwd: extractDir,
			});
			assert.equal(result.stdout, direct.stdout, flag);
		}
	} finally {
		await rm(archiveDir, { recursive: true, force: true });
		await rm(extractDir, { recursive: true, force: true });
	}
});

test("version flags remain root-first and do not alter existing help output", async () => {
	const output = new PassThrough();
	let text = "";
	output.setEncoding("utf8");
	output.on("data", (chunk) => (text += chunk));
	assert.equal(await runCli(["--version", "--help"], process.cwd(), process.stdin, output), 0);
	assert.match(text, /^pi-bebop /);
});
