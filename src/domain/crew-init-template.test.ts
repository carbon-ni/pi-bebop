import test from "node:test";
import assert from "node:assert/strict";
import {
	adoptedBytesFromTemplate,
	adoptedManagedPaths,
	classifyTemplateSource,
	describeTemplateSource,
	selectTemplateRoot,
	validateTemplate,
	type TemplateEntries,
	type TemplateEntry,
	type TemplateSourceDescriptor,
} from "./crew-init-template.ts";
import { classifyCrewInitTarget, crewInitTemplateBytes, type CrewInitFSSnapshot } from "./crew-init.ts";

const validManifest = JSON.stringify(
	{
		version: 1,
		presence: { notifications: false },
		members: [
			{
				name: "captain",
				role: "lead",
				description: "Runs the ship",
				socket: "sockets/captain.sock",
				instructionsFile: "instructions/captain.md",
			},
		],
	},
	null,
	2,
);

const file = (bytes: string): TemplateEntry => ({ kind: "file", bytes });

const validFiles = (extra: TemplateEntries = {}): TemplateEntries => ({
	"instructions/": { kind: "directory" },
	"crew.json": file(validManifest),
	"instructions/captain.md": file("# Captain\n"),
	...extra,
});

// ---------------------------------------------------------------------------
// classifyTemplateSource
// ---------------------------------------------------------------------------

test("classifyTemplateSource recognizes git URL shapes", () => {
	const git: readonly string[] = [
		"https://github.com/acme/crew-shapes.git",
		"http://example.com/t.git",
		"ssh://git@github.com/acme/t.git",
		"git@github.com:acme/t.git",
		"https://host/repo.git/",
		"ftp://example.com/t",
	];
	for (const value of git) {
		const source = classifyTemplateSource(value);
		assert.equal(source.kind, "git", value);
		assert.equal(source.location, value);
	}
});

test("classifyTemplateSource treats filesystem-looking values as local", () => {
	const local: readonly string[] = [
		"../my-crew-template",
		"/abs/path/template",
		"./template",
		"template",
		"~/crew-shapes",
	];
	for (const value of local) {
		const source = classifyTemplateSource(value);
		assert.equal(source.kind, "local", value);
		assert.equal(source.location, value);
	}
});

// ---------------------------------------------------------------------------
// selectTemplateRoot
// ---------------------------------------------------------------------------

test("selectTemplateRoot prefers the template/ subdir when it holds crew.json", () => {
	const root = selectTemplateRoot(["README.md", "crew.json", "template/crew.json", "template/instructions/a.md"]);
	assert.deepEqual(root, { ok: true, root: "template/" });
});

test("selectTemplateRoot falls back to the repository root", () => {
	const root = selectTemplateRoot(["README.md", "crew.json", "instructions/a.md"]);
	assert.deepEqual(root, { ok: true, root: "" });
});

test("selectTemplateRoot fails with a stable code when no crew.json exists", () => {
	const root = selectTemplateRoot(["README.md", "docs/x.md"]);
	assert.equal(root.ok, false);
	if (!root.ok) {
		assert.equal(root.code, "template-not-found");
		assert.match(root.message, /crew\.json/);
	}
});

// ---------------------------------------------------------------------------
// validateTemplate (strict, before any write)
// ---------------------------------------------------------------------------

test("validateTemplate accepts a valid template and returns the parsed manifest", () => {
	const verdict = validateTemplate(validFiles());
	assert.equal(verdict.ok, true);
	if (verdict.ok) {
		assert.equal(verdict.manifest.members.length, 1);
		assert.equal(verdict.manifest.members[0]?.name, "captain");
	}
});

test("validateTemplate rejects malformed manifest JSON with a stable code", () => {
	const verdict = validateTemplate({ "crew.json": file("{ not json"), "instructions/captain.md": file("x\n") });
	assert.equal(verdict.ok, false);
	if (!verdict.ok) {
		assert.equal(verdict.code, "template-invalid-manifest");
		assert.match(verdict.message, /crew\.json/);
	}
});

