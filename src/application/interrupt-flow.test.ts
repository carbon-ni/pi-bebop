import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createInterruptFlow, hasPendingInterrupt, latestInterruptEvidence } from "./interrupt-flow.ts";
import type { MessagePayload } from "../domain/index.ts";

const PAYLOAD = (content: string): MessagePayload => ({
	content,
	origin: { kind: "crew", name: "Tony", role: "lead" },
});

test("interrupt evidence ignores malformed records and finds the latest valid phase", () => {
	const valid = {
		type: "custom",
		customType: "intray-interrupt",
		data: { phase: "pending", interruptId: "i1", targetName: "Bob", senderName: "Tony", abortRequested: true },
	};
	assert.deepEqual(
		latestInterruptEvidence([
			{ type: "message" },
			{ type: "custom", customType: "intray-interrupt", data: {} },
			valid,
		]),
		{
			phase: "pending",
			interruptId: "i1",
			targetName: "Bob",
			senderName: "Tony",
			abortRequested: true,
		},
	);
	assert.equal(latestInterruptEvidence([]), null);
	assert.equal(hasPendingInterrupt([valid], "Bob"), true);
	assert.equal(hasPendingInterrupt([{ ...valid, data: { ...valid.data, phase: "handed-off" } }], "Bob"), false);
});

interface Surface {
	isIdle: () => boolean;
	abort: () => Promise<void>;
	sendMessage: (message: unknown, options?: unknown) => Promise<void> | void;
	appendEntry: (customType: string, data?: unknown) => void;
	getEntries: () => readonly unknown[];
}

function makeSurface(overrides: Partial<Surface> = {}): Surface {
	const entries: unknown[] = [];
	return {
		isIdle: () => true,
		abort: async () => {},
		sendMessage: () => {},
		appendEntry: (customType, data) => {
			entries.push({ type: "custom", customType, data });
		},
		getEntries: () => entries,
		...overrides,
	};
}

describe("createInterruptFlow", () => {
	test("idle target: persists pending, delivers recovery direct, marks handed-off", async () => {
		const surface = makeSurface();
		const flow = createInterruptFlow(surface);
		const result = await flow.interrupt(PAYLOAD("stop now"));
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.disposition, "direct");
		assert.match(result.interruptId, /^interrupt-/);
		// pending then handed-off evidence both persisted
		const custom = surface.getEntries().filter((e) => (e as { type: string }).type === "custom");
		assert.equal(custom.length, 2);
		const [pending, handed] = custom as Array<{ data: { phase: string; interruptId: string } }>;
		assert.equal(pending.data.phase, "pending");
		assert.equal(handed.data.phase, "handed-off");
		assert.equal(pending.data.interruptId, handed.data.interruptId);
	});

	test("new Interrupt sentAt survives pending evidence and recovery", async () => {
		let delivered: Record<string, unknown> | undefined;
		const surface = makeSurface({
			now: () => 5_000,
			sendMessage: (message) => {
				delivered = message as Record<string, unknown>;
			},
		});
		const flow = createInterruptFlow(surface);
		const payload: MessagePayload = {
			...PAYLOAD("stop now"),
			kind: "interrupt",
			sentAt: 3_000,
		};
		await flow.interrupt(payload);
		const pending = surface.getEntries()[0] as { data: { sentAt?: number } };
		assert.equal(pending.data.sentAt, 3_000);
		assert.equal((delivered?.details as { messagePayload: MessagePayload }).messagePayload.sentAt, 3_000);

		const recovered = makeSurface({
			now: () => 6_000,
			sendMessage: (message) => (delivered = message as Record<string, unknown>),
		});
		recovered.appendEntry("intray-interrupt", {
			phase: "pending",
			interruptId: "interrupt-sent-time",
			targetName: "Tony",
			senderName: "Mary",
			abortRequested: false,
			sentAt: 3_000,
			content: "recover me",
		});
		await createInterruptFlow(recovered).recoverPending();
		assert.equal((delivered?.details as { messagePayload: MessagePayload }).messagePayload.sentAt, 3_000);
	});
	test("busy target: persists pending BEFORE abort, requests abort, steers recovery, marks handed-off", async () => {
		const order: string[] = [];
		const surface = makeSurface({
			isIdle: () => false,
			abort: async () => {
				order.push("abort");
			},
			sendMessage: (_m, options) => {
				order.push(`send:${(options as { deliverAs?: string }).deliverAs ?? "turn"}`);
			},
			appendEntry: (customType) => {
				order.push(`append:${customType}`);
			},
		});
		const flow = createInterruptFlow(surface);
		const result = await flow.interrupt(PAYLOAD("stop now"));
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.disposition, "interrupt-requested");
		// pending evidence BEFORE abort; recovery steer after abort; handed-off last
		assert.deepEqual(order, ["append:intray-interrupt", "abort", "send:steer", "append:intray-interrupt"]);
	});

	test("rejects a concurrent pending interrupt for the same target, allows after handoff", async () => {
		// Concurrent: force abort to fail so the first stays pending (no handed-off).
		const surface = makeSurface({
			isIdle: () => false,
			abort: async () => {
				throw new Error("abort failed");
			},
		});
		const flow = createInterruptFlow(surface);
		const first = await flow.interrupt(PAYLOAD("first"));
		assert.equal(first.ok, false); // stays pending
		const second = await flow.interrupt(PAYLOAD("second"));
		assert.equal(second.ok, false);
		if (!second.ok) return;
		assert.equal(second.code, "already-pending");

		// After a successful handoff, a new interrupt is allowed.
		const okSurface = makeSurface({ isIdle: () => true });
		const okFlow = createInterruptFlow(okSurface);
		const a = await okFlow.interrupt(PAYLOAD("one"));
		assert.equal(a.ok, true);
		const b = await okFlow.interrupt(PAYLOAD("two"));
		assert.equal(b.ok, true, "a handed-off interrupt must not block a new one");
	});

	test("abort failure produces a deterministic error without a handed-off entry", async () => {
		const surface = makeSurface({
			isIdle: () => false,
			abort: async () => {
				throw new Error("abort failed");
			},
		});
		const flow = createInterruptFlow(surface);
		const result = await flow.interrupt(PAYLOAD("stop"));
		assert.equal(result.ok, false);
		if (!result.ok) return;
		assert.equal(result.code, "abort-failed");
		// pending evidence persisted, no handed-off
		const phases = surface
			.getEntries()
			.map((e) => (e as { data?: { phase?: string } }).data?.phase)
			.filter(Boolean);
		assert.deepEqual(phases, ["pending"]);
	});

	test("malformed payload rejected before any side effect", async () => {
		const surface = makeSurface();
		const flow = createInterruptFlow(surface);
		const result = await flow.interrupt({ content: "" } as MessagePayload);
		assert.equal(result.ok, false);
		if (!result.ok) return;
		assert.equal(result.code, "invalid-payload");
		assert.equal(surface.getEntries().length, 0);
	});
});

