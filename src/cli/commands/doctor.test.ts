import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { REQUIRED_RUNTIME_CAPABILITIES, type CrewManifest } from "../../domain/index.ts";
import { writeOutcome } from "../support/output.ts";
import {
	buildDoctorCommand,
	renderDoctorText,
	readDoctorCommand,
	runDoctorCommand,
	type DoctorCliOptions,
} from "./doctor.ts";
import type { RuntimeDoctorDependencies } from "../../application/runtime-doctor.ts";

const options = (overrides: Partial<DoctorCliOptions> = {}): DoctorCliOptions => ({
	command: "doctor",
	format: "text",
	timeoutSeconds: 1,
	diagnostic: false,
	full: false,
	...overrides,
});

const manifest: CrewManifest = {
	version: 2,
	crew: { id: "alpha", displayName: "Alpha" },
	members: [{ name: "Alice", role: "developer", socket: "sockets/alice.sock", socketPath: "/alice" }],
	presence: { notifications: true },
};
const compatible = {
	product: "pi-bebop" as const,
	protocol: { name: "pi-bebop" as const, major: 1, minor: 0 },
	packageVersion: "0.2.0",
	buildCommit: "a".repeat(40),
	capabilities: [...REQUIRED_RUNTIME_CAPABILITIES],
};
function deps(overrides: Partial<RuntimeDoctorDependencies> = {}): RuntimeDoctorDependencies {
	return {
		discoverManifestPaths: () => ["/project/crew.json"],
		readManifest: async () => manifest,
		probeRuntime: async () => ({ kind: "response", value: compatible }),
		cli: { packageVersion: "0.2.0", buildCommit: "b".repeat(40), protocol: { major: 1, minor: 0 } },
		...overrides,
	};
}
function context(): Parameters<typeof runDoctorCommand>[1] {
	return { cwd: "/project", input: Readable.from([]), signal: new AbortController().signal };
}

test("doctor help and reader describe the bounded, read-only workflow", () => {
	const command = buildDoctorCommand();
	let help = "";
	command.configureOutput({ writeOut: (value) => (help += value) });
	command.outputHelp();
	assert.match(help, /read-only exchange/);
	command.setOptionValue("format", "text");
	command.setOptionValue("timeout", "10");
	command.setOptionValue("diagnostic", true);
	assert.deepEqual(readDoctorCommand(command), {
		command: "doctor",
		format: "text",
		timeoutSeconds: 10,
		diagnostic: true,
		full: false,
	});
	const defaults = buildDoctorCommand();
	assert.deepEqual(readDoctorCommand(defaults), {
		command: "doctor",
		format: "text",
		timeoutSeconds: 2,
		diagnostic: false,
		full: false,
	});
	for (const [key, value] of [
		["format", "yaml"],
		["timeout", "0"],
		["timeout", "31"],
		["timeout", "not-a-number"],
	] as const) {
		const invalid = buildDoctorCommand();
		invalid.setOptionValue(key, value);
		assert.throws(() => readDoctorCommand(invalid), /Invalid/);
	}
});

test("doctor text names Crew and Member identities and omits transport details", async () => {
	const outcome = await runDoctorCommand(options(), context(), deps());
	assert.equal(outcome.kind, "result");
	if (outcome.kind !== "result") return;
	assert.match(outcome.result.response ?? "", /Crew Alpha/);
	assert.match(outcome.result.response ?? "", /Alice \(developer\)/);
	assert.doesNotMatch(outcome.result.response ?? "", /socket|session|capabilit|runtime\.compatibility/);
});

test("doctor explicit structured formats retain stable diagnosis rows", async () => {
	for (const format of ["json", "toon"] as const) {
		const outcome = await runDoctorCommand(options({ format, diagnostic: true }), context(), deps());
		assert.equal(outcome.kind, "result");
		if (outcome.kind !== "result") continue;
		const output: string[] = [];
		const errors: string[] = [];
		const stream = { write: (value: string) => void output.push(value) };
		const errorStream = { write: (value: string) => void errors.push(value) };
		assert.equal(writeOutcome(stream, errorStream, outcome), 0);
		assert.equal(errors.length, 0);
		assert.match(output.join(""), /Alice/);
		assert.match(output.join(""), /capabil/);
	}
});

test("doctor renders empty and diagnostic recovery states without transport details", () => {
	assert.match(
		renderDoctorText(
			{
				status: "empty",
				cli: { packageVersion: "0.2.0", buildCommit: "b".repeat(40), protocol: { major: 1, minor: 0 } },
				crews: [],
				configuration: "healthy",
				partial: false,
			},
			false,
		),
		/crew init/,
	);
	assert.match(
		renderDoctorText(
			{
				status: "issues",
				cli: { packageVersion: "0.2.0", buildCommit: "b".repeat(40), protocol: { major: 1, minor: 0 } },
				configuration: "healthy",
				partial: true,
				crews: [
					{
						status: "issues",
						configuration: "healthy",
						selector: "alpha",
						message: "Configuration needs attention.",
						members: [
							{
								name: "Bob",
								role: "",
								status: "malformed-peer",
								message: undefined,
								protocol: undefined,
								packageVersion: undefined,
							},
						],
					},
				],
			},
			false,
		),
		/Crew alpha: issues/,
	);
	assert.match(
		renderDoctorText(
			{
				status: "issues",
				cli: { packageVersion: "0.2.0", buildCommit: "b".repeat(40), protocol: { major: 1, minor: 0 } },
				configuration: "healthy",
				partial: true,
				crews: [
					{
						status: "issues",
						configuration: "healthy",
						message: "Configuration needs attention.",
						next: "Fix configuration, then rerun `bebop doctor`.",
						members: [
							{
								name: "Alice",
								role: "developer",
								status: "unsupported-action",
								missingCapabilities: ["member.request_start"],
								capabilities: ["member.follow_up"],
								message: "A required Crew action is unavailable.",
							},
							{
								name: "Bob",
								role: "",
								status: "stale-runtime",
								protocol: { major: 0, minor: 9 },
								packageVersion: undefined,
								buildCommit: undefined,
							},
						],
					},
				],
			},
			true,
		),
		/Missing capabilities Alice: member\.request_start/,
	);
});

test("doctor text gives one actionable next step for an incompatible Member", () => {
	const text = renderDoctorText(
		{
			status: "issues",
			cli: { packageVersion: "0.2.0", buildCommit: "b".repeat(40), protocol: { major: 1, minor: 0 } },
			configuration: "healthy",
			partial: true,
			crews: [
				{
					status: "issues",
					configuration: "healthy",
					members: [
						{
							name: "Alice",
							role: "developer",
							status: "incompatible-runtime",
							message: "The running Member does not support compatibility diagnosis.",
							next: "Update pi-bebop, restart the affected Member, then rerun `bebop doctor`.",
						},
					],
				},
			],
		},
		false,
	);
	assert.match(text, /Alice \(developer\): incompatible-runtime/);
	assert.match(text, /Next: Update pi-bebop, restart the affected Member, then rerun `bebop doctor`\./);
	assert.doesNotMatch(text, /member\.request|sockets|sessionId/);
});
