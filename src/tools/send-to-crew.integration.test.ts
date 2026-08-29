import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SESSION_MESSAGE_TYPE, type MessagePayload } from "../domain/index.ts";
import { openTrustedMemberInboxStore } from "../infra/member-inbox-store.ts";
import type { SocketState } from "../pi/control-runtime.ts";
import { createInboxBridgeController, ownershipFromMembership } from "../pi/inbox-bridge-runtime.ts";
import { registerSendToCrewTool } from "./send-to-crew.ts";

type RegisteredTool = {
	execute(
		toolCallId: string,
		params: { manifestPath: string; message: string; instructions?: readonly string[] },
	): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean; details: unknown }>;
};

type Layout = "bebop" | "crew";

function manifestPath(root: string, layout: Layout): string {
	return path.join(root, `.pi/${layout}/crew.json`);
}

function member(name: string, role: string, root: string, layout: Layout) {
	return {
		name,
		role,
		socket: `sockets/${name.toLowerCase()}.sock`,
		socketPath: path.join(root, `.pi/${layout}/sockets/${name.toLowerCase()}.sock`),
	};
}

function registerTool(membership: unknown): RegisteredTool {
	let tool: RegisteredTool | undefined;
	const pi = {
		registerTool(value: unknown) {
			tool = value as RegisteredTool;
		},
	} as unknown as ExtensionAPI;
	const state = { membershipRuntime: { getMembership: () => membership } } as never as SocketState;
	registerSendToCrewTool(pi, state);
	assert.ok(tool, "send_to_crew must be registered");
	return tool;
}

function recipientBridge(membership: any) {
	const entries: unknown[] = [];
	const sent: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }> = [];
	const pi = {
		sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>) {
			sent.push({ message, options });
		},
		appendEntry() {},
	} as unknown as ExtensionAPI;
	const state = {
		context: { sessionManager: { getEntries: () => entries }, isProjectTrusted: () => true },
		membershipRuntime: { getMembership: () => membership },
		modelDelivery: {
			send: (message: unknown, options: unknown) => {
				pi.sendMessage(message as never, options as never);
				return { disposition: "direct" };
			},
			sendDurably: async (message: unknown, options: unknown) => {
				pi.sendMessage(message as never, options as never);
				return { disposition: "direct" };
			},
			sendAndWait: async () => ({ disposition: "direct" }),
			configureJournal: async () => undefined,
			compactionStarted: () => 0,
			compactionEnded: () => false,
		},
	} as unknown as SocketState;
	const bridge = createInboxBridgeController(pi, state);
	bridge.establish(ownershipFromMembership(membership));
	return { bridge, sent };
}

async function writeManifest(
	root: string,
	layout: Layout,
	name: string | undefined,
	members: readonly ReturnType<typeof member>[],
	contact: string,
): Promise<string> {
	const file = manifestPath(root, layout);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(
		file,
		JSON.stringify({ version: 1, ...(name === undefined ? {} : { name }), members, intake: { contact } }),
		"utf8",
	);
	return file;
}

async function inboxItem(root: string, layout: Layout, contact: ReturnType<typeof member>) {
	const store = await openTrustedMemberInboxStore({
		manifestPath: manifestPath(root, layout),
		projectRoot: root,
		isProjectTrusted: () => true,
		member: contact,
	});
	return await store.peekOldest();
}

