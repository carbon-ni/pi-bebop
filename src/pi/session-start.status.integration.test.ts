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

function createPi(
	activeTools: string[],
	getFlag: (name: string) => unknown = () => false,
	sentMessages?: { count: number },
): { getFlag: (name: string) => unknown } & Record<string, unknown> {
	return {
		getFlag,
		getActiveTools: () => activeTools,
		setActiveTools: (tools: string[]) => {
			activeTools.length = 0;
			activeTools.push(...tools);
		},
		appendEntry: () => undefined,
		sendMessage: () => {
			if (sentMessages) sentMessages.count++;
		},
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

async function captureSessionStartBoundary(
	hasUI: boolean,
	role: string,
	trusted: boolean,
): Promise<{
	message: string;
	notifications: string[];
	errors: string[];
	sends: number;
}> {
	const harness = createHarness(`boundary-${hasUI ? "ui" : "headless"}-${role.trim() || "empty"}`, []);
	const notifications: string[] = [];
	const errors: string[] = [];
	const sends = { count: 0 };
	const originalError = console.error;
	console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
	const ctx = {
		...(harness.state.context as object),
		hasUI,
		isProjectTrusted: () => {
			if (!trusted) throw new Error("private/tmp/session-start-secret");
			return true;
		},
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: () => undefined,
			theme: { fg: (_color: string, value: string) => value },
		},
	};
	try {
		await handleSessionStart(
			createPi([], (name) => (name === "crew-role" ? role : false), sends) as never,
			harness.state,
			ctx as never,
			createDeps(harness),
		);
		return {
			message: hasUI ? (notifications.at(-1) ?? "") : (errors.at(-1) ?? ""),
			notifications,
			errors,
			sends: sends.count,
		};
	} finally {
		console.error = originalError;
	}
}

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

test("session-start boundary keeps UI/headless known and unknown failures identical and turn-free", async () => {
	const cases = [
		{ role: "   ", trusted: true, code: "empty-role" },
		{ role: "developer", trusted: false, code: "unexpected-failure" },
	];
	for (const item of cases) {
		const ui = await captureSessionStartBoundary(true, item.role, item.trusted);
		const headless = await captureSessionStartBoundary(false, item.role, item.trusted);
		assert.equal(ui.message, headless.message);
		assert.equal(ui.notifications.length, 1);
		assert.equal(ui.errors.length, 0);
		assert.equal(headless.notifications.length, 0);
		assert.equal(headless.errors.length, 1);
		assert.equal(ui.sends, 0);
		assert.equal(headless.sends, 0);
		assert.match(ui.message, new RegExp(`\\(code: ${item.code}\\)$`));
		assert.doesNotMatch(ui.message, /private\/tmp|session-start-secret/);
	}
});

test("session replacement cancels an in-flight member-idle command before restoring state", async () => {
	const harness = createHarness("replacement-session", []);
	const reasons: string[] = [];
	harness.state.crewMemberIdleCommand = { cancel: (reason) => reasons.push(reason) };
	harness.state.membershipRuntime = {
		join: async () => assert.fail("replacement without persisted membership must not join"),
		getMembership: () => null,
		leave: async () => ({ ok: true, left: false }),
	} as never;
	await handleSessionStart(createPi([]) as never, harness.state, harness.state.context as never, createDeps(harness));
	assert.deepEqual(reasons, ["session-replaced"]);
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
		assert.deepEqual(harness.statuses, ["online", "joined Mary (po)"]);
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
		assert.deepEqual(harness.statuses, ["online"]);
		assert.equal(harness.announcements.length, 0);
		const failure = harness.notifications.at(-1) ?? "";
		assert.match(failure, /^Crew Membership restore failed:/);
		assert.doesNotMatch(failure, /endpoint is occupied/);
		assert.match(failure, /Next:/);
		assert.match(failure, /\(code: unexpected-failure\)$/);
	} finally {
		await disableControlServer(harness.state, harness.state.context as never);
	}
});

test("startup restore pairs the footer with the crew name when the manifest has one", async () => {
	const harness = createHarness("named-restore-session", [persistedEntry]);
	const namedMembership = {
		...restoredMembership,
		manifest: { ...restoredMembership.manifest, name: "Alpha Crew" },
	};
	let membership: typeof namedMembership | null = null;
	harness.state.membershipRuntime = {
		join: async () => {
			membership = namedMembership;
			return { ok: true, membership: namedMembership, idempotent: false };
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
		assert.deepEqual(harness.statuses, ["online", "joined Alpha Crew — Mary (po)"]);
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
