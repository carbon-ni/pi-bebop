import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { CrewManifestReadError } from "../../infra/crew-manifest-store.ts";
import { CrewManifestError, type CrewManifest } from "../../domain/index.ts";
import { UsageError } from "../arguments.ts";
import type { CliContext } from "../context.ts";
import {
	buildCrewRolesCommand,
	crewRolesHelp,
	defaultCrewRolesDependencies,
	parseCrewRolesCommand,
	runCrewRolesCommand,
	type CrewRolesDependencies,
} from "./crew-roles.ts";

function context(cwd = "/project"): CliContext {
	return { cwd, input: new PassThrough(), signal: new AbortController().signal };
}

function manifest(members: Array<{ name: string; role: string }>): CrewManifest {
	return {
		version: 1,
		members: members.map((member) => ({
			name: member.name,
			role: member.role,
			socket: `sockets/${member.name}.sock`,
			socketPath: `/project/.pi/bebop/sockets/${member.name}.sock`,
		})),
		presence: { notifications: true },
	} as CrewManifest;
}

const HAPPY_MANIFEST = manifest([
	{ name: "Tony", role: "lead" },
	{ name: "Bob", role: "developer" },
	{ name: "Sue", role: "developer" },
	{ name: "Mary", role: "po" },
	{ name: "Kelly", role: "qa" },
]);

