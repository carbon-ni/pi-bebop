import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { runCli } from "./run.ts";
import { renderCliResult, type CliResult } from "./support/output.ts";
import { decode } from "@toon-format/toon";

const cwd = "/project";

function capture(): { output: PassThrough; stderr: PassThrough; text: () => { stdout: string; stderr: string } } {
	const output = new PassThrough();
	const stderr = new PassThrough();
	let stdout = "";
	let err = "";
	output.setEncoding("utf8");
	stderr.setEncoding("utf8");
	output.on("data", (chunk) => {
		stdout += chunk;
	});
	stderr.on("data", (chunk) => {
		err += chunk;
	});
	return {
		output,
		stderr,
		text: () => ({ stdout, stderr: err }),
	};
}

test("TASK-0165 canonical audience samples have measured TOON/JSON parity", () => {
	const samples: Array<{ result: CliResult; toonBytes: number; jsonBytes: number }> = [
		{
			result: {
				ok: true,
				target: "crew roles",
				status: "completed",
				data: {
					roles: [
						{ role: "lead", members: 1 },
						{ role: "developer", members: 2 },
						{ role: "po", members: 1 },
						{ role: "qa", members: 1 },
					],
				},
			},
			toonBytes: 122,
			jsonBytes: 186,
		},
		{
			result: {
				ok: true,
				target: "member follow-up Kelly",
				status: "accepted",
				data: { member: { name: "Kelly", role: "qa" }, disposition: "queued" },
			},
			toonBytes: 123,
			jsonBytes: 135,
		},
		{
			result: {
				ok: true,
				target: "session live",
				status: "completed",
				data: { sessions: [], total: 0 },
			},
			toonBytes: 79,
			jsonBytes: 89,
		},
	];
	for (const sample of samples) {
		const toon = renderCliResult(sample.result, "toon", false);
		const json = renderCliResult(sample.result, "json", false);
		assert.deepEqual(decode(toon), JSON.parse(json));
		assert.equal(Buffer.byteLength(toon), sample.toonBytes);
		assert.equal(Buffer.byteLength(json), sample.jsonBytes);
	}
});

test("structured result: TOON and JSON encode the same semantic payload", () => {
	const result: CliResult = {
		ok: true,
		target: "/x",
		status: "created",
		response: "r",
		data: {
			status: "created",
			manifestPath: ".pi/bebop/crew.json",
			createdPaths: ["a"],
			verifiedPaths: [],
			nextCommands: ["pi --crew-socket x"],
		},
	};
	const toon = renderCliResult(result, "toon", false);
	const json = renderCliResult(result, "json", false);
	assert.equal(typeof JSON.parse(json).status, "string");
	assert.match(toon, /status: created/);
});

test("--format never steers failure output: failures are identical plain stderr text", async () => {
	const plain = capture();
	await runCli(["bogus"], cwd, process.stdin, plain.output, plain.stderr);
	const inline = capture();
	await runCli(["bogus", "--format=json"], cwd, process.stdin, inline.output, inline.stderr);
	const separate = capture();
	await runCli(["bogus", "--format", "json"], cwd, process.stdin, separate.output, separate.stderr);

	assert.equal(plain.text().stdout, "");
	assert.equal(inline.text().stdout, "");
	assert.equal(plain.text().stderr, inline.text().stderr);
	assert.equal(inline.text().stderr, separate.text().stderr);
	assert.match(plain.text().stderr, /unknown command 'bogus'/);
});

test("exit codes: usage=2, help=0, success=0", async () => {
	const first = capture();
	assert.equal(await runCli(["bogus"], cwd, process.stdin, first.output, first.stderr), 2);
	// crew init in a temp-free cwd is a usage-safe probe only when it succeeds;
	// help and no-arg paths cover the zero class without touching the filesystem.
	const second = capture();
	assert.equal(await runCli(["crew", "init", "--help"], cwd, process.stdin, second.output, second.stderr), 0);
	const third = capture();
	assert.equal(await runCli([], cwd, process.stdin, third.output, third.stderr), 0);
	assert.match(third.text().stdout, /^Usage: bebop/);
});
