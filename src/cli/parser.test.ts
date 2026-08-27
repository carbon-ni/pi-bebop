import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseCrewInitCommand } from "./parser.ts";
import { UsageError } from "./arguments.ts";

/**
 * TASK-0057 facade tests: the Commander-backed declarative crew init parser.
 * The 0056 characterization suite (cli-contract.test.ts) locks the public
 * contract through parseCliCommand; these tests exercise the facade directly
 * with injected argv and assert the same byte-compatible UsageError messages,
 * zero ambient IO (no process.exit, no console writes), and validation-before-IO.
 */

const cwd = "/project";

test("declarative crew init defaults to cwd and text", () => {
	assert.deepEqual(parseCrewInitCommand([], cwd), { command: "crew-init", format: "text" });
	assert.deepEqual(parseCrewInitCommand(["--format", "json"], cwd), {
		command: "crew-init",
		format: "json",
	});
	assert.deepEqual(parseCrewInitCommand(["--format=text"], cwd), {
		command: "crew-init",
		format: "text",
	});
	assert.deepEqual(parseCrewInitCommand(["--from", "https://example.test/template.git", "--ref", "v1"], cwd), {
		command: "crew-init",
		from: "https://example.test/template.git",
		ref: "v1",
		format: "text",
	});
});

test("declarative crew init resolves --project against cwd in both syntaxes", () => {
	assert.deepEqual(parseCrewInitCommand(["--project", "."], cwd), {
		command: "crew-init",
		project: path.resolve(cwd, "."),
		format: "text",
	});
	assert.deepEqual(parseCrewInitCommand(["--project=../x"], cwd), {
		command: "crew-init",
		project: path.resolve(cwd, "../x"),
		format: "text",
	});
});

test("declarative crew init supports the -- sentinel escape for flag-like values", () => {
	assert.deepEqual(parseCrewInitCommand(["--project", "--", "-weird"], cwd), {
		command: "crew-init",
		project: path.resolve(cwd, "-weird"),
		format: "text",
	});
});

test("declarative crew init --help is accepted without IO", () => {
	assert.deepEqual(parseCrewInitCommand(["--help"], cwd), {
		command: "crew-init",
		format: "text",
		help: true,
	});
	assert.deepEqual(parseCrewInitCommand(["--project", ".", "--help"], cwd), {
		command: "crew-init",
		project: path.resolve(cwd, "."),
		format: "text",
		help: true,
	});
});

test("declarative crew init rejects unknown, duplicate, and missing flags with exact legacy messages", () => {
	for (const [args, pattern] of [
		[
			["--bogus"],
			/Unknown flag '--bogus'; valid flags: --project <directory>, --from <template>, --ref <ref>, --format toon\|json\|text, --help/,
		],
		[["extra"], /Unknown flag 'extra'/],
		[["--project"], /Missing value for --project/],
		[["--format"], /Missing value for --format/],
		[["--project", "a", "--project", "b"], /Duplicate flag: --project/],
		[["--format", "json", "--format", "toon"], /Duplicate flag: --format/],
		[["--help", "--help"], /Duplicate flag: --help/],
	] as const) {
		assert.throws(
			() => parseCrewInitCommand(args as string[], cwd),
			(error: unknown) => {
				assert.ok(error instanceof UsageError, `${args.join(" ")} -> UsageError`);
				assert.match(error.message, pattern);
				return true;
			},
			args.join(" "),
		);
	}
});

test("declarative crew init requires --from for --ref and rejects local refs", () => {
	assert.throws(() => parseCrewInitCommand(["--ref", "v1"], cwd), /--ref requires --from/);
	assert.throws(
		() => parseCrewInitCommand(["--from", "../template", "--ref", "v1"], cwd),
		/only supported with a git/,
	);
});

test("declarative crew init rejects incompatible format values", () => {
	assert.throws(
		() => parseCrewInitCommand(["--format", "yaml"], cwd),
		/Invalid --format 'yaml'; valid alternatives: toon, json, text/,
	);
});

test("declarative crew init parse performs zero ambient stdout/stderr writes", () => {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const originalOut = process.stdout.write.bind(process.stdout);
	const originalErr = process.stderr.write.bind(process.stderr);
	process.stdout.write = ((chunk: unknown) => {
		stdout.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: unknown) => {
		stderr.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	try {
		const ok = parseCrewInitCommand(["--project", "."], cwd);
		assert.equal(ok.command, "crew-init");
		assert.throws(() => parseCrewInitCommand(["--bogus"], cwd), UsageError);
	} finally {
		process.stdout.write = originalOut;
		process.stderr.write = originalErr;
	}
	assert.deepEqual(stdout, [], "no ambient stdout writes");
	assert.deepEqual(stderr, [], "no ambient stderr writes");
});

test("declarative crew init validation happens before any filesystem access", async () => {
	// The facade is pure: it never receives an fs adapter and only resolves
	// paths. Assert that a usage error leaves a temp project untouched.
	const { mkdtemp, readdir, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = await mkdtemp(join(tmpdir(), "bebop-decl-"));
	try {
		assert.throws(() => parseCrewInitCommand(["--bogus"], dir), UsageError);
		assert.throws(() => parseCrewInitCommand(["--project"], dir), UsageError);
		assert.deepEqual(await readdir(dir), [], "usage errors must not touch the filesystem");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
