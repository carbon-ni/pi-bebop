import test from "node:test";
import assert from "node:assert/strict";
import { createCrewInitFlow, type CrewInitFsAdapter, type CrewInitPathKind } from "./crew-init-flow.ts";
import type { TemplateSourceAdapter, TemplateSourceRead } from "../infra/crew-init-template-source.ts";
import type { TemplateEntries, TemplateSourceDescriptor } from "../domain/index.ts";

/**
 * `crew init --from` application-flow tests (acceptance-matrix rows).
 * All filesystem and source adapters are fakes recording every mutation;
 * zero-write assertions compare a full destination snapshot before/after.
 */

const manifest = JSON.stringify({
	version: 1,
	members: [
		{
			name: "captain",
			role: "lead",
			description: "Runs the ship",
			socket: "sockets/captain.sock",
			instructionsFile: "instructions/captain.md",
		},
	],
});

const templateEntries = (extra: TemplateEntries = {}): TemplateEntries => ({
	"crew.json": { kind: "file", bytes: manifest },
	"instructions/": { kind: "directory" },
	"instructions/captain.md": { kind: "file", bytes: "# Captain\n" },
	...extra,
});

interface FakeFs {
	kinds: Map<string, CrewInitPathKind | "staging-gone">;
	bytes: Map<string, string>;
	mutations: string[];
	clock: number;
}

function fakeFsAdapter(initial: Record<string, { kind: CrewInitPathKind; bytes?: string }> = {}) {
	const fs: FakeFs = { kinds: new Map(), bytes: new Map(), mutations: [], clock: 1 };
	for (const [path, entry] of Object.entries(initial)) {
		fs.kinds.set(path, entry.kind);
		if (entry.bytes !== undefined) fs.bytes.set(path, entry.bytes);
	}
	const adapter: CrewInitFsAdapter = {
		async readKind(abs) {
			const normalized = abs.replace(/\/+$/, "");
			return fs.kinds.get(normalized) ?? fs.kinds.get(abs) ?? "missing";
		},
		async readFile(abs) {
			return fs.bytes.get(abs);
		},
		async writeFile(abs, content) {
			fs.mutations.push(`write:${abs}`);
			fs.kinds.set(abs, "file");
			fs.bytes.set(abs, content);
		},
		async mkdir(abs) {
			fs.mutations.push(`mkdir:${abs}`);
			fs.kinds.set(abs, "directory");
		},
		async createStaging(project) {
			fs.mutations.push(`staging:${project}`);
			const staging = `${project}/.pi/.bebop-init-test`;
			fs.kinds.set(staging, "directory");
			return staging;
		},
		async publishStaging(staging, target) {
			fs.mutations.push(`publish:${staging}->${target}`);
			if (fs.kinds.get(target) === "directory") throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
			if (fs.failPublishWith) throw fs.failPublishWith;
			for (const key of [...fs.kinds.keys()]) {
				if (key.startsWith(`${staging}/`)) {
					const moved = `${target}${key.slice(staging.length)}`;
					fs.kinds.set(moved, fs.kinds.get(key)!);
					fs.kinds.delete(key);
					const content = fs.bytes.get(key);
					if (content !== undefined) {
						fs.bytes.set(moved, content);
						fs.bytes.delete(key);
					}
				}
			}
			fs.kinds.set(target, "directory");
			fs.kinds.delete(staging);
		},
		async remove(abs) {
			fs.mutations.push(`remove:${abs}`);
			fs.kinds.delete(abs);
			for (const key of [...fs.kinds.keys()]) if (key.startsWith(`${abs}/`)) fs.kinds.delete(key);
			for (const key of [...fs.bytes.keys()]) if (key.startsWith(`${abs}/`)) fs.bytes.delete(key);
		},
		async touchFile(abs) {
			fs.mutations.push(`touch:${abs}`);
		},
		async mtimeNs(abs) {
			void abs;
			return fs.clock;
		},
	};
	(fs as FakeFs & { failPublishWith?: Error }).failPublishWith = undefined;
	const snapshot = () => JSON.stringify([...fs.kinds.entries()].sort());
	return { adapter, fs: fs as FakeFs & { failPublishWith?: Error }, snapshot };
}

const sourceAdapterWith = (read: TemplateSourceRead): TemplateSourceAdapter & { calls: string[] } => {
	const calls: string[] = [];
	return {
		calls,
		async read(descriptor) {
			calls.push(descriptor.location);
			return read;
		},
	};
};

const local = { kind: "local", location: "../ship-template" } as const;
const PROJECT = "/proj";

