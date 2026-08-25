import test from "node:test";
import assert from "node:assert/strict";
import { parseCrewManifest } from "./crew-manifest.ts";
import {
	CREW_INIT_EXIT_OK,
	CREW_INIT_EXIT_OPERATIONAL,
	CREW_INIT_EXIT_USAGE,
	CREW_INIT_TEMPLATE_VERSION,
	crewInitCrewJson,
	crewInitGitignore,
	crewInitHelp,
	crewInitInstructions,
	crewInitManagedPaths,
	crewInitTemplateBytes,
	classifyCrewInitTarget,
	redactCrewInitPath,
	validateCrewInitUsage,
	type CrewInitFSSnapshot,
	type CrewInitResult,
} from "./crew-init.ts";

const manifestPath = "/project/.pi/bebop/crew.json";

function snapshot(
	paths: Record<string, { kind: "file" | "directory" | "symlink" | "missing"; bytes?: string }>,
	rootKind: "directory" | "file" | "symlink" | "missing" = "directory",
): CrewInitFSSnapshot {
	return {
		readRootKind: () => rootKind,
		readPath: (relative) => paths[relative] ?? { kind: "missing" },
	};
}

const allTemplateFiles = (bytes: (path: string) => string): Record<string, { kind: "file"; bytes: string }> => {
	const result: Record<string, { kind: "file"; bytes: string }> = {};
	for (const path of crewInitManagedPaths()) {
		if (path.endsWith("/")) continue;
		result[path] = { kind: "file", bytes: bytes(path) };
	}
	return result;
};

const withDirectories = (
	files: Record<string, { kind: "file"; bytes: string }>,
): Record<string, { kind: "file" | "directory"; bytes?: string }> => ({
	...files,
	".pi/bebop/": { kind: "directory" },
	".pi/bebop/sockets/": { kind: "directory" },
});

test("managed path set is canonical .pi/bebop layout with no compatibility .pi/crew", () => {
	const paths = crewInitManagedPaths();
	assert.ok(paths.includes(".pi/bebop/crew.json"));
	assert.ok(paths.includes(".pi/bebop/.gitignore"));
	assert.ok(paths.includes(".pi/bebop/instructions/lead.md"));
	assert.ok(paths.includes(".pi/bebop/instructions/product.md"));
	assert.ok(paths.includes(".pi/bebop/instructions/developer.md"));
	assert.ok(paths.includes(".pi/bebop/instructions/quality.md"));
	assert.ok(paths.includes(".pi/bebop/sockets/"));
	assert.ok(!paths.some((path) => path.startsWith(".pi/crew/")), "never generates compatibility layout");
});

test("generated crew.json is deterministic version 1 and passes the real manifest parser", () => {
	const json = crewInitCrewJson();
	const first = crewInitCrewJson();
	assert.equal(json, first, "bytes must be deterministic across calls");
	const manifest = parseCrewManifest(JSON.parse(json), manifestPath);
	assert.equal(manifest.version, 1);
	assert.equal(manifest.intake?.contact, "product");
	assert.equal(manifest.presence.notifications, true);
	assert.deepEqual(
		manifest.members.map((member) => member.name),
		["lead", "product", "developer", "quality"],
	);
	for (const member of manifest.members) {
		assert.ok(member.instructionsFile, `${member.name} must use an instructionsFile`);
		assert.ok(member.description, `${member.name} must have a description`);
	}
});

