import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { sendRpcCommand } from "../infra/rpc-client.ts";
import { resolveMemberEndpoint } from "../infra/socket-endpoint.ts";
import { createRpcServer, closeRpcServer } from "../infra/rpc-server.ts";
import { createSocketState, handleCommand } from "./control-runtime.ts";
import { handleMessageEndQueuedFollowUp } from "./queued-follow-up-handoff.ts";
import { QueuedFollowUpAcceptanceRegistry, isMessagePayload } from "../domain/index.ts";

/**
 * TASK-0139 red two-session regression for delayed Follow-up causality.
 *
 * Reproduction shape (05:37/05:50 incident): an old Follow-up is accepted as
 * QUEUED while the lead is busy; a newer assignment is DELIVERED DIRECTLY to
 * the idle developer; the lead later goes idle and the old Follow-up is handed
 * to the lead with immutable target-observed provenance. The recipient must be
 * able to distinguish chronology without inferring a Response.
 *
 * Both runtimes use the real `createRpcServer` + real `handleCommand` with a
 * Pi stub capturing `sendMessage`, exactly as extension.ts wires delivery;
 * handoff goes through the same message_end replacement seam the extension
 * registers. The clock is a fake counter for determinism.
 */

interface TargetRuntime {
	readonly state: ReturnType<typeof createSocketState>;
	readonly accepted: Array<{ message: Record<string, unknown>; options: unknown }>;
	readonly socketPath: string;
}

async function startTarget(root: string, name: string, clock: { now: number }): Promise<TargetRuntime> {
	const socketPath = path.join(root, `${name}.sock`);
	const state = createSocketState();
	state.queuedFollowUps = new QueuedFollowUpAcceptanceRegistry({ now: () => clock.now });
	state.membershipRuntime = {
		getMembership: () => ({
			manifestPath: "/project/.pi/bebop/crew.json",
			socketPath,
			member: { name, role: name, socketPath },
			manifest: { members: [{ name, role: name, socketPath }] },
		}),
	} as never;
	const accepted: TargetRuntime["accepted"] = [];
	let idle = name === "dev";
	state.context = {
		hasUI: false,
		sessionManager: { getSessionId: () => name, getSessionName: () => null, getEntries: () => [] },
		isIdle: () => idle,
		isCompacting: () => false,
		isProjectTrusted: () => true,
	} as never;
	(state.context as { isIdle: () => boolean }).isIdle = () => idle;
	const pi = {
		sendMessage: (message: unknown, options: unknown) => accepted.push({ message: message as never, options }),
		appendEntry: () => undefined,
	} as never;
	const server = await createRpcServer(socketPath, (command, socket) => handleCommand(pi, state, command, socket));
	return {
		state,
		accepted,
		socketPath,
		async stop() {
			await closeRpcServer(server);
		},
		setIdle(value: boolean) {
			idle = value;
		},
	} as TargetRuntime & { stop(): Promise<void>; setIdle(value: boolean): void };
}

function handoffMessages(target: TargetRuntime): Array<Record<string, unknown>> {
	// Pi wraps the accepted custom message as an AgentMessage (`role: "custom"`,
	// delivery timestamp) exactly when the agent loop hands it to the model —
	// that is the message_end event the extension seam observes.
	return target.accepted
		.map((entry) => entry.message)
		.filter((message) => (message as { details?: { deliveryId?: unknown } }).details?.deliveryId !== undefined)
		.map((message) =>
			handleMessageEndQueuedFollowUp(target.state, {
				role: "custom",
				timestamp: 2,
				...(message as Record<string, unknown>),
			}),
		)
		.filter((replacement): replacement is Record<string, unknown> => replacement !== undefined);
}

