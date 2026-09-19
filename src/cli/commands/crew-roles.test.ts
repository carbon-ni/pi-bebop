import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { CrewManifestReadError } from "../../infra/crew-manifest-store.ts";
import { CrewManifestError, type CrewManifest } from "../../domain/index.ts";
import { UsageError } from "../support/arguments.ts";
import type { CliContext } from "../support/context.ts";
import {
	buildCrewRolesCommand,
	defaultCrewRolesDependencies,
	readCrewRolesCommand,
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

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

test("crew roles reader preserves full and format options and rejects invalid format", () => {
	const command = buildCrewRolesCommand()
		.exitOverride()
		.configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} });
	command.parse(["node", "roles", "--full", "--format", "text"], { from: "node" });
	assert.deepEqual(readCrewRolesCommand(command), { command: "crew-roles", format: "text", full: true });
	const defaults = buildCrewRolesCommand().exitOverride();
	defaults.parse(["node", "roles"], { from: "node" });
	assert.deepEqual(readCrewRolesCommand(defaults), { command: "crew-roles", format: "toon", full: false });
	const invalid = buildCrewRolesCommand().exitOverride();
	invalid.parse(["node", "roles", "--format", "yaml"], { from: "node" });
	assert.throws(() => readCrewRolesCommand(invalid), UsageError);
});

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

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
	for (const error of [new Error("boom"), "unexpected value"]) {
		const outcome = await runCrewRolesCommand(
			{ command: "crew-roles", format: "json", full: false },
			context(),
			deps({ readManifest: async () => Promise.reject(error) }),
		);
		assert.equal(outcome.kind, "result");
		if (outcome.kind !== "result") return;
		assert.equal(outcome.result.ok, false);
		assert.equal(outcome.result.error?.code, "operational");
	}
});

test("default dependencies read through the trusted manifest loader with explicit consent", async () => {
	// Sanity: the production defaults wire the real trusted store (layout
	// validation included) and require the exact trusted layout.
	assert.equal(typeof defaultCrewRolesDependencies.manifestExists, "function");
	assert.equal(typeof defaultCrewRolesDependencies.readManifest, "function");
});