test("validateTemplate surfaces parseCrewManifest strictness verbatim", () => {
	const bad = JSON.stringify({ version: 2, members: [] });
	const verdict = validateTemplate({ "crew.json": file(bad), "instructions/captain.md": file("x\n") });
	assert.equal(verdict.ok, false);
	if (!verdict.ok) {
		assert.equal(verdict.code, "template-invalid-manifest:invalid-version");
	}
});

test("validateTemplate rejects a referenced instruction file that is missing", () => {
	const verdict = validateTemplate({ "crew.json": file(validManifest) });
	assert.equal(verdict.ok, false);
	if (!verdict.ok) {
		assert.equal(verdict.code, "template-missing-instruction");
		assert.match(verdict.message, /instructions\/captain\.md/);
	}
});

test("validateTemplate rejects symlinked manifests and referenced instructions without following them", () => {
	const symlinkedManifest = validateTemplate({ "crew.json": { kind: "symlink" } });
	assert.equal(symlinkedManifest.ok, false);
	if (!symlinkedManifest.ok) assert.equal(symlinkedManifest.code, "template-not-found");

	const symlinkedInstruction = validateTemplate({
		"crew.json": file(validManifest),
		"instructions/captain.md": { kind: "symlink" },
	});
	assert.equal(symlinkedInstruction.ok, false);
	if (!symlinkedInstruction.ok) {
		assert.equal(symlinkedInstruction.code, "template-symlinked-path");
		assert.match(symlinkedInstruction.message, /instructions\/captain\.md/);
	}
});

test("validateTemplate rejects a referenced instruction that is a directory", () => {
	const verdict = validateTemplate({
		"crew.json": file(validManifest),
		"instructions/": { kind: "directory" },
		"instructions/captain.md": { kind: "directory" },
	});
	assert.equal(verdict.ok, false);
	if (!verdict.ok) assert.equal(verdict.code, "template-missing-instruction");
});

test("validateTemplate rejects every runtime-owned path, naming it", () => {
	const cases: readonly [string, TemplateEntries][] = [
		["sockets", { "sockets/lead.sock": file("x") }],
		["inbox", { "inbox/pending.json": file("x") }],
		[".gitignore", { ".gitignore": file("x") }],
		["sockets directory", { "sockets/": { kind: "directory" } }],
	];
	for (const [name, extra] of cases) {
		const verdict = validateTemplate(validFiles(extra));
		assert.equal(verdict.ok, false, name);
		if (!verdict.ok) {
			assert.equal(verdict.code, "template-runtime-owned-path");
			assert.ok(verdict.message.includes(name.split(" ")[0]), `${verdict.message} should name ${name}`);
		}
	}
});

test("validateTemplate accepts inline instructions without any files", () => {
	const manifest = JSON.stringify({
		version: 1,
		members: [{ name: "solo", role: "lead", socket: "sockets/solo.sock", instructions: "Be brief." }],
	});
	const verdict = validateTemplate({ "crew.json": file(manifest) });
	assert.equal(verdict.ok, true);
});

// ---------------------------------------------------------------------------
// adoptedBytesFromTemplate
// ---------------------------------------------------------------------------

test("adoptedBytesFromTemplate maps manifest and instructions into .pi/bebop, verbatim", () => {
	const files = validFiles({
		"docs/": { kind: "directory" },
		"docs/extra.md": file("ignored\n"),
		"README.md": file("ignored\n"),
	});
	const verdict = validateTemplate(files);
	assert.equal(verdict.ok, true);
	if (!verdict.ok) return;
	const adopted = adoptedBytesFromTemplate(verdict.files, verdict.manifest);
	assert.deepEqual(adopted, {
		".pi/bebop/crew.json": validManifest,
		".pi/bebop/instructions/captain.md": "# Captain\n",
	});
});

// ---------------------------------------------------------------------------
// provenance descriptor
// ---------------------------------------------------------------------------

test("adoptedManagedPaths lists root, adopted files, then the sockets dir", () => {
	const paths = adoptedManagedPaths({
		".pi/bebop/crew.json": "{}\n",
		".pi/bebop/instructions/captain.md": "# Captain\n",
	});
	assert.deepEqual(paths, [
		".pi/bebop/",
		".pi/bebop/crew.json",
		".pi/bebop/instructions/captain.md",
		".pi/bebop/sockets/",
	]);
});

