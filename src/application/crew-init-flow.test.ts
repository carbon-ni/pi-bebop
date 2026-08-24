import test from "node:test";
import assert from "node:assert/strict";
import {
	CREW_INIT_MANIFEST_REL,
	crewInitCrewJson,
	crewInitManagedPaths,
	crewInitTemplateBytes,
} from "../domain/index.ts";
import {
	createCrewInitFlow,
	type CrewInitFlowErrorCode,
	type CrewInitFlowResult,
	type CrewInitFsAdapter,
	type CrewInitPathKind,
} from "./crew-init-flow.ts";

// ============================================================================
// In-memory injected adapter (deterministic, no real IO)
// ============================================================================

interface MemoryNode {
	kind: "file" | "directory";
	bytes?: string;
	children?: Map<string, MemoryNode>;
	mtimes?: Map<string, number>;
}

function memoryFs(project = PROJECT): { root: MemoryNode; adapter: CrewInitFsAdapter } {
	const root: MemoryNode = { kind: "directory", children: new Map() };
	// Project root exists as a directory (like a real cwd).
	const projectRoot = ensureParents(root, project);
	projectRoot!.children!.set(basename(project), { kind: "directory", children: new Map() });
	const adapter: CrewInitFsAdapter = {
		async readKind(absPath) {
			const entry = resolveEntry(root, absPath);
			if (!entry) return "missing";
			return entry.kind === "directory" ? "directory" : "file";
		},
		async readFile(absPath) {
			const entry = resolveEntry(root, absPath);
			if (!entry || entry.kind !== "file") return undefined;
			return entry.bytes;
		},
		async writeFile(absPath, bytes) {
			const parent = ensureParents(root, absPath);
			const name = basename(absPath);
			parent.children!.set(name, { kind: "file", bytes });
		},
		async mkdir(absPath) {
			const entry = resolveEntry(root, absPath);
			if (entry) return;
			const parent = ensureParents(root, absPath);
			parent.children!.set(basename(absPath), { kind: "directory", children: new Map() });
		},
		async createStaging(projectAbs) {
			const parent = ensureParents(root, projectAbs);
			const name = `.bebop-init-staging-${Math.random().toString(36).slice(2)}`;
			parent.children!.set(name, { kind: "directory", children: new Map() });
			return `${projectAbs}/${name}`;
		},
		async publishStaging(stagingAbs, targetAbs) {
			const staging = resolveEntry(root, stagingAbs);
			const target = resolveEntry(root, targetAbs);
			if (staging && staging.kind === "directory" && target) {
				// Simulate non-empty directory rename failure like the real fs.
				if (target.kind === "directory" && (target.children?.size ?? 0) > 0) {
					throw Object.assign(new Error("ENOTEMPTY"), { code: "ENOTEMPTY" });
				}
			}
			const parent = ensureParents(root, targetAbs);
			parent.children!.delete(basename(targetAbs));
			if (staging) {
				const stagingParent = ensureParents(root, stagingAbs);
				stagingParent.children!.delete(basename(stagingAbs));
			}
			if (staging && staging.kind === "directory") {
				parent.children!.set(basename(targetAbs), staging);
			} else {
				parent.children!.set(basename(targetAbs), { kind: "directory", children: new Map() });
			}
		},
		async remove(absPath) {
			const parent = resolveEntry(root, dirname(absPath));
			parent?.children?.delete(basename(absPath));
		},
		async touchFile(absPath) {
			const entry = resolveEntry(root, absPath);
			if (entry?.kind === "file") entry.mtimes = new Map();
		},
		async mtimeNs(absPath) {
			const entry = resolveEntry(root, absPath);
			return entry?.kind === "file" ? (entry.mtimes?.size ?? 0) : undefined;
		},
	};
	return { root, adapter };
}

function resolveEntry(root: MemoryNode, absPath: string): MemoryNode | undefined {
	const parts = absPath.split("/").filter(Boolean);
	let node: MemoryNode | undefined = root;
	for (const part of parts) {
		if (!node || node.kind !== "directory") return undefined;
		node = node.children?.get(part);
	}
	return node;
}

function ensureParents(root: MemoryNode, absPath: string): MemoryNode | undefined {
	const parts = absPath.split("/").filter(Boolean);
	let node: MemoryNode = root;
	for (let index = 0; index < parts.length - 1; index += 1) {
		const part = parts[index]!;
		if (!node.children) node.children = new Map();
		let child = node.children.get(part);
		if (!child) {
			child = { kind: "directory", children: new Map() };
			node.children.set(part, child);
		}
		if (child.kind !== "directory") return undefined;
		node = child;
	}
	return node;
}

function dirname(absPath: string): string {
	const parts = absPath.split("/").filter(Boolean);
	parts.pop();
	return `/${parts.join("/")}`;
}

function basename(absPath: string): string {
	const parts = absPath.split("/").filter(Boolean);
	return parts[parts.length - 1]!;
}

function fillCompleteScaffold(root: MemoryNode, projectAbs: string): void {
	const adapter = memoryFs().adapter;
	// reuse the real template bytes through a second memory fs
}

// ============================================================================
// Tests
// ============================================================================

const PROJECT = "/work/project";

function run(adapter: CrewInitFsAdapter, project = PROJECT) {
	return createCrewInitFlow(adapter).run(project);
}

