import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Sandbox HOME before any module that derives CONTROL_DIR from os.homedir()
// loads; node --test runs each test file in its own process, so the override
// is process-local. All sockets, aliases, and env writes stay in the sandbox.
const sandboxHome = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-status-home-"));
const previousHome = process.env.HOME;
const previousSessionId = process.env.PI_SESSION_ID;
process.env.HOME = sandboxHome;

const { handleSessionStart } = await import("./session-start.ts");
const { createSocketState, disableControlServer } = await import("./control-runtime.ts");
const { MEMBERSHIP_ENTRY_TYPE } = await import("./membership-context.ts");

interface StatusHarness {
	readonly state: ReturnType<typeof createSocketState>;
	readonly statuses: Array<string | undefined>;
	readonly notifications: string[];
	readonly announcements: string[];
	readonly persisted: Array<{ active: boolean }>;
}

function createHarness(sessionId: string, branch: unknown[]): StatusHarness {
	const statuses: Array<string | undefined> = [];
	const notifications: string[] = [];
	const announcements: string[] = [];
	const persisted: Array<{ active: boolean }> = [];
	const state = createSocketState();
	state.context = {
		hasUI: true,
		cwd: "/project",
		isProjectTrusted: () => true,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionName: () => `${sessionId}-name`,
			getBranch: () => branch,
		},
		ui: {
			setStatus: (_key: string, value?: string) => statuses.push(value),
			notify: (message: string) => notifications.push(message),
			theme: { fg: (_color: string, value: string) => value },
		},
	} as never;
	return {
		state,
		statuses,
		notifications,
		announcements,
		persisted,
	};
}

function createPi(activeTools: string[]): { getFlag: () => boolean } & Record<string, unknown> {
	return {
		getFlag: () => false,
		getActiveTools: () => activeTools,
		setActiveTools: (tools: string[]) => {
			activeTools.length = 0;
			activeTools.push(...tools);
		},
		appendEntry: () => undefined,
	};
}

function createDeps(harness: StatusHarness): never {
	return {
		inboxBridge: {
			establish: () => undefined,
			attemptOffer: async () => undefined,
			invalidate: () => undefined,
		},
		recoverInterrupts: async () => undefined,
		refreshPresence: async () => undefined,
		persistMembership: (active: boolean) => harness.persisted.push({ active }),
		announceMembership: (message: string) => harness.announcements.push(message),
	} as never;
}

const restoredMembership = {
	manifestPath: "/project/.pi/bebop/crew.json",
	socketPath: "/project/.pi/bebop/sockets/mary.sock",
	globalSocketPath: "/sandbox/global.sock",
	member: { name: "Mary", role: "po", socketPath: "/project/.pi/bebop/sockets/mary.sock" },
	manifest: {
		members: [
			{ name: "Mary", role: "po", socketPath: "/project/.pi/bebop/sockets/mary.sock" },
			{ name: "Kelly", role: "qa", socketPath: "/project/.pi/bebop/sockets/kelly.sock" },
		],
	},
};

const persistedEntry = {
	type: "custom",
	customType: MEMBERSHIP_ENTRY_TYPE,
	data: {
		active: true,
		socketPath: "/project/.pi/bebop/sockets/mary.sock",
		manifestPath: "/project/.pi/bebop/crew.json",
	},
};

test.after(async () => {
	process.env.HOME = previousHome;
	if (previousSessionId === undefined) delete process.env.PI_SESSION_ID;
	else process.env.PI_SESSION_ID = previousSessionId;
	await fs.rm(sandboxHome, { recursive: true, force: true });
});

test("startup restore refreshes the status line from online to the restored identity", async () => {
	const harness = createHarness("restore-session", [persistedEntry]);
	let membership: typeof restoredMembership | null = null;
	harness.state.membershipRuntime = {
		join: async () => {
			membership = restoredMembership;
			return { ok: true, membership: restoredMembership, idempotent: false };
		},
		getMembership: () => membership,
		leave: async () => {
			membership = null;
			return { ok: true, left: true };
		},
	} as never;
	try {
		await handleSessionStart(
			createPi([]) as never,
			harness.state,
			harness.state.context as never,
			createDeps(harness),
		);
		assert.deepEqual(harness.statuses, ["restore-session online", "restore-session joined Mary (po)"]);
		assert.equal(harness.announcements.length, 1);
	} finally {
		await disableControlServer(harness.state, harness.state.context as never);
	}
});

test("failed startup restore reports the failure and never displays identity", async () => {
	const harness = createHarness("failed-restore-session", [persistedEntry]);
	harness.state.membershipRuntime = {
		join: async () => ({ ok: false, error: { message: "endpoint is occupied" } }),
		getMembership: () => null,
		leave: async () => ({ ok: true, left: false }),
	} as never;
	try {
		await handleSessionStart(
			createPi([]) as never,
			harness.state,
			harness.state.context as never,
			createDeps(harness),
		);
		// The control server ensured the online status first; the failed join
		// must leave it identity-free rather than guessing or caching one.
		assert.deepEqual(harness.statuses, ["failed-restore-session online"]);
		assert.equal(harness.announcements.length, 0);
		assert.match(harness.notifications.at(-1) ?? "", /endpoint is occupied/);
	} finally {
		await disableControlServer(harness.state, harness.state.context as never);
	}
});

test("unjoined startup sets no status line and no placeholder identity", async () => {
	const harness = createHarness("plain-session", []);
	harness.state.membershipRuntime = {
		join: async () => assert.fail("unjoined startup must not join"),
		getMembership: () => null,
		leave: async () => ({ ok: true, left: false }),
	} as never;
	await handleSessionStart(createPi([]) as never, harness.state, harness.state.context as never, createDeps(harness));
	// No control server was started, so no status line exists at all: the
	// disabled status semantics stay distinct from online/joined.
	assert.deepEqual(harness.statuses, []);
	assert.equal(harness.state.server, null);
});