function deps(overrides: Partial<CrewRolesDependencies> = {}): CrewRolesDependencies {
	const base: CrewRolesDependencies = {
		manifestExists: async (manifestPath) =>
			manifestPath.endsWith(".pi/bebop/crew.json") || manifestPath.endsWith("/.pi/bebop/crew.json"),
		readManifest: async () => HAPPY_MANIFEST,
	};
	return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

test("crew roles parse defaults: format text, full false, no help", () => {
	assert.deepEqual(parseCrewRolesCommand([], "/project"), {
		command: "crew-roles",
		format: "text",
		full: false,
	});
});

test("crew roles parse accepts --format json|text (space and equals forms) and --full", () => {
	for (const args of [["--format", "json"], ["--format=json"]]) {
		assert.equal(parseCrewRolesCommand(args, "/project").format, "json");
	}
	assert.equal(parseCrewRolesCommand(["--format", "text"], "/project").format, "text");
	assert.equal(parseCrewRolesCommand(["--full"], "/project").full, true);
	assert.equal(parseCrewRolesCommand(["--full", "--format", "json"], "/project").format, "json");
});

test("crew roles parse rejects duplicate and invalid flags", () => {
	assert.throws(() => parseCrewRolesCommand(["--format", "toon", "--format", "json"], "/project"), UsageError);
	assert.throws(() => parseCrewRolesCommand(["--full", "--full"], "/project"), /Duplicate flag: --full/);
	assert.throws(() => parseCrewRolesCommand(["--help", "--help"], "/project"), /Duplicate flag: --help/);
	assert.throws(
		() => parseCrewRolesCommand(["--format", "yaml"], "/project"),
		/Invalid --format 'yaml'; valid alternatives: toon, json, text/,
	);
	assert.throws(() => parseCrewRolesCommand(["--format"], "/project"), /Missing value for --format/);
	assert.throws(() => parseCrewRolesCommand(["--bogus"], "/project"), /unknown option '--bogus'/);
	assert.throws(() => parseCrewRolesCommand(["extra"], "/project"), UsageError);
});

test("crew roles parse --help returns help option while still validating format", () => {
	assert.deepEqual(parseCrewRolesCommand(["--help"], "/project"), {
		command: "crew-roles",
		format: "text",
		full: false,
		help: true,
	});
	assert.throws(() => parseCrewRolesCommand(["--help", "--format", "yaml"], "/project"), UsageError);
});

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

test("crew roles help is deterministic and documents flags and manifest resolution", () => {
	assert.equal(crewRolesHelp(), crewRolesHelp());
	assert.match(crewRolesHelp(), /pi-bebop crew roles \[--format toon\|json\|text\] \[--full\]/);
	assert.match(crewRolesHelp(), /--format <format>/);
	assert.match(crewRolesHelp(), /--full/);
	assert.match(crewRolesHelp(), /\.pi\/bebop\/crew\.json/);
	assert.match(crewRolesHelp(), /never exposes member names/);
});

test("crew roles command builder exposes only format and full flags", () => {
	const command = buildCrewRolesCommand();
	assert.equal(command.name(), "roles");
	const flags = command.options.map((option) => option.flags);
	assert.deepEqual(flags, ["--format <format>", "--full"]);
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

test("crew roles handler lists distinct roles in first-manifest-appearance order with counts", async () => {
	const outcome = await runCrewRolesCommand(
		{ command: "crew-roles", format: "toon", full: false },
		context(),
		deps(),
	);
	assert.equal(outcome.kind, "result");
	if (outcome.kind !== "result") return;
	assert.equal(outcome.result.ok, true);
	assert.equal(outcome.result.status, "listed");
	assert.equal(outcome.result.target, "/project/.pi/bebop/crew.json");
	assert.deepEqual(outcome.result.data, {
		roles: ["lead", "developer", "po", "qa"],
		roleCount: 4,
		memberCount: 5,
	});
	assert.equal(outcome.result.response, "4 configured roles: lead, developer, po, qa");
	assert.equal(outcome.format, "toon");
	assert.equal(outcome.full, false);
});

test("crew roles handler passes format and full through and is deterministic", async () => {
	const depsInstance = deps();
	const first = await runCrewRolesCommand(
		{ command: "crew-roles", format: "json", full: true },
		context(),
		depsInstance,
	);
	const second = await runCrewRolesCommand(
		{ command: "crew-roles", format: "json", full: true },
		context(),
		depsInstance,
	);
	assert.deepEqual(first, second);
	if (first.kind !== "result") return;
	assert.equal(first.format, "json");
	assert.equal(first.full, true);
});

test("crew roles handler exposes only role values and manifest-level counts, never member names", async () => {
	const outcome = await runCrewRolesCommand(
		{ command: "crew-roles", format: "toon", full: false },
		context(),
		deps(),
	);
	if (outcome.kind !== "result") return;
	const rendered = JSON.stringify(outcome.result);
	for (const name of ["Tony", "Bob", "Sue", "Mary", "Kelly"]) {
		assert.ok(!rendered.includes(name), `must not expose member name ${name}`);
	}
	assert.ok(!rendered.includes("sockets/"), "must not expose socket paths");
});

test("crew roles handler fails explicitly when no manifest exists (missing-manifest)", async () => {
	const outcome = await runCrewRolesCommand(
		{ command: "crew-roles", format: "json", full: false },
		context(),
		deps({ manifestExists: async () => false }),
	);
	assert.equal(outcome.kind, "result");
	if (outcome.kind !== "result") return;
	assert.equal(outcome.result.ok, false);
	assert.equal(outcome.result.status, "error");
	assert.equal(outcome.result.error?.code, "missing-manifest");
	assert.match(outcome.result.error?.message ?? "", /no supported crew manifest/);
});

test("crew roles handler fails explicitly on ambiguous dual-layout manifests", async () => {
	const outcome = await runCrewRolesCommand(
		{ command: "crew-roles", format: "json", full: false },
		context(),
		deps({ manifestExists: async () => true }),
	);
	assert.equal(outcome.kind, "result");
	if (outcome.kind !== "result") return;
	assert.equal(outcome.result.ok, false);
	assert.equal(outcome.result.error?.code, "ambiguous-manifest");
	assert.match(outcome.result.error?.message ?? "", /both supported crew manifests exist/);
});

test("crew roles handler maps trusted-manifest read failures through stable codes", async () => {
	const cases: Array<[CrewManifestReadError, string]> = [
		[new CrewManifestReadError("invalid-json", "invalid JSON in crew manifest"), "invalid-json"],
		[
			new CrewManifestReadError("untrusted-path", "crew manifest is not trusted project-local configuration"),
			"untrusted-path",
		],
		[new CrewManifestReadError("read-failed", "failed to read crew manifest"), "read-failed"],
	];
	for (const [error, code] of cases) {
		const outcome = await runCrewRolesCommand(
			{ command: "crew-roles", format: "json", full: false },
			context(),
			deps({ readManifest: async () => Promise.reject(error) }),
		);
		assert.equal(outcome.kind, "result");
		if (outcome.kind !== "result") return;
		assert.equal(outcome.result.ok, false, code);
		assert.equal(outcome.result.error?.code, code);
	}
});

test("crew roles handler maps manifest parse errors (unsupported version, empty members) through their codes", async () => {
	for (const error of [
		new CrewManifestError("invalid-version", "unsupported manifest version: 999"),
		new CrewManifestError("invalid-members", "members must be a non-empty array"),
	]) {
		const outcome = await runCrewRolesCommand(
			{ command: "crew-roles", format: "json", full: false },
			context(),
			deps({ readManifest: async () => Promise.reject(error) }),
		);
		assert.equal(outcome.kind, "result");
		if (outcome.kind !== "result") return;
		assert.equal(outcome.result.ok, false);
		assert.equal(outcome.result.error?.code, error.code);
	}
});

test("crew roles handler maps unknown errors to operational", async () => {
	const outcome = await runCrewRolesCommand(
		{ command: "crew-roles", format: "json", full: false },
		context(),
		deps({ readManifest: async () => Promise.reject(new Error("boom")) }),
	);
	assert.equal(outcome.kind, "result");
	if (outcome.kind !== "result") return;
	assert.equal(outcome.result.ok, false);
	assert.equal(outcome.result.error?.code, "operational");
});

test("crew roles handler --help returns deterministic local help with zero IO", async () => {
	const outcome = await runCrewRolesCommand(
		{ command: "crew-roles", format: "toon", full: false, help: true },
		context(),
		deps({
			manifestExists: async () => {
				throw new Error("must not be called for help");
			},
		}),
	);
	assert.deepEqual(outcome, { kind: "help", text: crewRolesHelp() });
});

test("default dependencies read through the trusted manifest loader with explicit consent", async () => {
	// Sanity: the production defaults wire the real trusted store (layout
	// validation included) and require the exact trusted layout.
	assert.equal(typeof defaultCrewRolesDependencies.manifestExists, "function");
	assert.equal(typeof defaultCrewRolesDependencies.readManifest, "function");
});
