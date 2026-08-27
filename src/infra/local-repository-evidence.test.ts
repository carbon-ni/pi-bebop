import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { canonicalRetrospectiveEvidenceJson, type RetrospectiveEvidenceInterval } from "../domain/index.ts";
import { collectRepositoryEvidence } from "../application/repository-evidence.ts";
import {
	createLocalRepositoryEvidenceAdapters,
	scanLocalRepositoryFiles,
	type GitCommandRequest,
} from "./local-repository-evidence.ts";
import { sha256RetrospectiveEvidenceFingerprint } from "./retrospective-evidence-store.ts";

const interval: RetrospectiveEvidenceInterval = {
	start: "2026-08-27T09:00:00.000Z",
	end: "2026-08-27T10:00:00.000Z",
};
let temporary: string | undefined;
afterEach(async () => {
	if (temporary) await fs.rm(temporary, { recursive: true, force: true });
	temporary = undefined;
});

async function collectWithFactory(factory: ReturnType<typeof createLocalRepositoryEvidenceAdapters>) {
	return await collectRepositoryEvidence({
		repositoryId: "pi-bebop",
		interval,
		capturedAt: "2026-08-27T10:01:00.000Z",
		fingerprint: sha256RetrospectiveEvidenceFingerprint,
		adapters: factory.adapters,
		state: factory.state,
	});
}

test("local adapters collect commits, plan lifecycle, retained reports, and verification without network commands", async () => {
	const commands: GitCommandRequest[] = [];
	const runGit = async (request: GitCommandRequest) => {
		commands.push(request);
		if (request.args[0] === "log" && request.args.includes("plans")) {
			return "\u001eabc123\u001f2026-08-27T09:20:00.000Z\u001fchore: plans(done) TASK-0111\nM\tplans/done/0111.md";
		}
		if (request.args[0] === "log") {
			return "\u001eabc123\u001f2026-08-27T09:20:00.000Z\u001ffeat: evidence TASK-0111";
		}
		if (request.args[0] === "rev-parse") return "abc123\n";
		if (request.args[0] === "symbolic-ref") return "dev\n";
		if (request.args[0] === "status") return " M src/file.ts\n";
		if (request.args[0] === "reflog") return "reset: moving to abc123\n";
		throw new Error(`unexpected git command: ${request.args.join(" ")}`);
	};
	const scanFiles = async (relativeRoot: string) => ({
		status: "available" as const,
		provenance: `filesystem:${relativeRoot}`,
		items: [
			{
				relativePath: `${relativeRoot}/record.md`,
				modifiedAt: "2026-08-27T09:40:00.000Z",
				content: `${relativeRoot} retained record`,
			},
		],
	});
	const factory = createLocalRepositoryEvidenceAdapters({
		projectRoot: "/trusted/project",
		timeoutMs: 1234,
		deps: { runGit, scanFiles },
	});
	const evidence = await collectWithFactory(factory);
	const bytes = canonicalRetrospectiveEvidenceJson(evidence);
	for (const expected of [
		"git-commits:abc123",
		"plans/done/0111.md",
		".tmp/reports/record.md",
		".tmp/funzzy/record.md",
	]) {
		assert.match(bytes, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
	assert.match(bytes, /dirty=true; detached=false; rewritten=true/);
	assert.ok(commands.every((request) => request.timeoutMs === 1234 && request.cwd === "/trusted/project"));
	assert.ok(commands.every((request) => !request.args.some((arg) => ["fetch", "pull", "push"].includes(arg))));
	const reflog = commands.find((request) => request.args[0] === "reflog");
	assert.ok(reflog?.args.includes(`--since=${interval.start}`));
	assert.ok(reflog?.args.includes(`--until=${interval.end}`));
});

test("local adapters preserve command timeout, missing retention, and oversized source outcomes", async () => {
	const timeout = Object.assign(new Error("command timeout"), {
		code: "ETIMEDOUT",
	});
	const factory = createLocalRepositoryEvidenceAdapters({
		projectRoot: "/trusted/project",
		deps: {
			runGit: async (request) => {
				if (request.args[0] === "log") throw timeout;
				if (request.args[0] === "rev-parse") return "abc123\n";
				if (request.args[0] === "symbolic-ref") throw Object.assign(new Error("detached HEAD"), { code: 1 });
				if (request.args[0] === "status" || request.args[0] === "reflog") return "";
				throw new Error("unexpected");
			},
			scanFiles: async (root) =>
				root.includes("reports")
					? { status: "missing", detail: "retention root absent" }
					: {
							status: "oversized",
							detail: "verification exceeds aggregate bound",
						},
		},
	});
	const evidence = await collectWithFactory(factory);
	const bytes = canonicalRetrospectiveEvidenceJson(evidence);
	for (const expected of ["timeout", "missing", "oversized", "detached=true"])
		assert.match(bytes, new RegExp(expected));
});

test("local adapters map an unsupported Git repository without fetching or fabricating artifacts", async () => {
	const factory = createLocalRepositoryEvidenceAdapters({
		projectRoot: "/trusted/not-git",
		deps: {
			runGit: async () => {
				throw new Error("fatal: not a git repository");
			},
			scanFiles: async () => ({ status: "missing", detail: "retention root absent" }),
		},
	});
	const evidence = await collectWithFactory(factory);
	const bytes = canonicalRetrospectiveEvidenceJson(evidence);
	assert.match(bytes, /unsupported/);
	assert.match(bytes, /not a supported Git repository/);
	assert.equal(bytes.includes("git-commits:commit"), false);
});

test("default filesystem scanner is interval-bounded, deterministic, strict UTF-8, and project-relative", async () => {
	temporary = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-repository-evidence-"));
	const reports = path.join(temporary, ".tmp", "reports");
	await fs.mkdir(reports, { recursive: true });
	const inside = path.join(reports, "inside.md");
	const end = path.join(reports, "end.md");
	await fs.writeFile(inside, "report token=raw-secret", "utf8");
	await fs.writeFile(end, "excluded at end", "utf8");
	await fs.utimes(inside, new Date("2026-08-27T09:30:00.000Z"), new Date("2026-08-27T09:30:00.000Z"));
	await fs.utimes(end, new Date(interval.end), new Date(interval.end));
	const result = await scanLocalRepositoryFiles(temporary, ".tmp/reports", interval);
	assert.equal(result.status, "available");
	if (result.status !== "available") return;
	assert.deepEqual(
		result.items.map((item) => item.relativePath),
		[".tmp/reports/inside.md"],
	);
	assert.equal(result.items[0].content, "report token=raw-secret");
	assert.equal(path.isAbsolute(result.items[0].relativePath), false);

	await fs.writeFile(path.join(reports, "invalid.md"), Buffer.from([0xc3, 0x28]));
	await fs.utimes(
		path.join(reports, "invalid.md"),
		new Date("2026-08-27T09:31:00.000Z"),
		new Date("2026-08-27T09:31:00.000Z"),
	);
	const invalid = await scanLocalRepositoryFiles(temporary, ".tmp/reports", interval);
	assert.equal(invalid.status, "failed");
	await fs.rm(path.join(reports, "invalid.md"));
	await fs.symlink(path.join(temporary, "outside.md"), path.join(reports, "escape.md"));
	const symlink = await scanLocalRepositoryFiles(temporary, ".tmp/reports", interval);
	assert.equal(symlink.status, "failed");
	const traversal = await scanLocalRepositoryFiles(temporary, "../outside", interval);
	assert.equal(traversal.status, "failed");
});
