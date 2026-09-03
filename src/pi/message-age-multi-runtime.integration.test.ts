import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createInboxBridgeController, ownershipFromMembership } from "./inbox-bridge-runtime.ts";
import { createSocketState, handleCommand } from "./control-runtime.ts";
import { createRpcServer, closeRpcServer } from "../infra/rpc-server.ts";
import { sendRpcCommand } from "../infra/rpc-client.ts";
import { openTrustedMemberInboxStore } from "../infra/member-inbox-store.ts";
import type { MessagePayload } from "../domain/index.ts";

test("multi-runtime transient and hours-old durable messages keep exact frozen headers", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-message-age-multi-runtime-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const layout = path.join(root, ".pi", "bebop");
	const sockets = path.join(layout, "sockets");
	await fs.mkdir(sockets, { recursive: true });
	const manifestPath = path.join(layout, "crew.json");
	const targetSocket = path.join(sockets, "Kelly.sock");
	await fs.writeFile(
		manifestPath,
		JSON.stringify({
			version: 1,
			members: [
				{ name: "Tony", role: "lead", socket: "sockets/Tony.sock" },
				{ name: "Kelly", role: "qa", socket: "sockets/Kelly.sock" },
			],
		}),
	);
	const entries: unknown[] = [];
	const messages: string[] = [];
	const membership = {
		manifestPath,
		socketPath: targetSocket,
		globalSocketPath: path.join(root, "global.sock"),
		member: { name: "Kelly", role: "qa", socketPath: targetSocket },
		manifest: {
			version: 1,
			members: [
				{ name: "Tony", role: "lead", socketPath: path.join(sockets, "Tony.sock") },
				{ name: "Kelly", role: "qa", socketPath: targetSocket },
			],
			presence: { notifications: true },
		},
	};
	const targetState = createSocketState(() => 90_000_000);
	targetState.server = {} as never;
	targetState.context = {
		sessionManager: { getEntries: () => entries },
		isIdle: () => false,
		isProjectTrusted: () => true,
	} as never;
	targetState.membershipRuntime = { getMembership: () => membership } as never;
	const pi = {
		sendMessage: (message: { content: string; details?: unknown }) => {
			messages.push(message.content);
			entries.push({ type: "custom_message", customType: "bebop-session-message", details: message.details });
		},
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
	} as unknown as ExtensionAPI;
	const server = await createRpcServer(targetSocket, (command, socket) =>
		handleCommand(pi, targetState, command, socket),
	);
	t.after(() => closeRpcServer(server));

	const transientPayload: MessagePayload = {
		content: "transient now",
		origin: { kind: "crew", name: "Tony", role: "lead" },
		kind: "follow-up",
		sentAt: 0,
	};
	const transient = await sendRpcCommand(targetSocket, {
		type: "send",
		payload: transientPayload,
		delivery: "follow_up",
	});
	assert.equal(transient.response.success, true);
	assert.equal(
		messages[0],
		'[follow-up] from Tony (lead) · age at delivery 1d 1h\nInformation only; no correlated Response expected.\n{"type":"message-context","content":"transient now","origin":{"kind":"crew","name":"Tony","role":"lead"}}',
	);

	const store = await openTrustedMemberInboxStore({
		manifestPath,
		projectRoot: root,
		isProjectTrusted: () => true,
		member: { name: "Kelly", role: "qa", socketPath: targetSocket },
	});
	await store.enqueue(
		{
			content: "durable then",
			origin: { kind: "crew", name: "Tony", role: "lead" },
			kind: "inbox",
		} satisfies MessagePayload,
		0,
	);
	const bridge = createInboxBridgeController(pi, targetState, {
		now: () => 90_000_000,
		openStore: async () => store,
	});
	bridge.establish(ownershipFromMembership(membership));
	assert.equal((await bridge.attemptOffer()).offered, true);
	assert.equal(
		messages[1],
		'[inbox] from Tony (lead) · age at delivery 1d 1h\n{"type":"message-context","content":"durable then","origin":{"kind":"crew","name":"Tony","role":"lead"}}',
	);
});