test("queued old Follow-up handed to busy lead after newer direct assignment stays chronology-distinguishable", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-queued-provenance-"));
	t.after(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});
	const clock = { now: 1_000 };
	const lead = await startTarget(root, "lead", clock);
	const dev = await startTarget(root, "dev", clock);
	t.after(async () => {
		await lead.stop();
		await dev.stop();
	});

	// 05:37 — old uncorrelated update accepted as QUEUED while the lead is busy.
	const leadEndpoint = await resolveMemberEndpoint(lead.socketPath);
	const queuedAck = await sendRpcCommand(
		leadEndpoint,
		{
			type: "send",
			payload: { content: "TASK-0011 completion facts", origin: { kind: "crew", name: "Dave", role: "dev" } },
			delivery: "follow_up",
		},
		{ timeout: 2_000 },
	);
	assert.equal(queuedAck.response.success, true);
	const queuedDeliveryId = (queuedAck.response.data as { deliveryId: string }).deliveryId;
	assert.equal((queuedAck.response.data as { disposition: string }).disposition, "queued");

	// 05:50 — newer assignment delivered DIRECTLY to the idle developer.
	const devEndpoint = await resolveMemberEndpoint(dev.socketPath);
	clock.now = 1_000 + 13 * 60_000 + 28_000;
	const directAck = await sendRpcCommand(
		devEndpoint,
		{
			type: "send",
			payload: { content: "TASK-0014 assignment", origin: { kind: "crew", name: "Mony", role: "lead" } },
			delivery: "follow_up",
		},
		{ timeout: 2_000 },
	);
	assert.equal((directAck.response.data as { disposition: string }).disposition, "direct");
	assert.equal(dev.accepted.length, 1);
	assert.equal(
		(dev.accepted[0].message as { details?: { deliveryId?: unknown } }).details?.deliveryId,
		undefined,
		"direct delivery gains no provenance seed",
	);

	// 05:51 — the lead finally goes idle; the old Follow-up is handed to the model.
	clock.now = 1_000 + 14 * 60_000 + 18_000;
	lead.setIdle(true);
	const handoffs = handoffMessages(lead);
	assert.equal(handoffs.length, 1, "exactly one queued handoff");
	const handed = handoffs[0];
	assert.match(String(handed.content), /^\[follow-up · queued 14m before delivery · uncorrelated\]/);
	assert.match(String(handed.content), /may predate newer coordination/);
	const payload = (handed.details as { messagePayload: unknown }).messagePayload;
	assert.ok(isMessagePayload(payload));
	assert.equal(payload.content, "TASK-0011 completion facts");
	const provenance = (handed.details as Record<string, unknown>).deliveryProvenance as {
		deliveryId: string;
		acceptedAt: number;
		handoffAt: number;
	};
	assert.equal(provenance.deliveryId, queuedDeliveryId, "structured provenance shares the acknowledged delivery ID");
	assert.equal(provenance.acceptedAt, 1_000);
	assert.equal(provenance.handoffAt, 1_000 + 14 * 60_000 + 18_000);
	// Chronology is recipient-visible without any response inference:
	// the assignment (13m28s) predates the old update's handoff (14m18s).
	assert.ok(provenance.handoffAt - provenance.acceptedAt > 13 * 60_000 + 28_000);
});

test("two queued Follow-ups hand off in FIFO acceptance order, each with its own immutable delay", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "bebop-queued-fifo-"));
	t.after(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});
	const clock = { now: 1_000 };
	const lead = await startTarget(root, "lead", clock);
	t.after(async () => {
		await lead.stop();
	});
	const endpoint = await resolveMemberEndpoint(lead.socketPath);
	const first = await sendRpcCommand(
		endpoint,
		{ type: "send", payload: { content: "first" }, delivery: "follow_up" },
		{ timeout: 2_000 },
	);
	clock.now = 4_000_000;
	const second = await sendRpcCommand(
		endpoint,
		{ type: "send", payload: { content: "second" }, delivery: "follow_up" },
		{ timeout: 2_000 },
	);
	assert.equal(first.response.data.disposition, "queued");
	assert.equal(second.response.data.disposition, "queued");

	const handoffs = handoffMessages(lead);
	assert.equal(handoffs.length, 2);
	assert.match(String(handoffs[0].content), /\bfirst\b/);
	assert.match(String(handoffs[1].content), /\bsecond\b/);
	const delays = handoffs.map(
		(h) => (h.details as { deliveryProvenance: { queueDelay: string } }).deliveryProvenance.queueDelay,
	);
	// Both computed once from their own acceptance, in FIFO order, immutable.
	assert.deepEqual(delays, ["1h", "0s"]);
	// Claim-once: a replayed handoff never rewrites the frozen content.
	assert.equal(handoffMessages(lead).length, 0);
});