describe("reload recovery (exactly-once handoff)", () => {
	test("pending-without-handed-off is re-delivered and marked handed-off", async () => {
		// Simulate crash after pending persist but before handoff: the persisted
		// pending evidence lives in the session branch, so the recovered surface
		// starts with that entry already present.
		const pendingEvidence = {
			phase: "pending",
			interruptId: "interrupt-crash-1",
			targetName: "Tony",
			senderName: "Mary",
			abortRequested: true,
			content: "recover me",
		};
		// Start from the default surface (closure-backed appendEntry/getEntries),
		// then pre-seed the pending evidence into the shared entries array.
		const recovered = makeSurface();
		recovered.appendEntry("intray-interrupt", pendingEvidence);
		const flow = createInterruptFlow(recovered);
		const result = await flow.recoverPending();
		assert.equal(result?.interruptId, "interrupt-crash-1");
		const phases = recovered
			.getEntries()
			.map((e) => (e as { data?: { phase?: string } }).data?.phase)
			.filter(Boolean);
		assert.deepEqual(phases, ["pending", "handed-off"]);
	});

	test("handed-off evidence means no re-delivery", async () => {
		const surface = makeSurface();
		const flow = createInterruptFlow(surface);
		surface.appendEntry("intray-interrupt", {
			phase: "handed-off",
			interruptId: "interrupt-done-1",
			targetName: "Tony",
			senderName: "Mary",
			abortRequested: false,
			deliveredAt: 123,
			content: "done",
		});
		assert.equal(await flow.recoverPending(), null);
	});

	test("recovery re-delivery is idempotent: second call finds nothing pending", async () => {
		const surface = makeSurface();
		const flow = createInterruptFlow(surface);
		surface.appendEntry("intray-interrupt", {
			phase: "pending",
			interruptId: "interrupt-2",
			targetName: "Tony",
			senderName: "Mary",
			abortRequested: true,
			content: "again",
		});
		const first = await flow.recoverPending();
		assert.equal(first?.interruptId, "interrupt-2");
		assert.equal(await flow.recoverPending(), null);
	});
});
