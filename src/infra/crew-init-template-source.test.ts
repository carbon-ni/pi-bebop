import test from "node:test";
import assert from "node:assert/strict";
import {
	createGitTemplateSourceAdapter,
	createLocalTemplateSourceAdapter,
	readTemplateEntries,
	resolveTemplateSourceDescriptor,
	TEMPLATE_MAX_FILE_BYTES,
	type GitRunner,
	type LocalTemplateFs,
} from "./crew-init-template-source.ts";

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

type FakeNode = string | { symlink: true } | { dir: true };

function fakeFs(tree: Record<string, FakeNode>): LocalTemplateFs {
	return {
		async readdir(dir) {
			const prefix = dir.replace(/\/$/, "") + "/";
			const children = new Set<string>();
			for (const key of Object.keys(tree)) {
				if (!key.startsWith(prefix)) continue;
				const rest = key.slice(prefix.length);
				if (rest === "") continue;
				children.add(rest.split("/")[0]!);
			}
			return [...children].sort().map((name) => {
				const node = tree[`${prefix}${name}`];
				const kind =
					node === undefined
						? undefined
						: typeof node === "string"
							? "file"
							: "symlink" in node
								? "symlink"
								: "dir";
				return {
					name,
					isFile: () => kind === "file",
					isDirectory: () => kind === "dir",
					isSymbolicLink: () => kind === "symlink",
				};
			});
		},
		async readFile(file) {
			const node = tree[file];
			if (typeof node !== "string") throw Object.assign(new Error("not a file"), { code: "ENOTDIR" });
			return node;
		},
	};
}

const validManifest = JSON.stringify({
	version: 1,
	members: [
		{ name: "captain", role: "lead", socket: "sockets/captain.sock", instructionsFile: "instructions/captain.md" },
	],
});

const validTree: Record<string, FakeNode> = {
	"root/crew.json": validManifest,
	"root/instructions": { dir: true },
	"root/instructions/captain.md": "# Captain\n",
};

const gitRunner = (
	script: (args: readonly string[]) => { status: number; stdout?: string; stderr?: string } | Promise<void>,
) => {
	const calls: string[][] = [];
	const runner: GitRunner = async (args) => {
		calls.push([...args]);
		const step = await script([...args]);
		if (!step) return { status: 0, stdout: "", stderr: "" };
		return { status: step.status, stdout: step.stdout ?? "", stderr: step.stderr ?? "" };
	};
	return { runner, calls };
};

const fakeGitDeps = (runner: GitRunner, fs: LocalTemplateFs) => {
	const log: string[] = [];
	return {
		deps: {
			runner,
			fs,
			mkdtemp: async () => {
				log.push("mkdtemp");
				return "/tmp/fake-clone";
			},
			rm: async (dir: string) => {
				log.push(`rm:${dir}`);
			},
		},
		log,
	};
};

// ---------------------------------------------------------------------------
// reader
// ---------------------------------------------------------------------------

test("readTemplateEntries walks the tree, records dirs with /, and skips .git", async () => {
	const fs = fakeFs({
		...validTree,
		"root/.git": { dir: true },
		"root/.git/HEAD": "ref: refs/heads/main\n",
		"root/docs": { dir: true },
		"root/docs/readme.md": "docs\n",
		"root/link.md": { symlink: true },
	});
	const result = await readTemplateEntries("/src/root", {
		readdir: (dir) => fs.readdir(dir.replace("/src/", "")),
		readFile: (file) => fs.readFile(file.replace("/src/", "")),
	});
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.deepEqual(result.entries, {
		"crew.json": { kind: "file", bytes: validManifest },
		"docs/": { kind: "directory" },
		"docs/readme.md": { kind: "file", bytes: "docs\n" },
		"instructions/": { kind: "directory" },
		"instructions/captain.md": { kind: "file", bytes: "# Captain\n" },
		"link.md": { kind: "symlink" },
	});
});

test("readTemplateEntries enforces file-count and depth bounds with a stable code", async () => {
	const many: Record<string, FakeNode> = {};
	for (let index = 0; index < 70; index += 1) many[`root/f${index}.txt`] = "x";
	const manyFs = {
		readdir: (dir: string) => fakeFs(many).readdir(dir.replace("/src/", "")),
		readFile: (file: string) => fakeFs(many).readFile(file.replace("/src/", "")),
	};
	const count = await readTemplateEntries("/src/root", manyFs);
	assert.equal(count.ok, false);
	if (!count.ok) assert.equal(count.code, "template-source-too-large");

	const deep: Record<string, FakeNode> = {
		"root/a": { dir: true },
		"root/a/b": { dir: true },
		"root/a/b/c": { dir: true },
		"root/a/b/c/d": { dir: true },
		"root/a/b/c/d/e.md": "x",
	};
	const deepFs = {
		readdir: (dir: string) => fakeFs(deep).readdir(dir.replace("/src/", "")),
		readFile: (file: string) => fakeFs(deep).readFile(file.replace("/src/", "")),
	};
	const depth = await readTemplateEntries("/src/root", deepFs);
	assert.equal(depth.ok, false);
	if (!depth.ok) assert.equal(depth.code, "template-source-too-large");
});

