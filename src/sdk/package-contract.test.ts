import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = path.resolve(".");

test("packed SDK exposes runnable ESM and TypeScript declarations", async () => {
	const temp = await mkdtemp(path.join(tmpdir(), "bebop-sdk-package-"));
	const destination = path.join(temp, "package");
	const consumer = path.join(temp, "consumer");
	try {
		await mkdir(destination, { recursive: true });
		await mkdir(consumer, { recursive: true });
		await execFile("npm", ["pack", "--ignore-scripts", "--pack-destination", destination], { cwd: root });
		const archiveName = (await readdir(destination)).find((file) => file.endsWith(".tgz"));
		assert.ok(archiveName);
		const packageRoot = path.join(consumer, "node_modules", "@carbon-ni", "pi-bebop");
		await mkdir(packageRoot, { recursive: true });
		await execFile("tar", ["-xzf", path.join(destination, archiveName), "-C", packageRoot, "--strip-components=1"]);
		const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
		assert.equal(packageJson.exports["./sdk"].import, "./dist/sdk.js");
		assert.equal(packageJson.exports["./sdk"].types, "./dist/sdk.d.ts");
		await symlink(path.join(root, "node_modules", "@sinclair"), path.join(consumer, "node_modules", "@sinclair"));
		await symlink(path.join(root, "node_modules", "typebox"), path.join(consumer, "node_modules", "typebox"));
		await symlink(path.join(root, "node_modules", "@types"), path.join(consumer, "node_modules", "@types"));
		const js = await execFile(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				"import { createBebopClient, createInProcessMemberLastMessageOperation, createRemoteFollowUpOperation, createInProcessMemberInboxOperation, createRemoteMemberInboxOperation, createRemoteMemberRequestOperation, createInProcessMemberRequestOperation, BebopClientError } from '@carbon-ni/pi-bebop/sdk'; if (typeof createBebopClient !== 'function' || typeof createInProcessMemberLastMessageOperation !== 'function' || typeof createRemoteFollowUpOperation !== 'function' || typeof createInProcessMemberInboxOperation !== 'function' || typeof createRemoteMemberInboxOperation !== 'function' || typeof createRemoteMemberRequestOperation !== 'function' || typeof createInProcessMemberRequestOperation !== 'function' || BebopClientError.name !== 'BebopClientError') process.exit(1)",
			],
			{ cwd: consumer },
		);
		assert.equal(js.stderr, "");
		const source = path.join(consumer, "consumer.ts");
		await writeFile(
			source,
			`import { createBebopClient, createInProcessMemberLastMessageOperation, createInProcessFollowUpOperation, createRemoteFollowUpOperation, createInProcessMemberInboxOperation, createRemoteMemberInboxOperation, createRemoteMemberRequestOperation, createInProcessMemberRequestOperation, BebopClientError, type AskResult, type FollowUpInput, type FollowUpOperation, type FollowUpResult, type InboxInput, type InboxResult, type MemberRequestOperation, type MemberRequestStartInput, type MemberRequestWaitResult, type InProcessFollowUpOperationDependencies, type InProcessMemberInboxOperationDependencies, type InProcessMemberLastMessageOperationDependencies, type InProcessMemberRequestOperationDependencies, type MemberInboxOperation, type MemberLastMessageOperation, type MemberLastMessageResult, type MemberStatus } from "@carbon-ni/pi-bebop/sdk";
const client = createBebopClient();
const selected = client.selectSource({ session: "safe-session" });
const status: Promise<MemberStatus> = selected.then((source) => source.getMemberStatus("developer"));
const lastMessage: Promise<MemberLastMessageResult> = selected.then((source) => source.getMemberLastMessage("developer", { timeoutMs: 5000 }));
const operation: MemberLastMessageOperation = createInProcessMemberLastMessageOperation({} as InProcessMemberLastMessageOperationDependencies);
const followUpInput: FollowUpInput = { message: "informational" };
const followUpOperation: FollowUpOperation = createRemoteFollowUpOperation({ send: async () => ({ member: { name: "Kelly", role: "qa" }, deliveryId: "delivery", disposition: "queued" }) });
const followUpResult: Promise<FollowUpResult> = followUpOperation.sendFollowUp("Kelly", followUpInput);
const inProcessFollowUp = createInProcessFollowUpOperation({} as InProcessFollowUpOperationDependencies);
const inboxInput: InboxInput = { message: "durable" };
const inboxOperation: MemberInboxOperation = createRemoteMemberInboxOperation({ send: async () => ({ member: { name: "Kelly", role: "qa" }, itemId: "inbox-1-id", persisted: true, hint: "skipped" }) });
const inboxResult: Promise<InboxResult> = inboxOperation.sendToInbox("Kelly", inboxInput);
const inProcessInbox = createInProcessMemberInboxOperation({} as InProcessMemberInboxOperationDependencies);
const requestOperation: MemberRequestOperation = createRemoteMemberRequestOperation({ sendStart: async () => ({ accepted: true, requestId: "request-1", member: { name: "Kelly", role: "qa" } }), sendWait: async () => ({ kind: "pending", requestId: "request-1", member: { name: "Kelly", role: "qa" }, reason: "pending-after-idle" }), sendResponse: async () => ({}) });
const requestInput: MemberRequestStartInput = { message: "question" };
const requestResult: Promise<MemberRequestWaitResult> = requestOperation.waitForRequestOutcome("request-1");
const inProcessRequest = createInProcessMemberRequestOperation({} as InProcessMemberRequestOperationDependencies);
const ask: Promise<AskResult> = selected.then((source) => source.ask("developer", { question: "Review" }, { responseGraceSeconds: 30, totalWaitSeconds: 120 }));
void operation; void status; void lastMessage; void followUpResult; void inProcessFollowUp; void inboxResult; void inProcessInbox; void requestInput; void requestResult; void inProcessRequest; void ask; void new BebopClientError("timeout");
`,
		);
		try {
			await execFile(
				path.join(root, "node_modules/typescript/bin/tsc"),
				[
					"--noEmit",
					"--strict",
					"--target",
					"ES2022",
					"--module",
					"NodeNext",
					"--moduleResolution",
					"NodeNext",
					"--types",
					"node",
					source,
				],
				{ cwd: consumer },
			);
		} catch (error) {
			const details = error as Error & { stdout?: string; stderr?: string };
			throw new Error(`${details.message}\n${details.stdout ?? ""}\n${details.stderr ?? ""}`);
		}
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
});