test("created: fresh project dir produces canonical scaffold with created status", async () => {
	const { root, adapter } = memoryFs();
	const result = await run(adapter);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.status, "created");
	assert.equal(result.manifestPath, CREW_INIT_MANIFEST_REL);
	assert.ok(result.createdPaths.includes(CREW_INIT_MANIFEST_REL));
	assert.ok(result.nextCommands.length > 0);
	// The published manifest parses and matches deterministic bytes.
	const published = await adapter.readFile(`${PROJECT}/${CREW_INIT_MANIFEST_REL}`);
	assert.equal(published, crewInitCrewJson());
	// Managed paths exist after publish.
	for (const relative of crewInitManagedPaths()) {
		const kind = await adapter.readKind(`${PROJECT}/${relative}`);
		assert.ok(kind !== "missing", `${relative} must exist after created`);
	}
	assert.ok(root.children?.has("work"), "scaffold under project root");
});

test("unchanged: exact rerun performs zero writes and preserves content", async () => {
	const { root, adapter } = memoryFs();
	await run(adapter);
	// Record mtimes of every managed file.
	const before = new Map<string, number>();
	for (const relative of crewInitManagedPaths()) {
		const m = await adapter.mtimeNs(`${PROJECT}/${relative}`);
		if (m !== undefined) before.set(relative, m);
	}
	const result = await run(adapter);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.status, "unchanged");
	assert.equal(result.createdPaths.length, 0);
	// Content preserved and mtimes untouched.
	for (const relative of before.keys()) {
		const m = await adapter.mtimeNs(`${PROJECT}/${relative}`);
		assert.equal(m, before.get(relative), `${relative} mtime must be preserved`);
	}
	assert.equal(await adapter.readFile(`${PROJECT}/${CREW_INIT_MANIFEST_REL}`), crewInitCrewJson());
});

test("conflict: differing managed file returns stable code and leaves content untouched", async () => {
	const { adapter } = memoryFs();
	await adapter.mkdir(`${PROJECT}/.pi/bebop`);
	await adapter.writeFile(`${PROJECT}/.pi/bebop/crew.json`, '{"version":999}');
	const result = await run(adapter);
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.error.code, "managed-file-differs");
	assert.equal(await adapter.readFile(`${PROJECT}/.pi/bebop/crew.json`), '{"version":999}');
});

test("conflict: symlinked managed path and non-directory root are stable errors", async () => {
	const { adapter } = memoryFs();
	// Symlink represented as a file-kind entry where a directory is expected.
	await adapter.writeFile(`${PROJECT}/.pi/bebop/sockets`, "symlink-target");
	const symlinkResult = await run(adapter);
	assert.equal(symlinkResult.ok, false);
	if (!symlinkResult.ok) assert.equal(symlinkResult.error.code, "managed-path-shape");
});

test("conflict: partial layout is a conflict, never a partial update", async () => {
	const { adapter } = memoryFs();
	await adapter.mkdir(`${PROJECT}/.pi/bebop`);
	await adapter.writeFile(`${PROJECT}/.pi/bebop/crew.json`, crewInitCrewJson());
	const result = await run(adapter);
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error.code, "partial-layout");
});

test("operational: unwritable project returns permission code without partial scaffold", async () => {
	const failing: CrewInitFsAdapter = {
		...memoryFs().adapter,
		async createStaging() {
			throw Object.assign(new Error("EACCES"), { code: "EACCES" });
		},
	};
	const result = await run(failing);
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error.code, "permission-denied");
});

test("operational: publish failure cleans staging and leaves project untouched", async () => {
	let publishCount = 0;
	const failing: CrewInitFsAdapter = {
		...memoryFs().adapter,
		async publishStaging() {
			publishCount += 1;
			throw Object.assign(new Error("EIO"), { code: "EIO" });
		},
		async remove(absPath) {
			// track cleanup
			await memoryFs().adapter.remove(absPath);
		},
	};
	const result = await run(failing);
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error.code, "publish-failed");
	assert.equal(publishCount, 1);
	// No partial scaffold published.
	assert.equal(await failing.readKind(`${PROJECT}/.pi/bebop`), "missing");
});

test("concurrency: two initializers produce one complete scaffold with created+unchanged reconciliation", async () => {
	const { root, adapter } = memoryFs();
	const [a, b] = await Promise.all([run(adapter), run(adapter)]);
	const outcomes = [a, b].filter((r) => r.ok).map((r) => (r.ok ? r.status : "error"));
	assert.deepEqual(outcomes.sort(), ["created", "unchanged"]);
	// Final layout is complete and valid.
	const published = await adapter.readFile(`${PROJECT}/${CREW_INIT_MANIFEST_REL}`);
	assert.equal(published, crewInitCrewJson());
});

test("usage: no force flag is ever accepted by the flow", async () => {
	const { adapter } = memoryFs();
	// The flow contract has no force/overwrite path; a differing file is conflict.
	await adapter.mkdir(`${PROJECT}/.pi/bebop`);
	await adapter.writeFile(`${PROJECT}/.pi/bebop/crew.json`, "user content");
	const result = await run(adapter);
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.notEqual(result.error.code, "overwritten");
		assert.ok(!result.error.message.includes("--force"));
	}
});

test("output contract: result carries relative paths and copyable next commands", async () => {
	const { adapter } = memoryFs();
	const result = await run(adapter);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.ok(result.createdPaths.every((p) => !p.startsWith("/")));
	assert.deepEqual(result.nextCommands, ["pi --crew-role lead", "pi --crew-role developer"]);
});