// ---------------------------------------------------------------------------
// local adapter
// ---------------------------------------------------------------------------

const localAdapterFs = (tree: Record<string, FakeNode>) => {
	const base = fakeFs(tree);
	const rel = (abs: string) => `root${abs.replace(/^\/cwd\/my-template/, "")}`;
	return {
		readdir: (dir: string) => base.readdir(rel(dir)),
		readFile: (file: string) => base.readFile(rel(file)),
	};
};

test("local adapter reads a relative location against cwd (L1)", async () => {
	const adapter = createLocalTemplateSourceAdapter(localAdapterFs(validTree));
	const result = await adapter.read({ kind: "local", location: "../my-template" }, { cwd: "/cwd/project" });
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.ok("crew.json" in result.entries);
		assert.deepEqual(result.descriptor, { kind: "local", location: "../my-template" });
		assert.ok(!JSON.stringify(result).includes("/cwd"), "resolved absolute path never leaks into provenance");
	}
});

test("template byte limits count UTF-8 bytes, not JavaScript code units", async () => {
	const multibyte = "é".repeat(Math.floor(TEMPLATE_MAX_FILE_BYTES / 2) + 1);
	const result = await readTemplateEntries("/src/root", {
		readdir: async () => [
			{ name: "large.md", isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
		],
		readFile: async () => multibyte,
	});
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.code, "template-source-too-large");
});

test("local adapter reports missing and non-directory sources without absolute paths (V1)", async () => {
	const adapter = createLocalTemplateSourceAdapter({
		readdir: async () => {
			throw Object.assign(new Error("nope"), { code: "ENOENT" });
		},
		readFile: async () => "",
	});
	const missing = await adapter.read({ kind: "local", location: "../gone" }, { cwd: "/cwd" });
	assert.equal(missing.ok, false);
	if (!missing.ok) {
		assert.equal(missing.code, "template-source-unreadable");
		assert.equal(missing.message, "Template source not found: ../gone");
		assert.ok(!missing.message.includes("/cwd"));
	}
});

// ---------------------------------------------------------------------------
// source-kind resolution (boundary 3: no fallback)
// ---------------------------------------------------------------------------

test("resolveTemplateSourceDescriptor keeps explicit paths local and URLs git; ambiguous .git prefers an existing directory", async () => {
	const statDir = async (abs: string) => abs === "/cwd/vendored/team.git";
	assert.deepEqual(await resolveTemplateSourceDescriptor("./team.git", "/cwd", statDir), {
		kind: "local",
		location: "./team.git",
	});
	assert.deepEqual(await resolveTemplateSourceDescriptor("vendored/team.git", "/cwd", statDir), {
		kind: "local",
		location: "vendored/team.git",
	});
	assert.deepEqual(await resolveTemplateSourceDescriptor("acme/team.git", "/cwd", statDir), {
		kind: "git",
		location: "acme/team.git",
	});
	assert.deepEqual(await resolveTemplateSourceDescriptor("https://host/t.git", "/cwd", statDir), {
		kind: "git",
		location: "https://host/t.git",
	});
});

// ---------------------------------------------------------------------------
// git adapter
// ---------------------------------------------------------------------------

const readGit = async (runner: GitRunner, ref?: string) => {
	const { deps, log } = fakeGitDeps(
		runner,
		fakeFs({ "/tmp/fake-clone/crew.json": validManifest, "/tmp/fake-clone/instructions": { dir: true } }),
	);
	const adapter = createGitTemplateSourceAdapter(deps);
	const result = await adapter.read(
		ref === undefined
			? { kind: "git", location: "https://host/t.git" }
			: { kind: "git", location: "https://host/t.git", ref },
		{ cwd: "/cwd" },
	);
	return { result, calls: (runner as { calls?: string[][] }).calls ?? [], log };
};

