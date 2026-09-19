import test from "node:test";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * TASK-0209: process-level CLI contract. Commander owns discovery, help, and
 * syntax errors; the runner owns streams and exit classes:
 *   help        -> stdout, exit 0, empty stderr
 *   usage       -> stderr, exit 2, empty stdout, plain text (never TOON/JSON)
 *   operational -> stderr, exit 1, empty stdout, plain text
 *   success     -> stdout, exit 0, --format text|toon|json
 * The suite runs the built artifact (npm test builds via pretest) so the
 * packaged process boundary is what is verified.
 */

const execFile = promisify(execFileCallback);
// The dist artifact is rewritten concurrently by packaged tests running
// `npm pack` (prepack -> build), so the process contract runs the real source
// through a tsx launcher pinned to an absolute path — never the mutable dist.
const cliSource = path.resolve("src/cli/run.ts");

async function launcherPath(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "bebop-0209-launcher-"));
	const file = path.join(dir, "launcher.mts");
	const { writeFile } = await import("node:fs/promises");
	await writeFile(
		file,
		`import { runCli } from ${JSON.stringify(cliSource)};\nrunCli(process.argv.slice(2), process.env.BEBOP_TEST_CWD ?? process.cwd()).then((code) => process.exit(code));\n`,
	);
	return file;
}

