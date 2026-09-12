import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { SessionManager, type SessionManager as SessionManagerType } from "@earendil-works/pi-coding-agent";
import { manifestFingerprint } from "../infra/crew-session-store.ts";
import {
	MEMBERSHIP_ENTRY_TYPE,
	MEMBERSHIP_SNAPSHOT_VERSION,
	getLatestMembershipState,
} from "../pi/membership-context.ts";
import { readTrustedCrewManifestMetadata } from "../infra/crew-manifest-store.ts";
import { discoverRoleSessionCandidates, resolveRoleSessionCandidate } from "./role-session-resume.ts";

const manifest = {
	version: 1 as const,
	members: [
		{ name: "Alice", role: "developer", socket: "sockets/alice.sock", socketPath: "/project/sockets/alice.sock" },
	],
	presence: { notifications: true },
};
const manifestPath = "/project/.pi/bebop/crew.json";
const fingerprint = manifestFingerprint(manifest);

function sessionInfo(id: string, file = `/sessions/${id}.jsonl`) {
	return { id, path: file, cwd: "/project", modified: new Date("2026-09-12T10:00:00.000Z") };
}

function manager(id: string, state: Record<string, unknown> | undefined) {
	return {
		getHeader: () => ({ type: "session", id, timestamp: "", cwd: "/project" }),
		getSessionFile: () => `/sessions/${id}.jsonl`,
		getCwd: () => "/project",
		getSessionDir: () => "/sessions",
		getBranch: () =>
			state === undefined ? [] : [{ type: "custom", customType: "intray-membership", data: state }],
	} as unknown as SessionManagerType;
}

function deps(
	sessions: readonly ReturnType<typeof sessionInfo>[],
	states: Record<string, Record<string, unknown> | undefined>,
) {
	return {
		manifestExists: async (file: string) => file === manifestPath,
		readManifest: async () => manifest,
		listSessions: async () => sessions,
		openSession: async (file: string) => manager(file.split("/").pop()!.replace(".jsonl", ""), states[file]),
		validateSession: async () => undefined,
		resolveEndpoint: async (socket: string) => socket,
		probe: async () => false,
	};
}

const attributed = {
	active: true,
	socketPath: "/project/sockets/alice.sock",
	manifestPath,
	snapshotVersion: MEMBERSHIP_SNAPSHOT_VERSION,
	memberName: "Alice",
	memberRole: "developer",
	manifestFingerprint: fingerprint,
};

test("discovers only active exact attributed sessions and never reads conversation text", async () => {
	const sessions = [sessionInfo("good"), sessionInfo("legacy"), sessionInfo("inactive"), sessionInfo("drift")];
	const result = await discoverRoleSessionCandidates(
		{ projectRoot: "/project", role: "developer" },
		deps(sessions, {
			"/sessions/good.jsonl": attributed,
			"/sessions/legacy.jsonl": undefined,
			"/sessions/inactive.jsonl": { ...attributed, active: false },
			"/sessions/drift.jsonl": { ...attributed, manifestFingerprint: "mfv1-sha256-other" },
		}),
	);
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.equal(result.candidates.length, 1);
		assert.equal(result.candidates[0]?.sessionId, "good");
		assert.equal(result.candidates[0]?.cwd, "/project");
		assert.equal(result.skipped, 3);
	}
});

test("rejects ambiguous or unknown exact roles before session scanning", async () => {
	let scanned = false;
	const result = await discoverRoleSessionCandidates(
		{ projectRoot: "/project", role: "missing" },
		{
			...deps([], {}),
			listSessions: async () => {
				scanned = true;
				return [];
			},
		},
	);
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.code, "unknown-role");
	assert.equal(scanned, false);
});

test("fails closed before scanning for missing, ambiguous, or unreadable Crew manifests", async () => {
	const missing = await discoverRoleSessionCandidates(
		{ projectRoot: "/project", role: "developer" },
		{ ...deps([], {}), manifestExists: async () => false },
	);
	assert.equal(!missing.ok && missing.code, "missing-manifest");
	const ambiguous = await discoverRoleSessionCandidates(
		{ projectRoot: "/project", role: "developer" },
		{ ...deps([], {}), manifestExists: async () => true },
	);
	assert.equal(!ambiguous.ok && ambiguous.code, "ambiguous-manifest");
	const unreadable = await discoverRoleSessionCandidates(
		{ projectRoot: "/project", role: "developer" },
		{
			...deps([], {}),
			readManifest: async () => {
				throw new Error("untrusted");
			},
		},
	);
	assert.equal(!unreadable.ok && unreadable.code, "untrusted-project");
});

test("rejects empty and ambiguous exact roles without scanning", async () => {
	const ambiguousManifest = { ...manifest, members: [...manifest.members, { ...manifest.members[0], name: "Bob" }] };
	const empty = await discoverRoleSessionCandidates({ projectRoot: "/project", role: "   " }, deps([], {}));
	assert.equal(!empty.ok && empty.code, "empty-role");
	const ambiguous = await discoverRoleSessionCandidates(
		{ projectRoot: "/project", role: "developer" },
		{ ...deps([], {}), readManifest: async () => ambiguousManifest },
	);
	assert.equal(!ambiguous.ok && ambiguous.code, "ambiguous-role");
});