test("git adapter clones, checks out an explicit ref, resolves the commit, and cleans up (G1)", async () => {
	const { runner, calls } = gitRunner((args) =>
		args.includes("rev-parse")
			? { status: 0, stdout: "ABCDEF0123456789ABCDEF0123456789ABCDEF01\n" }
			: { status: 0 },
	);
	const fs = fakeFs({
		"/tmp/fake-clone/crew.json": validManifest,
		"/tmp/fake-clone/instructions": { dir: true },
		"/tmp/fake-clone/instructions/captain.md": "# Captain\n",
	});
	const { deps, log } = fakeGitDeps(runner, fs);
	const result = await createGitTemplateSourceAdapter(deps).read(
		{ kind: "git", location: "https://host/t.git", ref: "v1.2.3" },
		{ cwd: "/cwd" },
	);
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.deepEqual(result.descriptor, {
			kind: "git",
			location: "https://host/t.git",
			ref: "v1.2.3",
			resolvedCommit: "abcdef0123456789abcdef0123456789abcdef01",
		});
		assert.ok("crew.json" in result.entries);
	}
	assert.deepEqual(calls, [
		["clone", "--quiet", "--no-hardlinks", "https://host/t.git", "/tmp/fake-clone"],
		["-C", "/tmp/fake-clone", "checkout", "--quiet", "--detach", "v1.2.3"],
		["-C", "/tmp/fake-clone", "rev-parse", "HEAD"],
	]);
	assert.deepEqual(log, ["mkdtemp", "rm:/tmp/fake-clone"]);
	void readGit;
});

test("git adapter without --ref resolves the default branch commit deterministically (G2)", async () => {
	const { runner, calls } = gitRunner((args) =>
		args.includes("rev-parse") ? { status: 0, stdout: "a".repeat(40) } : { status: 0 },
	);
	const fs = fakeFs({ "/tmp/fake-clone/crew.json": validManifest });
	const { deps } = fakeGitDeps(runner, fs);
	const result = await createGitTemplateSourceAdapter(deps).read(
		{ kind: "git", location: "https://host/t.git" },
		{ cwd: "/cwd" },
	);
	assert.equal(result.ok, true);
	if (result.ok) assert.match(result.descriptor.resolvedCommit ?? "", /^[0-9a-f]{40}$/);
	assert.equal(
		calls.some((call) => call.includes("checkout")),
		false,
	);
});

test("git adapter classifies clone failures distinctly without leaking stderr (G3/G4)", async () => {
	const cases: readonly [string, string, string][] = [
		["git-unavailable", "ENOENT", ""],
		["git-network-unreachable", "clone", "fatal: could not resolve host host"],
		["git-auth-required", "clone", "fatal: could not read Username for 'https://host'"],
		["git-unsupported-url", "clone", "fatal: transport 'ftp' is not supported"],
		["git-clone-failed", "clone", "fatal: repository not found"],
	];
	for (const [expectedCode, mode, stderr] of cases) {
		const { runner } =
			mode === "ENOENT"
				? {
						runner: (async () => {
							throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
						}) as GitRunner,
					}
				: gitRunner(() => ({ status: 128, stderr }));
		const fs = fakeFs({ "/tmp/fake-clone/crew.json": validManifest });
		const { deps } = fakeGitDeps(runner, fs);
		const result = await createGitTemplateSourceAdapter(deps).read(
			{ kind: "git", location: "https://host/t.git" },
			{ cwd: "/cwd" },
		);
		assert.equal(result.ok, false, expectedCode);
		if (!result.ok) {
			assert.equal(result.code, expectedCode, expectedCode);
			assert.ok(!result.message.includes(stderr || "spawn"), `${expectedCode}: ${result.message}`);
			if (expectedCode === "git-auth-required") assert.match(result.message, /not supported/);
		}
	}
});

test("git adapter reports unknown refs and checkout failures with stable codes (G3)", async () => {
	const refNotFound = gitRunner((args) =>
		args.includes("checkout")
			? { status: 1, stderr: "error: pathspec 'v9' did not match any file(s) known to git" }
			: { status: 0, stdout: "a".repeat(40) },
	);
	const fsA = fakeFs({ "/tmp/fake-clone/crew.json": validManifest });
	const a = await createGitTemplateSourceAdapter(fakeGitDeps(refNotFound.runner, fsA).deps).read(
		{ kind: "git", location: "https://host/t.git", ref: "v9" },
		{ cwd: "/cwd" },
	);
	assert.equal(a.ok, false);
	if (!a.ok) {
		assert.equal(a.code, "git-ref-not-found");
		assert.match(a.message, /v9/);
	}

	const checkoutBroken = gitRunner((args) =>
		args.includes("checkout") ? { status: 1, stderr: "worktree corrupt" } : { status: 0, stdout: "a".repeat(40) },
	);
	const b = await createGitTemplateSourceAdapter(fakeGitDeps(checkoutBroken.runner, fsA).deps).read(
		{ kind: "git", location: "https://host/t.git", ref: "v1" },
		{ cwd: "/cwd" },
	);
	assert.equal(b.ok, false);
	if (!b.ok) assert.equal(b.code, "git-checkout-failed");
});