test("from local template: created with adopted bytes and local provenance (L1, P1)", async () => {
	const { adapter, fs } = fakeFsAdapter({ [PROJECT]: { kind: "directory" } });
	const flow = createCrewInitFlow(adapter, {
		sourceAdapter: sourceAdapterWith({ ok: true, entries: templateEntries(), descriptor: local }),
	});
	const result = await flow.run(PROJECT, { from: local, cwd: "/cwd" });
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.status, "created");
	assert.deepEqual(result.source, { type: "local", location: "../ship-template" });
	assert.deepEqual([...result.createdPaths].sort(), [".pi/bebop/crew.json", ".pi/bebop/instructions/captain.md"]);
	assert.equal(fs.bytes.get(`${PROJECT}/.pi/bebop/crew.json`), manifest);
	assert.equal(fs.bytes.get(`${PROJECT}/.pi/bebop/instructions/captain.md`), "# Captain\n");
	assert.equal(fs.bytes.get(`${PROJECT}/.pi/bebop/.gitignore`), undefined); // runtime-owned, never adopted
});

test("template validation failures perform zero writes and leave the destination untouched (V1-V3)", async () => {
	const cases: readonly [string, TemplateEntries][] = [
		[
			"malformed manifest",
			{
				"crew.json": { kind: "file", bytes: "{ nope" },
				"instructions/captain.md": { kind: "file", bytes: "x\n" },
			},
		],
		["missing instruction", { "crew.json": { kind: "file", bytes: manifest } }],
		["runtime-owned socket", templateEntries({ "sockets/captain.sock": { kind: "file", bytes: "x" } })],
		["runtime-owned inbox", templateEntries({ "inbox/pending.json": { kind: "file", bytes: "x" } })],
		["runtime-owned gitignore", templateEntries({ ".gitignore": { kind: "file", bytes: "x\n" } })],
		["symlinked instruction", templateEntries({ "instructions/captain.md": { kind: "symlink" } })],
		["no manifest", { "README.md": { kind: "file", bytes: "x\n" } }],
	];
	for (const [name, entries] of cases) {
		const { adapter, fs, snapshot } = fakeFsAdapter({ [PROJECT]: { kind: "directory" } });
		const before = snapshot();
		const flow = createCrewInitFlow(adapter, {
			sourceAdapter: sourceAdapterWith({ ok: true, entries, descriptor: local }),
		});
		const result = await flow.run(PROJECT, { from: local, cwd: "/cwd" });
		assert.equal(result.ok, false, name);
		if (!result.ok) assert.ok(result.error.code.startsWith("template-"), `${name}: ${result.error.code}`);
		assert.deepEqual(fs.mutations, [], `${name}: zero mutations`);
		assert.equal(snapshot(), before, `${name}: destination unchanged`);
	}
});

test("source adapter failures map to operational errors with zero destination writes (G3/G4)", async () => {
	for (const code of [
		"git-clone-failed",
		"git-network-unreachable",
		"git-auth-required",
		"git-unsupported-url",
		"git-unavailable",
		"template-source-unreadable",
	]) {
		const { adapter, fs, snapshot } = fakeFsAdapter({ [PROJECT]: { kind: "directory" } });
		const before = snapshot();
		const flow = createCrewInitFlow(adapter, {
			sourceAdapter: sourceAdapterWith({ ok: false, code, message: `stable ${code} message` }),
		});
		const git = { kind: "git", location: "https://host/t.git" } as TemplateSourceDescriptor;
		const result = await flow.run(PROJECT, { from: git, cwd: "/cwd" });
		assert.equal(result.ok, false, code);
		if (!result.ok) {
			assert.equal(result.error.code, code);
			assert.equal(result.error.message, `stable ${code} message`);
		}
		assert.deepEqual(fs.mutations, []);
		assert.equal(snapshot(), before);
	}
});

test("exact rerun from identical template bytes is unchanged with zero mutations (P2)", async () => {
	const { adapter, fs, snapshot } = fakeFsAdapter({ [PROJECT]: { kind: "directory" } });
	const source = sourceAdapterWith({ ok: true, entries: templateEntries(), descriptor: local });
	const flow = createCrewInitFlow(adapter, { sourceAdapter: source });
	const first = await flow.run(PROJECT, { from: local, cwd: "/cwd" });
	assert.equal(first.ok && first.status, "created");
	const afterFirst = snapshot();
	fs.mutations.length = 0;
	const second = await flow.run(PROJECT, { from: local, cwd: "/cwd" });
	assert.equal(second.ok && second.status, "unchanged");
	assert.deepEqual(fs.mutations, []);
	assert.equal(snapshot(), afterFirst);
	assert.deepEqual(second.ok && second.source, { type: "local", location: "../ship-template" });
});