test("TASK-0137: two offline Crews exchange one-way correspondence through the public tool in both layouts", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-correspondence-tool-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));

	for (const scenario of [
		{
			sourceLayout: "bebop" as const,
			targetLayout: "crew" as const,
			sourceName: "Alpha Crew",
			targetName: "Beta Crew",
		},
		{ sourceLayout: "crew" as const, targetLayout: "bebop" as const, sourceName: undefined, targetName: undefined },
	]) {
		const alphaRoot = path.join(root, `${scenario.sourceLayout}-alpha`);
		const betaRoot = path.join(root, `${scenario.targetLayout}-beta`);
		const alphaContact = member("Mony", "lead", alphaRoot, scenario.sourceLayout);
		const alphaSender = member("Dave", "developer", alphaRoot, scenario.sourceLayout);
		const betaContact = member("Kelly", "qa", betaRoot, scenario.targetLayout);
		const betaPeer = member("Mary", "product", betaRoot, scenario.targetLayout);
		const alphaManifest = await writeManifest(
			alphaRoot,
			scenario.sourceLayout,
			scenario.sourceName,
			[alphaContact, alphaSender],
			"Mony",
		);
		const betaManifest = await writeManifest(
			betaRoot,
			scenario.targetLayout,
			scenario.targetName,
			[betaContact, betaPeer],
			"Kelly",
		);

		const ask = registerTool({
			member: alphaSender,
			socketPath: alphaSender.socketPath,
			manifestPath: alphaManifest,
			manifest: {
				version: 1,
				...(scenario.sourceName === undefined ? {} : { name: scenario.sourceName }),
				members: [],
			},
		});
		const askResult = await ask.execute("ask", { manifestPath: betaManifest, message: "Can Beta review this?" });
		assert.equal(askResult.isError, undefined);
		assert.match(askResult.content[0]!.text, /persisted/i);
		assert.doesNotMatch(askResult.content[0]!.text, /delivered|acknowledged|response|online/i);
		assert.equal(
			await fs.stat(betaContact.socketPath).then(
				() => true,
				() => false,
			),
			false,
			"target remains offline",
		);

		const betaMembership = {
			member: betaContact,
			socketPath: betaContact.socketPath,
			manifestPath: betaManifest,
			manifest: {
				version: 1,
				...(scenario.targetName === undefined ? {} : { name: scenario.targetName }),
				members: [],
			},
		};
		const recipient = recipientBridge(betaMembership);
		const handoff = await recipient.bridge.attemptOffer();
		assert.equal(handoff.offered, true, "offline target contact receives a handoff on its next bridge trigger");
		assert.equal(recipient.sent.length, 1);
		assert.deepEqual(recipient.sent[0]!.options, { triggerTurn: true, deliverAs: "followUp" });
		const handedOff = recipient.sent[0]!.message;
		assert.equal(handedOff.customType, SESSION_MESSAGE_TYPE);
		assert.deepEqual(handedOff.details, {
			messagePayload: {
				content: "Can Beta review this?",
				origin: { kind: "crew", name: "Dave", role: "developer" },
				crewReturnAddress: {
					manifestPath: alphaManifest,
					...(scenario.sourceName === undefined ? {} : { crewName: scenario.sourceName }),
				},
			},
			inbox: {
				itemId: handoff.itemId,
				...(scenario.targetName === undefined ? {} : { crewName: scenario.targetName }),
			},
		});
		const payload = (handedOff.details as { messagePayload: MessagePayload }).messagePayload;
		assert.equal("replyTo" in payload, false);
		assert.doesNotMatch(JSON.stringify(payload), /socket|session|alias/i);

		const reply = registerTool(betaMembership);
		const replyResult = await reply.execute("reply", {
			manifestPath: payload.crewReturnAddress!.manifestPath,
			message: "Beta can review it.",
		});
		assert.equal(replyResult.isError, undefined);
		assert.match(replyResult.content[0]!.text, /persisted/i);

		const answer = await inboxItem(alphaRoot, scenario.sourceLayout, alphaContact);
		assert.ok(answer, "source contact receives durable reply");
		assert.deepEqual(answer.payload, {
			content: "Beta can review it.",
			origin: { kind: "crew", name: "Kelly", role: "qa" },
			crewReturnAddress: {
				manifestPath: betaManifest,
				...(scenario.targetName === undefined ? {} : { crewName: scenario.targetName }),
			},
		} satisfies MessagePayload);
	}
});