test("maps list, open, branch, validation, and endpoint failures to bounded discovery results", async () => {
	const listed = await discoverRoleSessionCandidates(
		{ projectRoot: "/project", role: "developer" },
		{
			...deps([], {}),
			listSessions: async () => {
				throw "list failed";
			},
		},
	);
	assert.equal(!listed.ok && listed.code, "session-scan-failed");
	const info = sessionInfo("broken");
	const broken = await discoverRoleSessionCandidates(
		{ projectRoot: "/project", role: "developer" },
		{
			...deps([info], {}),
			openSession: async () => {
				throw new Error("malformed");
			},
		},
	);
	assert.equal(broken.ok && broken.skipped, 1);
	const branchBroken = await discoverRoleSessionCandidates(
		{ projectRoot: "/project", role: "developer" },
		{
			...deps([info], {}),
			openSession: async () =>
				({
					getBranch: () => {
						throw new Error("branch");
					},
				}) as unknown as SessionManager,
		},
	);
	assert.equal(branchBroken.ok && branchBroken.skipped, 1);
	const invalid = await discoverRoleSessionCandidates(
		{ projectRoot: "/project", role: "developer" },
		{
			...deps([sessionInfo("invalid")], { "/sessions/invalid.jsonl": attributed }),
			validateSession: async () => {
				throw { code: "untrusted-session-root" };
			},
		},
	);
	assert.equal(invalid.ok && invalid.skipped, 1);
});

test("integrates public SessionManager listAll/open with persisted active-branch attribution", async () => {
	const projectRoot = await mkdtemp(path.join(tmpdir(), "bebop-role-session-project-"));
	const sessionRoot = path.join(projectRoot, "sessions");
	const manifestPathOnDisk = path.join(projectRoot, ".pi", "bebop", "crew.json");
	try {
		await mkdir(path.dirname(manifestPathOnDisk), { recursive: true });
		await writeFile(
			manifestPathOnDisk,
			JSON.stringify({
				version: 1,
				members: [{ name: "Alice", role: "developer", socket: "sockets/alice.sock" }],
				presence: { notifications: true },
			}),
		);
		const parsedManifest = await readTrustedCrewManifestMetadata(manifestPathOnDisk, projectRoot, () => true);
		const persisted = SessionManager.create(projectRoot, sessionRoot, { id: "pi-persisted-role-session" });
		persisted.appendCustomEntry(MEMBERSHIP_ENTRY_TYPE, {
			active: true,
			socketPath: parsedManifest.members[0]!.socketPath,
			manifestPath: manifestPathOnDisk,
			snapshotVersion: MEMBERSHIP_SNAPSHOT_VERSION,
			memberName: "Alice",
			memberRole: "developer",
			manifestFingerprint: manifestFingerprint(parsedManifest),
		});
		// A user/assistant pair forces the supported SessionManager persistence path to flush.
		persisted.appendMessage({ role: "user", content: "known history", timestamp: Date.now() } as never);
		persisted.appendMessage({ role: "assistant", content: "known reply", timestamp: Date.now() } as never);
		const sessionFile = persisted.getSessionFile()!;
		const beforeBytes = await readFile(sessionFile);
		const beforeStat = await stat(sessionFile);
		const listed = await SessionManager.listAll(sessionRoot);
		const listedInfo = listed.find((info) => info.id === persisted.getSessionId());
		assert.ok(listedInfo, "SessionManager.listAll must expose the persisted session");
		const reopened = SessionManager.open(listedInfo.path, sessionRoot);
		assert.equal(reopened.getHeader()?.id, persisted.getSessionId());
		assert.equal(getLatestMembershipState(reopened.getBranch())?.active, true);
		assert.deepEqual(await readFile(sessionFile), beforeBytes);
		assert.equal((await stat(sessionFile)).mtimeMs, beforeStat.mtimeMs);

		const discovered = await discoverRoleSessionCandidates(
			{ projectRoot, role: "developer" },
			{
				manifestExists: async (file) => file === manifestPathOnDisk,
				readManifest: readTrustedCrewManifestMetadata,
				listSessions: async () => SessionManager.listAll(sessionRoot),
				openSession: async (file) => SessionManager.open(file, sessionRoot),
				validateSession: async () => undefined,
				resolveEndpoint: async (socket) => socket,
				probe: async () => false,
			},
		);
		assert.equal(discovered.ok, true);
		if (discovered.ok) {
			assert.deepEqual(
				discovered.candidates.map(({ sessionId, sessionFile, cwd }) => ({ sessionId, sessionFile, cwd })),
				[{ sessionId: "pi-persisted-role-session", sessionFile, cwd: projectRoot }],
			);
		}
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
});

test("revalidates the selected candidate and refuses a live endpoint", async () => {
	const candidate = {
		sessionId: "good",
		sessionFile: "/sessions/good.jsonl",
		cwd: "/project",
		root: "/sessions",
		modified: "2026-09-12T10:00:00.000Z",
	};
	const result = await resolveRoleSessionCandidate(
		{ projectRoot: "/project", role: "developer", candidate },
		{ ...deps([], { "/sessions/good.jsonl": attributed }), probe: async () => true },
	);
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.code, "already-online");
});