test("describeTemplateSource serializes local and git provenance", () => {
	const local: TemplateSourceDescriptor = classifyTemplateSource("../t");
	assert.deepEqual(describeTemplateSource(local), { type: "local", location: "../t" });
	const git: TemplateSourceDescriptor = { ...classifyTemplateSource("https://x/t.git"), resolvedCommit: "abc123" };
	assert.deepEqual(describeTemplateSource(git), {
		type: "git",
		location: "https://x/t.git",
		resolvedRef: "abc123",
	});
});

// ---------------------------------------------------------------------------
// classifyCrewInitTarget parameterized with template bytes
// ---------------------------------------------------------------------------

const templateBytes = {
	".pi/bebop/crew.json": "{}\n",
	".pi/bebop/instructions/captain.md": "# Captain\n",
};

const snapshotWith = (
	paths: Record<string, { kind: "file" | "directory" | "symlink" | "missing"; bytes?: string }>,
	rootKind: CrewInitFSSnapshot["readRootKind"] extends () => infer R ? R : never = "directory",
): CrewInitFSSnapshot => ({
	readRootKind: () => rootKind,
	readPath: (relative) => paths[relative] ?? { kind: "missing" },
});

test("classifyCrewInitTarget defaults to the built-in template bytes", () => {
	const paths: Record<string, { kind: "file" | "directory"; bytes?: string }> = {
		".pi/bebop/": { kind: "directory" },
		".pi/bebop/sockets/": { kind: "directory" },
	};
	for (const [relative, bytes] of Object.entries(crewInitTemplateBytes())) paths[relative] = { kind: "file", bytes };
	const verdict = classifyCrewInitTarget(snapshotWith(paths));
	assert.deepEqual(verdict, { kind: "unchanged" });
});

test("classifyCrewInitTarget classifies adopted template bytes: created, unchanged, differs", () => {
	const plan = {
		bytes: templateBytes,
		managedPaths: [".pi/bebop/", ".pi/bebop/crew.json", ".pi/bebop/instructions/captain.md", ".pi/bebop/sockets/"],
	};
	const missing = classifyCrewInitTarget(snapshotWith({}), plan);
	assert.deepEqual(missing, { kind: "created" });

	const exact = classifyCrewInitTarget(
		snapshotWith({
			".pi/bebop/": { kind: "directory" },
			".pi/bebop/crew.json": { kind: "file", bytes: "{}\n" },
			".pi/bebop/instructions/captain.md": { kind: "file", bytes: "# Captain\n" },
			".pi/bebop/sockets/": { kind: "directory" },
		}),
		plan,
	);
	assert.deepEqual(exact, { kind: "unchanged" });

	const differs = classifyCrewInitTarget(
		snapshotWith({
			".pi/bebop/": { kind: "directory" },
			".pi/bebop/crew.json": { kind: "file", bytes: "{}\n" },
			".pi/bebop/instructions/captain.md": { kind: "file", bytes: "# Changed\n" },
			".pi/bebop/sockets/": { kind: "directory" },
		}),
		plan,
	);
	assert.equal(differs.kind, "conflict");
	if (differs.kind === "conflict") {
		assert.equal(differs.code, "managed-file-differs");
		assert.equal(differs.path, ".pi/bebop/instructions/captain.md");
	}
});

test("a layout adopted from a template is unchanged on rerun without .gitignore", () => {
	// .gitignore is runtime-owned and never adopted; its absence must not
	// turn a template rerun into a partial-layout conflict.
	const plan = {
		bytes: templateBytes,
		managedPaths: [".pi/bebop/", ".pi/bebop/crew.json", ".pi/bebop/instructions/captain.md", ".pi/bebop/sockets/"],
	};
	const verdict = classifyCrewInitTarget(
		snapshotWith({
			".pi/bebop/": { kind: "directory" },
			".pi/bebop/crew.json": { kind: "file", bytes: "{}\n" },
			".pi/bebop/instructions/captain.md": { kind: "file", bytes: "# Captain\n" },
			".pi/bebop/sockets/": { kind: "directory" },
		}),
		plan,
	);
	assert.deepEqual(verdict, { kind: "unchanged" });
});