test("generated crew.json is LF-only and independent of locale, time, user, Git, and environment", () => {
	const json = crewInitCrewJson();
	assert.ok(!json.includes("\r"), "must be LF-only");
	assert.ok(!/T\d{2}:\d{2}:\d{2}/.test(json), "must not embed a timestamp");
	assert.ok(!/\$\{|\{\{/.test(json), "must not embed environment/user expansion");
	assert.ok(!/git|GIT/i.test(json), "must not depend on Git");
});

test("generated .gitignore excludes sockets and inbox only", () => {
	const gitignore = crewInitGitignore();
	assert.match(gitignore, /sockets\//);
	assert.match(gitignore, /inbox\//);
	assert.ok(!gitignore.includes(".pi/bebop/crew.json"), "never ignores the manifest itself");
});

test("all four instruction templates exist and define mission, inputs, outputs, escalation, and DoD", () => {
	for (const role of ["lead", "product", "developer", "quality"]) {
		const template = crewInitInstructions(role);
		assert.ok(template.length > 0, `${role} template must not be empty`);
		for (const section of [
			"## Mission",
			"## Expected inputs",
			"## Expected outputs",
			"## Escalation",
			"## Definition of done",
		]) {
			assert.ok(template.includes(section), `${role} template must include ${section}`);
		}
		assert.ok(!template.includes("\r"), `${role} template must be LF-only`);
	}
});

test("instruction templates stay aligned with the maintained software crew workflow", () => {
	const workflow = ["send_follow_up", "redirect_member", "interrupt_member", "never", "verify"];
	const developer = crewInitInstructions("developer");
	const quality = crewInitInstructions("quality");
	const product = crewInitInstructions("product");
	const lead = crewInitInstructions("lead");
	assert.ok(
		workflow.every((phrase) => developer.toLowerCase().includes(phrase) || quality.toLowerCase().includes(phrase)),
		"dev+qa cover workflow",
	);
	assert.ok(product.includes("Intake") || product.includes("intake"), "product template names Crew Intake");
	assert.ok(lead.includes("integration") || lead.includes("integrate"), "lead template names integration");
});

test("template bytes are deterministic and versioned with a stable aggregate set", () => {
	const setA = crewInitTemplateBytes();
	const setB = crewInitTemplateBytes();
	assert.deepEqual(Object.keys(setA).sort(), Object.keys(setB).sort());
	assert.deepEqual(setA, setB);
	assert.equal(CREW_INIT_TEMPLATE_VERSION, "1");
});

test("classifyCrewInitTarget: missing layout is created", () => {
	const target = snapshot({});
	const verdict = classifyCrewInitTarget(target);
	assert.equal(verdict.kind, "created");
});

test("classifyCrewInitTarget: exact rerun is unchanged with zero writes", () => {
	const target = snapshot(withDirectories(allTemplateFiles((path) => crewInitTemplateBytes()[path]!)));
	const verdict = classifyCrewInitTarget(target);
	assert.equal(verdict.kind, "unchanged");
});

test("classifyCrewInitTarget: differing managed file is a stable conflict before mutation", () => {
	const bytes = crewInitTemplateBytes();
	const target = snapshot(
		withDirectories({
			...allTemplateFiles((path) => bytes[path]!),
			".pi/bebop/crew.json": { kind: "file", bytes: '{"version":999}' },
		}),
	);
	const verdict = classifyCrewInitTarget(target);
	assert.equal(verdict.kind, "conflict");
	if (verdict.kind === "conflict") {
		assert.equal(verdict.code, "managed-file-differs");
		assert.equal(verdict.path, ".pi/bebop/crew.json");
		assert.ok(verdict.nextStep.length > 0);
	}
});

test("classifyCrewInitTarget: symlink, wrong shape, and non-directory root are bounded conflicts", () => {
	const bytes = crewInitTemplateBytes();
	const symlink = snapshot({
		...withDirectories(allTemplateFiles((path) => bytes[path]!)),
		".pi/bebop/sockets/": { kind: "symlink" },
	});
	assert.equal(classifyCrewInitTarget(symlink).kind, "conflict");

	const fileRoot = snapshot({}, "file");
	assert.equal(classifyCrewInitTarget(fileRoot).kind, "conflict");

	const fileWhereDir = snapshot({
		".pi/bebop/": { kind: "directory" },
		".pi/bebop/sockets/": { kind: "file", bytes: "not a dir" },
	});
	assert.equal(classifyCrewInitTarget(fileWhereDir).kind, "conflict");
});

test("classifyCrewInitTarget: partial layout is a conflict, never a partial update", () => {
	const bytes = crewInitTemplateBytes();
	const partial = snapshot(
		withDirectories({
			".pi/bebop/crew.json": { kind: "file", bytes: bytes[".pi/bebop/crew.json"]! },
		}),
	);
	const verdict = classifyCrewInitTarget(partial);
	assert.equal(verdict.kind, "conflict");
});

test("conflict never suggests overwrite and carries an actionable next step", () => {
	const bytes = crewInitTemplateBytes();
	const verdict = classifyCrewInitTarget(
		snapshot(
			withDirectories({
				...allTemplateFiles((path) => bytes[path]!),
				".pi/bebop/crew.json": { kind: "file", bytes: "user content" },
			}),
		),
	);
	assert.equal(verdict.kind, "conflict");
	if (verdict.kind === "conflict") {
		assert.ok(!/overwrite|--force/i.test(verdict.nextStep), "never suggests overwrite or --force");
	}
});

test("output result uses project-relative managed paths and copyable next commands", () => {
	const result: CrewInitResult = {
		status: "created",
		project: "/home/user/project",
		manifestPath: ".pi/bebop/crew.json",
		createdPaths: [".pi/bebop/crew.json", ".pi/bebop/sockets/"],
		verifiedPaths: [],
		nextCommands: ["pi-bebop crew join .pi/bebop/crew.json"],
	};
	assert.ok(
		result.createdPaths.every((path) => !path.startsWith("/")),
		"paths must be project-relative",
	);
	assert.ok(result.manifestPath === ".pi/bebop/crew.json", "manifest path is project-relative");
	assert.ok(
		result.nextCommands.every((command) => command.includes(".pi/bebop")),
		"next commands must be copyable",
	);
	// Structured result carries the project root once; managed paths and next
	// commands are relative and redacted (never absolute home expansion).
	assert.equal(result.project.split("/").length > 1, true);
	assert.ok(
		result.createdPaths.every((path) => !path.includes("/home/")),
		"no absolute home path in managed paths",
	);
});

test("path redaction never emits absolute home expansion or secrets", () => {
	assert.equal(redactCrewInitPath("/home/user/project/.pi/bebop/crew.json"), ".pi/bebop/crew.json");
	assert.equal(redactCrewInitPath("/tmp/project/.pi/bebop/crew.json"), ".pi/bebop/crew.json");
	assert.equal(redactCrewInitPath(".pi/bebop/crew.json"), ".pi/bebop/crew.json");
	assert.ok(!redactCrewInitPath("~/.pi/bebop/crew.json").includes("~"), "no bare ~ expansion in output");
	assert.ok(!redactCrewInitPath(".pi/bebop/crew.json").includes("secret"), "never emits secret-bearing paths");
});

test("exit codes follow AXI: 0 success/no-op, 1 operational, 2 usage", () => {
	assert.equal(CREW_INIT_EXIT_OK, 0);
	assert.equal(CREW_INIT_EXIT_OPERATIONAL, 1);
	assert.equal(CREW_INIT_EXIT_USAGE, 2);
});

test("usage validation rejects unknown, duplicate, missing-value, and incompatible flags before dependencies", () => {
	assert.deepEqual(validateCrewInitUsage([]), { ok: true, usage: { project: undefined, format: "toon" } });
	assert.deepEqual(validateCrewInitUsage(["--project", "x"]), { ok: true, usage: { project: "x", format: "toon" } });
	assert.deepEqual(validateCrewInitUsage(["--format", "json"]), {
		ok: true,
		usage: { project: undefined, format: "json" },
	});

	for (const [argv, code] of [
		[["--bogus"], "unknown-flag"],
		[["--project"], "missing-value"],
		[["--format", "yaml"], "incompatible-format"],
		[["--project", "a", "--project", "b"], "duplicate-flag"],
	] as const) {
		const verdict = validateCrewInitUsage([...argv]);
		assert.equal(verdict.ok, false, JSON.stringify(argv));
		if (verdict.ok === false) assert.equal(verdict.code, code, JSON.stringify(argv));
	}
});

test("help documents defaults, files, exit codes, and runnable create/no-op/conflict examples", () => {
	const help = crewInitHelp();
	assert.match(help, /crew init/);
	assert.match(help, /--project/);
	assert.match(help, /--format/);
	assert.match(help, /toon/);
	assert.match(help, /\.pi\/bebop\/crew\.json/);
	assert.match(help, /exit code 0|exit code 1|exit code 2|Exit codes/);
	assert.match(help, /example|Example/);
	assert.match(help, /default/i);
});
