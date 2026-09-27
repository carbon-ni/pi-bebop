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
				"import { createBebopClient, createInProcessMemberLastMessageOperation, createRemoteFollowUpOperation, createInProcessMemberInboxOperation, createRemoteMemberInboxOperation, createInProcessCrewBroadcastOperation, createRemoteCrewBroadcastOperation, createInProcessRedirectOperation, createRemoteRedirectOperation, BebopClientError } from '@carbon-ni/pi-bebop/sdk'; if (typeof createBebopClient !== 'function' || typeof createInProcessMemberLastMessageOperation !== 'function' || typeof createRemoteFollowUpOperation !== 'function' || typeof createInProcessMemberInboxOperation !== 'function' || typeof createRemoteMemberInboxOperation !== 'function' || typeof createInProcessCrewBroadcastOperation !== 'function' || typeof createRemoteCrewBroadcastOperation !== 'function' || typeof createInProcessRedirectOperation !== 'function' || typeof createRemoteRedirectOperation !== 'function' || BebopClientError.name !== 'BebopClientError') process.exit(1); const calls = []; const broadcast = createRemoteCrewBroadcastOperation({ send: async (command) => { calls.push(command); return { dispositions: [{ member: 'developer', role: 'Developer', disposition: 'delivered', deliveryId: 'delivery-1' }, { member: 'reviewer', role: 'Reviewer', disposition: 'failed', code: 'offline' }], summary: { delivered: 1, failed: 1, total: 2 } }; } }); const result = await broadcast.broadcastToCrew({ message: 'packaged update', instructions: ['review'] }); const redirects = []; const redirect = createRemoteRedirectOperation({ send: async (command) => { redirects.push(command); return { member: { name: 'developer', role: 'Developer' }, deliveryId: 'redirect-1', disposition: 'steered' }; } }); const redirectResult = await redirect.redirectMember('developer', { message: 'change direction' }); if (JSON.stringify(redirects) !== JSON.stringify([{ type: 'member_redirect', target: 'developer', message: 'change direction' }]) || redirectResult.disposition !== 'steered') process.exit(3); if (JSON.stringify(calls) !== JSON.stringify([{ type: 'crew_broadcast', message: 'packaged update', instructions: ['review'] }]) || result.ok !== true || result.summary.failed !== 1 || result.dispositions[0]?.recipientName !== 'developer') process.exit(2)",
			],
			{ cwd: consumer },
		);
		assert.equal(js.stderr, "");
		const source = path.join(consumer, "consumer.ts");
		await writeFile(
			source,
			'import { createBebopClient, createInProcessMemberLastMessageOperation, createInProcessFollowUpOperation, createRemoteFollowUpOperation, createInProcessMemberInboxOperation, createRemoteMemberInboxOperation, createInProcessCrewBroadcastOperation, createRemoteCrewBroadcastOperation, createInProcessRedirectOperation, createRemoteRedirectOperation, BebopClientError, type AskResult, type CrewBroadcastInput, type CrewBroadcastOperation, type CrewBroadcastResult, type FollowUpInput, type FollowUpOperation, type FollowUpResult, type InboxInput, type InboxResult, type InProcessCrewBroadcastOperationDependencies, type InProcessFollowUpOperationDependencies, type InProcessMemberInboxOperationDependencies, type InProcessMemberLastMessageOperationDependencies, type MemberInboxOperation, type MemberLastMessageOperation, type MemberLastMessageResult, type MemberStatus, type InProcessRedirectOperationDependencies, type RedirectInput, type RedirectOperation, type RedirectResult, type RemoteRedirectCommand, type RemoteRedirectDependencies } from "@carbon-ni/pi-bebop/sdk";\nconst client = createBebopClient();\nconst selected = client.selectSource({ session: "safe-session" });\nconst status: Promise<MemberStatus> = selected.then((source) => source.getMemberStatus("developer"));\nconst lastMessage: Promise<MemberLastMessageResult> = selected.then((source) => source.getMemberLastMessage("developer", { timeoutMs: 5000 }));\nconst operation: MemberLastMessageOperation = createInProcessMemberLastMessageOperation({} as InProcessMemberLastMessageOperationDependencies);\nconst followUpInput: FollowUpInput = { message: "informational" };\nconst followUpOperation: FollowUpOperation = createRemoteFollowUpOperation({ send: async () => ({ member: { name: "Kelly", role: "qa" }, deliveryId: "delivery", disposition: "queued" }) });\nconst followUpResult: Promise<FollowUpResult> = followUpOperation.sendFollowUp("Kelly", followUpInput);\nconst inProcessFollowUp = createInProcessFollowUpOperation({} as InProcessFollowUpOperationDependencies);\nconst inboxInput: InboxInput = { message: "durable" };\nconst inboxOperation: MemberInboxOperation = createRemoteMemberInboxOperation({ send: async () => ({ member: { name: "Kelly", role: "qa" }, itemId: "inbox-1-id", persisted: true, hint: "skipped" }) });\nconst inboxResult: Promise<InboxResult> = inboxOperation.sendToInbox("Kelly", inboxInput);\nconst inProcessInbox = createInProcessMemberInboxOperation({} as InProcessMemberInboxOperationDependencies);\nconst broadcastInput: CrewBroadcastInput = { message: "crew update" };\nconst broadcast: Promise<CrewBroadcastResult> = selected.then((source) => source.broadcastToCrew(broadcastInput));\nconst broadcastOperation: CrewBroadcastOperation = createRemoteCrewBroadcastOperation({ send: async () => ({ dispositions: [], summary: { delivered: 0, failed: 0, total: 0 } }) });\nconst inProcessBroadcast = createInProcessCrewBroadcastOperation({} as InProcessCrewBroadcastOperationDependencies);\nconst redirectInput: RedirectInput = { message: "urgent" };\nconst redirectOperation: RedirectOperation = createRemoteRedirectOperation({ send: async (_command: RemoteRedirectCommand) => ({ member: { name: "Kelly", role: "qa" }, deliveryId: "redirect", disposition: "steered" }) });\nconst redirectResult: Promise<RedirectResult> = redirectOperation.redirectMember("Kelly", redirectInput);\nconst inProcessRedirect = createInProcessRedirectOperation({} as InProcessRedirectOperationDependencies);\nconst remoteRedirect: RemoteRedirectDependencies["send"] = async (_command) => ({ member: { name: "Kelly", role: "qa" }, deliveryId: "remote", disposition: "steered" });\nconst sourceRedirect = selected.then((source) => source.redirectMember("Kelly", redirectInput));\nconst ask: Promise<AskResult> = selected.then((source) => source.ask("developer", { question: "Review" }, { responseGraceSeconds: 30, totalWaitSeconds: 120 }));\nvoid operation;\nvoid status;\nvoid lastMessage;\nvoid followUpResult;\nvoid inProcessFollowUp;\nvoid inboxResult;\nvoid inProcessInbox;\nvoid broadcast;\nvoid broadcastOperation;\nvoid inProcessBroadcast;\nvoid redirectResult;\nvoid inProcessRedirect;\nvoid remoteRedirect;\nvoid sourceRedirect;\nvoid ask;\nvoid new BebopClientError("timeout");\n',
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
