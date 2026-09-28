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
import type { DoctorResult, RuntimeDoctorDependencies } from "../../application/runtime-doctor.ts";

const doctorOptions = (overrides: Partial<DoctorCliOptions> = {}): DoctorCliOptions => ({
	command: "doctor",
	format: "text",
	timeoutSeconds: 1,
	diagnostic: false,
	full: false,
	...overrides,
});

const crewManifest: CrewManifest = {
	version: 2,
	crew: { id: "alpha", displayName: "Alpha" },
	members: [{ name: "Alice", role: "developer", socket: "sockets/alice.sock", socketPath: "/alice" }],
	presence: { notifications: true },
};

const compatibleRuntime = {
	product: "pi-bebop" as const,
	protocol: { name: "pi-bebop" as const, major: 1, minor: 0 },
	packageVersion: "0.2.0",
	buildCommit: "a".repeat(40),
	capabilities: [...REQUIRED_RUNTIME_CAPABILITIES],
};

const cliVersion = {
	packageVersion: "0.2.0",
	buildCommit: "b".repeat(40),
	protocol: { major: 1, minor: 0 },
};

function doctorDependencies(): RuntimeDoctorDependencies {
	return {
		discoverManifestPaths: () => ["/project/crew.json"],
		readManifest: async () => crewManifest,
		probeRuntime: async () => ({ kind: "response", value: compatibleRuntime }),
		cli: cliVersion,
	};
}

function cliContext(): Parameters<typeof runDoctorCommand>[1] {
	return { cwd: "/project", input: Readable.from([]), signal: new AbortController().signal };
}

test("doctor help describes a read-only exchange", () => {
	const command = buildDoctorCommand();
	let help = "";
	command.configureOutput({ writeOut: (value) => (help += value) });

	command.outputHelp();

	assert.match(help, /read-only exchange/);
});

test("doctor reader uses text output and a two-second timeout by default", () => {
	const command = buildDoctorCommand();

	const options = readDoctorCommand(command);

	assert.deepEqual(options, {
		command: "doctor",
		format: "text",
		timeoutSeconds: 2,
		diagnostic: false,
		full: false,
	});
});

test("doctor reader preserves explicit timeout and diagnostic options", () => {
	const command = buildDoctorCommand();
	command.setOptionValue("format", "text");
	command.setOptionValue("timeout", "10");
	command.setOptionValue("diagnostic", true);

	const options = readDoctorCommand(command);

	assert.deepEqual(options, {
		command: "doctor",
		format: "text",
		timeoutSeconds: 10,
		diagnostic: true,
		full: false,
	});
});

for (const [option, value] of [
	["format", "yaml"],
	["timeout", "0"],
	["timeout", "31"],
	["timeout", "not-a-number"],
] as const) {
	test(`doctor reader rejects --${option} ${value}`, () => {
		const command = buildDoctorCommand();
		command.setOptionValue(option, value);

		assert.throws(() => readDoctorCommand(command), /Invalid/);
	});
}

test("doctor text names Crew and Member identities and omits transport details", async () => {
	const options = doctorOptions();
	const context = cliContext();
	const dependencies = doctorDependencies();

	const outcome = await runDoctorCommand(options, context, dependencies);

	assert.ok(outcome.kind === "result");
	const text = outcome.result.response ?? "";
	assert.match(text, /Crew Alpha/);
	assert.match(text, /Alice \(developer\)/);
	assert.doesNotMatch(text, /socket|session|capabilit|runtime\.compatibility/);
});

for (const format of ["json", "toon"] as const) {
	test(`doctor ${format} output includes Member identity and diagnostic capabilities`, async () => {
		const options = doctorOptions({ format, diagnostic: true });
		const output: string[] = [];
		const errors: string[] = [];
		const stdout = { write: (value: string) => void output.push(value) };
		const stderr = { write: (value: string) => void errors.push(value) };

		const outcome = await runDoctorCommand(options, cliContext(), doctorDependencies());

		assert.ok(outcome.kind === "result");

		const exitCode = writeOutcome(stdout, stderr, outcome);

		assert.equal(exitCode, 0);
		assert.equal(errors.length, 0);
		assert.match(output.join(""), /Alice/);
		assert.match(output.join(""), /capabil/);
	});
}

test("doctor text suggests Crew initialization when no trusted Crews are found", () => {
	const diagnosis: DoctorResult = {
		status: "empty",
		cli: cliVersion,
		crews: [],
		configuration: "healthy",
		partial: false,
	};

	const text = renderDoctorText(diagnosis, false);

	assert.match(text, /crew init/);
});

test("doctor text uses the Crew selector when its display name is absent", () => {
	const diagnosis: DoctorResult = {
		status: "issues",
		cli: cliVersion,
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
	};

	const text = renderDoctorText(diagnosis, false);

	assert.match(text, /Crew alpha: issues/);
});

test("doctor diagnostic text identifies a Member's missing capabilities", () => {
	const diagnosis: DoctorResult = {
		status: "issues",
		cli: cliVersion,
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
	};

	const text = renderDoctorText(diagnosis, true);

	assert.match(text, /Missing capabilities Alice: member\.request_start/);
});

test("doctor text gives an actionable next step for an incompatible Member", () => {
	const diagnosis: DoctorResult = {
		status: "issues",
		cli: cliVersion,
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
	};

	const text = renderDoctorText(diagnosis, false);

	assert.match(text, /Alice \(developer\): incompatible-runtime/);
	assert.match(text, /Next: Update pi-bebop, restart the affected Member, then rerun `bebop doctor`\./);
	assert.doesNotMatch(text, /member\.request|sockets|sessionId/);
});