interface CliRun {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

async function cli(args: readonly string[], cwd = process.cwd()): Promise<CliRun> {
	const launcher = await launcherPath();
	try {
		const result = await execFile(process.execPath, ["--import", "tsx", launcher, ...args], {
			// tsx resolves against the process cwd; keep it at the repo root and
			// hand the target project to runCli via the environment instead.
			cwd: path.resolve("."),
			env: { ...process.env, BEBOP_TEST_CWD: cwd },
			encoding: "utf8",
			timeout: 30000,
			stdio: ["ignore", "pipe", "pipe"] as const,
		});
		return { code: 0, stdout: result.stdout, stderr: result.stderr };
	} catch (error) {
		const failure = error as NodeJS.ErrnoException & {
			code?: number | string;
			stdout?: string;
			stderr?: string;
		};
		if (typeof failure.code === "number")
			return { code: failure.code, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
		throw error;
	} finally {
		await rm(path.dirname(launcher), { recursive: true, force: true });
	}
}

async function inTempProject(): Promise<string> {
	return mkdtemp(path.join(tmpdir(), "bebop-0209-"));
}

test("no arguments show Commander-owned root help on stdout with exit 0", async () => {
	const project = await inTempProject();
	try {
		const run = await cli([], project);
		assert.equal(run.code, 0);
		assert.match(run.stdout, /^Usage: bebop/);
		assert.match(run.stdout, /Commands:/);
		for (const group of ["crew", "member", "session", "guest"])
			assert.match(run.stdout, new RegExp(`^  ${group}`, "m"));
		assert.equal(run.stderr, "");
	} finally {
		await rm(project, { recursive: true, force: true });
	}
});

test("root --help and -h are the same help, stdout, exit 0", async () => {
	for (const flag of ["--help", "-h"]) {
		const run = await cli([flag]);
		assert.equal(run.code, 0, flag);
		assert.match(run.stdout, /^Usage: bebop/);
		assert.equal(run.stderr, "", flag);
	}
});

test("help performs no project IO", async () => {
	const project = await inTempProject();
	try {
		const run = await cli(["--help"], project);
		assert.equal(run.code, 0);
		assert.deepEqual(await readdir(project), []);
	} finally {
		await rm(project, { recursive: true, force: true });
	}
});

test("a bare group shows the group's local help on stdout with exit 0", async () => {
	const run = await cli(["member"]);
	assert.equal(run.code, 0);
	assert.match(run.stdout, /^Usage: bebop member/);
	assert.match(run.stdout, /status/);
	assert.equal(run.stderr, "");
});

test("every leaf supports -h with generated usage and prose on stdout, exit 0", async () => {
	const leaves: readonly (readonly string[])[] = [
		["crew", "init"],
		["crew", "list"],
		["crew", "roles"],
		["crew", "broadcast"],
		["member", "status"],
		["member", "wait-idle"],
		["member", "follow-up"],
		["member", "redirect"],
		["member", "interrupt"],
		["member", "inbox", "send"],
		["member", "request", "send"],
		["member", "request", "respond"],
		["session", "capture"],
		["session", "list"],
		["session", "show"],
		["session", "resume"],
		["guest", "join"],
		["guest", "send"],
	];
	for (const leaf of leaves) {
		for (const flag of ["--help", "-h"]) {
			const run = await cli([...leaf, flag]);
			assert.equal(run.code, 0, [...leaf, flag].join(" "));
			assert.match(run.stdout, new RegExp(`^Usage: bebop ${leaf.join(" ")}`), leaf.join(" "));
			assert.equal(run.stderr, "", [...leaf, flag].join(" "));
		}
	}
});

test("unknown root command exits 2 with plain stderr and no stdout", async () => {
	const run = await cli(["wat"]);
	assert.equal(run.code, 2);
	assert.match(run.stderr, /error: unknown command 'wat'/);
	assert.equal(run.stdout, "");
});

test("unknown group subcommand exits 2 with local usage, not the full leaf list", async () => {
	const run = await cli(["crew", "nope"]);
	assert.equal(run.code, 2);
	assert.match(run.stderr, /error: unknown command 'nope'/);
	assert.match(run.stderr, /Usage: bebop crew/);
	assert.equal(run.stdout, "");
});

test("misspelled subcommand gets Commander's nearest-command suggestion", async () => {
	const run = await cli(["member", "stat"]);
	assert.equal(run.code, 2);
	assert.match(run.stderr, /\(Did you mean status\?\)/);
});

test("unknown option exits 2 showing the addressed command's local usage", async () => {
	const run = await cli(["member", "status", "--bogus", "x"]);
	assert.equal(run.code, 2);
	assert.match(run.stderr, /error: unknown option '--bogus'/);
	assert.match(run.stderr, /Usage: bebop member status/);
	assert.equal(run.stdout, "");
});

test("missing required argument exits 2 with local usage", async () => {
	// `<request-id>` is a required positional: Commander rejects before the handler.
	const run = await cli(["member", "request", "wait"]);
	assert.equal(run.code, 2);
	assert.match(run.stderr, /missing required argument/);
	assert.match(run.stderr, /Usage: bebop member request wait/);
	assert.equal(run.stdout, "");
});

test("excess arguments exit 2 with local usage", async () => {
	const run = await cli(["crew", "init", "extra", "args"]);
	assert.equal(run.code, 2);
	assert.match(run.stderr, /Usage: bebop crew init/);
	assert.equal(run.stdout, "");
});

test("the retired crew session rejection path is gone: unknown command like any other", async () => {
	const run = await cli(["crew", "session", "list"]);
	assert.equal(run.code, 2);
	assert.match(run.stderr, /error: unknown command 'session'/);
});

test("the compatibility top-level send command is removed", async () => {
	const run = await cli(["send", "--socket", "/x", "--message", "m"]);
	assert.equal(run.code, 2);
	assert.match(run.stderr, /error: unknown command 'send'/);
	assert.equal(run.stdout, "");
});

test("-v prints the version on stdout with exit 0", async () => {
	const run = await cli(["-v"]);
	assert.equal(run.code, 0);
	assert.match(run.stdout, /^bebop \d+\.\d+\.\d+/);
	assert.equal(run.stderr, "");
});

test("operational failures are plain text on stderr, exit 1, nothing on stdout", async () => {
	const project = await inTempProject();
	try {
		const run = await cli(["session", "show", "cs_doesnotexist"], project);
		assert.equal(run.code, 1);
		assert.equal(run.stdout, "");
		assert.notEqual(run.stderr, "");
		assert.doesNotMatch(run.stderr, /^[\[{]/); // no TOON/JSON envelope
	} finally {
		await rm(project, { recursive: true, force: true });
	}
});

test("successful canonical results keep --format text|toon|json", async () => {
	const project = await inTempProject();
	try {
		const text = await cli(["crew", "init"], project);
		assert.equal(text.code, 0, text.stderr);
		assert.match(text.stdout, /Crew scaffold created/);

		const json = await cli(["crew", "init", "--format", "json"], project);
		assert.equal(json.code, 0, json.stderr);
		const payload = JSON.parse(json.stdout) as { ok: boolean; status: string };
		assert.equal(payload.ok, true);
		assert.equal(payload.status, "unchanged");

		const toon = await cli(["crew", "init", "--format=toon"], project);
		assert.equal(toon.code, 0, toon.stderr);
		assert.match(toon.stdout, /ok: true/);
		assert.equal(text.stderr, "");
	} finally {
		await rm(project, { recursive: true, force: true });
	}
});
