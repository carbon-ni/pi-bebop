import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as net from "node:net";
import { createRpcServer, closeRpcServer } from "../infra/rpc-server.ts";
import { openTrustedMemberInboxStore } from "../infra/member-inbox-store.ts";
import { createSocketState, handleCommand } from "../pi/control-runtime.ts";

interface Fixture {
	readonly root: string;
	readonly manifestPath: string;
	readonly sourceSocket: string;
	readonly sourceServer: net.Server;
	readonly stores: {
		tony: Awaited<ReturnType<typeof openTrustedMemberInboxStore>>;
		mary: Awaited<ReturnType<typeof openTrustedMemberInboxStore>>;
	};
	setTrusted(value: boolean): void;
	close(): Promise<void>;
}

async function startFixture(t: test.TestContext): Promise<Fixture> {
	const root = await fs.mkdtemp(path.join(tmpdir(), "bebop-packaged-durable-"));
	const crewDir = path.join(root, ".pi", "bebop");
	const socketsDir = path.join(crewDir, "sockets");
	await fs.mkdir(socketsDir, { recursive: true });
	const manifestPath = path.join(crewDir, "crew.json");
	const sourceSocket = path.join(crewDir, "source-session-1.sock");
	const tonySocket = path.join(socketsDir, "Tony.sock");
	const marySocket = path.join(socketsDir, "Mary.sock");
	await fs.writeFile(
		manifestPath,
		JSON.stringify({
			version: 1,
			presence: { notifications: true },
			members: [
				{ name: "Tony", role: "lead", socket: "sockets/Tony.sock", socketPath: tonySocket },
				{ name: "Mary", role: "po", socket: "sockets/Mary.sock", socketPath: marySocket },
			],
		}),
	);
	let trusted = true;
	const sourceState = createSocketState();
	sourceState.server = {} as never;
	sourceState.membershipRuntime = {
		getMembership: () => ({
			manifestPath,
			socketPath: sourceSocket,
			member: { name: "Tony", role: "lead", socketPath: sourceSocket },
			manifest: {
				version: 1,
				presence: { notifications: true },
				members: [
					{ name: "Tony", role: "lead", socket: "sockets/Tony.sock", socketPath: tonySocket },
					{ name: "Mary", role: "po", socket: "sockets/Mary.sock", socketPath: marySocket },
				],
			},
		}),
	} as never;
	sourceState.context = {
		hasUI: false,
		sessionManager: { getSessionId: () => "source-session-1", getSessionName: () => null, getEntries: () => [] },
		isIdle: () => true,
		hasPendingMessages: () => false,
		isProjectTrusted: () => trusted,
	} as never;
	const sourceServer = await createRpcServer(sourceSocket, (command, socket) =>
		handleCommand({} as never, sourceState, command, socket),
	);
	const stores = {
		tony: await openTrustedMemberInboxStore({
			manifestPath,
			projectRoot: root,
			isProjectTrusted: () => true,
			member: { name: "Tony", role: "lead", socketPath: tonySocket },
		}),
		mary: await openTrustedMemberInboxStore({
			manifestPath,
			projectRoot: root,
			isProjectTrusted: () => true,
			member: { name: "Mary", role: "po", socketPath: marySocket },
		}),
	};
	t.after(async () => {
		await closeRpcServer(sourceServer);
		await fs.rm(root, { recursive: true, force: true });
	});
	return {
		root,
		manifestPath,
		sourceSocket,
		sourceServer,
		stores,
		setTrusted: (value) => (trusted = value),
		close: () => closeRpcServer(sourceServer),
	};
}

async function packaged(root: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	const child = spawn(process.execPath, [path.resolve("dist/cli/main.js"), ...args], {
		env: { ...process.env, HOME: root },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => (stdout += chunk));
	child.stderr.on("data", (chunk) => (stderr += chunk));
	const code = await new Promise<number>((resolve) => child.once("exit", (value) => resolve(value ?? 1)));
	return { code, stdout, stderr };
}

test("packaged CLI persists Inbox and broadcast through the production trusted dispatcher", async (t) => {
	const fixture = await startFixture(t);
	const inbox = await packaged(fixture.root, [
		"member",
		"inbox",
		"send",
		"Mary",
		"--session",
		"source-session-1",
		"--message",
		"durable",
		"--format",
		"json",
	]);
	assert.equal(inbox.code, 0, `${inbox.stdout}${inbox.stderr}`);
	assert.equal(JSON.parse(inbox.stdout).status, "persisted");
	assert.equal(await fixture.stores.mary.count(), 1);

	const broadcast = await packaged(fixture.root, [
		"crew",
		"broadcast",
		"--session",
		"source-session-1",
		"--message",
		"announce",
		"--format",
		"json",
	]);
	assert.equal(broadcast.code, 0, `${broadcast.stdout}${broadcast.stderr}`);
	const data = JSON.parse(broadcast.stdout);
	assert.equal(data.status, "persisted");
	assert.deepEqual(data.data.summary, { persisted: 1, alreadyPersisted: 0, failed: 0, total: 1 });
	assert.equal(await fixture.stores.mary.count(), 2);
});

test("packaged CLI trusted dispatcher rejects durable writes when runtime trust is false", async (t) => {
	const fixture = await startFixture(t);
	fixture.setTrusted(false);
	const outcome = await packaged(fixture.root, [
		"crew",
		"broadcast",
		"--session",
		"source-session-1",
		"--message",
		"blocked",
		"--format",
		"json",
	]);
	assert.equal(outcome.code, 1, `${outcome.stdout}${outcome.stderr}`);
	assert.match(outcome.stdout, /transport-error/);
	assert.equal(await fixture.stores.mary.count(), 0);
});