test("differing template and pre-existing built-in scaffolds conflict; existing content untouched (P3, boundary 5)", async () => {
	const { adapter, fs, snapshot } = fakeFsAdapter({
		[PROJECT]: { kind: "directory" },
		[`${PROJECT}/.pi/bebop`]: { kind: "directory" },
		[`${PROJECT}/.pi/bebop/crew.json`]: { kind: "file", bytes: '{"different":"manifest"}' },
		[`${PROJECT}/.pi/bebop/instructions`]: { kind: "directory" },
		[`${PROJECT}/.pi/bebop/instructions/captain.md`]: { kind: "file", bytes: "old\n" },
	});
	const before = snapshot();
	const flow = createCrewInitFlow(adapter, {
		sourceAdapter: sourceAdapterWith({ ok: true, entries: templateEntries(), descriptor: local }),
	});
	const result = await flow.run(PROJECT, { from: local, cwd: "/cwd" });
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error.code, "managed-file-differs");
	assert.deepEqual(fs.mutations, []);
	assert.equal(snapshot(), before);
});

test("git provenance carries the resolved commit into created and unchanged results (G1, R1)", async () => {
	const gitDescriptor: TemplateSourceDescriptor = {
		kind: "git",
		location: "https://host/ship.git",
		ref: "v1",
		resolvedCommit: "abcdef0123456789abcdef0123456789abcdef01",
	};
	const { adapter } = fakeFsAdapter({ [PROJECT]: { kind: "directory" } });
	const flow = createCrewInitFlow(adapter, {
		sourceAdapter: sourceAdapterWith({ ok: true, entries: templateEntries(), descriptor: gitDescriptor }),
	});
	const created = await flow.run(PROJECT, { from: gitDescriptor, cwd: "/cwd" });
	assert.equal(created.ok, true);
	assert.deepEqual(created.ok && created.source, {
		type: "git",
		location: "https://host/ship.git",
		resolvedRef: "abcdef0123456789abcdef0123456789abcdef01",
	});
	const unchanged = await flow.run(PROJECT, { from: gitDescriptor, cwd: "/cwd" });
	assert.equal(unchanged.ok && unchanged.status, "unchanged");
	assert.deepEqual(unchanged.ok && unchanged.source, {
		type: "git",
		location: "https://host/ship.git",
		resolvedRef: "abcdef0123456789abcdef0123456789abcdef01",
	});
});

test("mid-stage publish failure cleans staging and never reports created (F1)", async () => {
	const { adapter, fs, snapshot } = fakeFsAdapter({ [PROJECT]: { kind: "directory" } });
	fs.failPublishWith = Object.assign(new Error("EACCES"), { code: "EACCES" });
	const before = snapshot();
	const flow = createCrewInitFlow(adapter, {
		sourceAdapter: sourceAdapterWith({ ok: true, entries: templateEntries(), descriptor: local }),
	});
	const result = await flow.run(PROJECT, { from: local, cwd: "/cwd" });
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error.code, "permission-denied");
	assert.ok(
		fs.mutations.some((entry) => entry.startsWith("remove:")),
		"staging cleaned",
	);
	const staged = [...fs.kinds.keys()].filter((key) => key.includes(".bebop-init"));
	assert.deepEqual(staged, [], "no staging residue");
	assert.equal(snapshot(), before);
});

test("template/ root auto-detection adopts the template/ subtree, not decoy root bytes (L2)", async () => {
	const { adapter, fs } = fakeFsAdapter({ [PROJECT]: { kind: "directory" } });
	const entries = templateEntries();
	const scoped: TemplateEntries = {
		"crew.json": { kind: "file", bytes: '{"decoy":true}' },
		"template/": { kind: "directory" },
		...Object.fromEntries(Object.entries(entries).map(([key, value]) => [`template/${key}`, value])),
	};
	const flow = createCrewInitFlow(adapter, {
		sourceAdapter: sourceAdapterWith({ ok: true, entries, descriptor: local }).read
			? {
					async read() {
						return { ok: true, entries: scoped, descriptor: local };
					},
				}
			: {
					async read() {
						return { ok: true, entries: scoped, descriptor: local };
					},
				},
	});
	const result = await flow.run(PROJECT, { from: local, cwd: "/cwd" });
	assert.equal(result.ok, true);
	assert.equal(fs.bytes.get(`${PROJECT}/.pi/bebop/crew.json`), manifest);
	assert.notEqual(fs.bytes.get(`${PROJECT}/.pi/bebop/crew.json`), '{"decoy":true}');
});
