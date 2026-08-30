import assert from "node:assert/strict";
import test from "node:test";
import { createModelDeliveryAdapter } from "./compaction-delivery.ts";

test("model delivery starts durable append before terminal drain", async () => {
	const calls: string[] = [];
	let release!: () => void;
	const appendGate = new Promise<void>((resolve) => (release = resolve));
	const journal = {
		filePath: "/tmp/compaction.json",
		append: async (envelope: any) => {
			calls.push(`append:${envelope.id}`);
			await appendGate;
			return {
				version: 1 as const,
				id: envelope.id,
				sequence: 1,
				acceptedAt: 1,
				bytes: envelope.bytes,
				state: "pending" as const,
				envelope,
			};
		},
		listPending: async () => [],
		markHandingOff: async (id: string) => void calls.push(`handoff:${id}`),
		markDelivered: async (id: string) => void calls.push(`delivered:${id}`),
		reconcile: async () => undefined,
	};
	const adapter = createModelDeliveryAdapter(() => undefined);
	await adapter.configureJournal(journal);
	const generation = adapter.compactionStarted();
	assert.deepEqual(adapter.send({ customType: "crew", content: "deferred" }), { disposition: "deferred" });
	assert.deepEqual(calls, ["append:delivery-1"]);
	assert.equal(adapter.compactionEnded(generation), true);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(calls, ["append:delivery-1"]);
	release();
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(
		calls.map((call) => call.split(":")[0]),
		["append", "handoff", "delivered"],
	);
});

test("sendDurably waits for journal append before acknowledging deferred acceptance", async () => {
	let release!: () => void;
	const appendGate = new Promise<void>((resolve) => (release = resolve));
	const journal = {
		filePath: "/tmp/compaction.json",
		append: async (envelope: any) => {
			await appendGate;
			return {
				version: 1 as const,
				id: envelope.id,
				sequence: 1,
				acceptedAt: 1,
				bytes: envelope.bytes,
				state: "pending" as const,
				envelope,
			};
		},
		listPending: async () => [],
		markHandingOff: async () => undefined,
		markDelivered: async () => undefined,
		reconcile: async () => undefined,
	};
	const adapter = createModelDeliveryAdapter(() => undefined);
	await adapter.configureJournal(journal);
	const generation = adapter.compactionStarted();
	const acknowledgement = adapter.sendDurably({ customType: "crew", content: "deferred" });
	adapter.compactionEnded(generation);
	let settled = false;
	void acknowledgement.then(() => (settled = true));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(settled, false);
	release();
	assert.deepEqual(await acknowledgement, { disposition: "deferred", deferred: true });
});

test("sendDurably avoids a local id already allocated while reservation was in flight", async () => {
	const ids: string[] = [];
	let reservation = 0;
	const journal = {
		filePath: "/tmp/compaction.json",
		reserveId: async () => `delivery-${++reservation}`,
		append: async (envelope: any) => {
			ids.push(envelope.id);
			return {
				version: 1 as const,
				id: envelope.id,
				sequence: envelope.id === "delivery-1" ? 1 : 2,
				acceptedAt: 1,
				bytes: envelope.bytes,
				state: "pending" as const,
				envelope,
			};
		},
		listPending: async () => [],
		markHandingOff: async () => undefined,
		markDelivered: async () => undefined,
		reconcile: async () => undefined,
	};
	const adapter = createModelDeliveryAdapter(() => undefined);
	await adapter.configureJournal(journal);
	const generation = adapter.compactionStarted();
	const durable = adapter.sendDurably({ customType: "crew", content: "reserved" });
	assert.deepEqual(adapter.send({ customType: "crew", content: "local" }), { disposition: "deferred" });
	assert.deepEqual(await durable, { disposition: "deferred", deferred: true });
	assert.deepEqual(ids, ["delivery-1", "delivery-2"]);
	adapter.compactionEnded(generation);
});

test("sendDurably uses the journal reservation for its envelope id", async () => {
	const ids: string[] = [];
	const journal = {
		filePath: "/tmp/compaction.json",
		reserveId: async () => "delivery-41",
		append: async (envelope: any) => {
			ids.push(envelope.id);
			return {
				version: 1 as const,
				id: envelope.id,
				sequence: 42,
				acceptedAt: 1,
				bytes: envelope.bytes,
				state: "pending" as const,
				envelope,
			};
		},
		listPending: async () => [],
		markHandingOff: async () => undefined,
		markDelivered: async () => undefined,
		reconcile: async () => undefined,
	};
	const adapter = createModelDeliveryAdapter(() => undefined);
	await adapter.configureJournal(journal);
	const generation = adapter.compactionStarted();
	assert.deepEqual(await adapter.sendDurably({ customType: "crew", content: "reserved" }), {
		disposition: "deferred",
		deferred: true,
	});
	assert.deepEqual(ids, ["delivery-41"]);
	adapter.compactionEnded(generation);
});

test("reconfigure waits for in-flight durable persistence before replacing the journal", async () => {
	let release!: () => void;
	const appendGate = new Promise<void>((resolve) => (release = resolve));
	const makeJournal = (append: (envelope: any) => Promise<any>) => ({
		filePath: "/tmp/compaction.json",
		append,
		listPending: async () => [],
		markHandingOff: async () => undefined,
		markDelivered: async () => undefined,
		reconcile: async () => undefined,
	});
	const oldJournal = makeJournal(async (envelope) => {
		await appendGate;
		return {
			version: 1 as const,
			id: envelope.id,
			sequence: 1,
			acceptedAt: 1,
			bytes: envelope.bytes,
			state: "pending" as const,
			envelope,
		};
	});
	const newJournal = makeJournal(async (envelope) => ({
		version: 1 as const,
		id: envelope.id,
		sequence: 1,
		acceptedAt: 1,
		bytes: envelope.bytes,
		state: "pending" as const,
		envelope,
	}));
	const adapter = createModelDeliveryAdapter(() => undefined);
	await adapter.configureJournal(oldJournal);
	const generation = adapter.compactionStarted();
	const acceptance = adapter.sendDurably({ customType: "crew", content: "old" });
	adapter.compactionEnded(generation);
	const reconfigure = adapter.configureJournal(newJournal);
	let replaced = false;
	void reconfigure.then(() => (replaced = true));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(replaced, false);
	release();
	assert.deepEqual(await acceptance, { disposition: "deferred", deferred: true });
	await reconfigure;
});

test("concurrent journal reconfigurations serialize and preserve the last request", async () => {
	const order: string[] = [];
	const journal = (name: string) => ({
		filePath: `/tmp/${name}.json`,
		append: async (envelope: any) => ({
			version: 1 as const,
			id: envelope.id,
			sequence: 1,
			acceptedAt: 1,
			bytes: envelope.bytes,
			state: "pending" as const,
			envelope,
		}),
		listPending: async () => [],
		markHandingOff: async () => undefined,
		markDelivered: async () => undefined,
		reconcile: async () => order.push(name),
	});
	const adapter = createModelDeliveryAdapter(() => undefined);
	const first = journal("first");
	const second = journal("second");
	const third = journal("third");
	let releaseSecond!: () => void;
	const secondReady = new Promise<void>((resolve) => (releaseSecond = resolve));
	second.reconcile = async () => {
		order.push("second-start");
		await secondReady;
		order.push("second-end");
	};
	await adapter.configureJournal(first);
	order.length = 0;
	const configureSecond = adapter.configureJournal(second);
	await new Promise<void>((resolve) => setImmediate(resolve));
	const configureThird = adapter.configureJournal(third);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(order, ["second-start"]);
	releaseSecond();
	await Promise.all([configureSecond, configureThird]);
	assert.deepEqual(order, ["second-start", "second-end", "third"]);
});

test("deferred handoff waits for session evidence before marking delivered", async () => {
	const calls: string[] = [];
	let releaseEvidence!: () => void;
	const evidence = new Promise<void>((resolve) => (releaseEvidence = resolve));
	const journal = {
		filePath: "/tmp/compaction.json",
		append: async (envelope: any) => ({
			version: 1 as const,
			id: envelope.id,
			sequence: 1,
			acceptedAt: 1,
			bytes: envelope.bytes,
			state: "pending" as const,
			envelope,
		}),
		listPending: async () => [],
		markHandingOff: async () => calls.push("handoff"),
		markDelivered: async () => calls.push("delivered"),
		reconcile: async () => undefined,
	};
	const adapter = createModelDeliveryAdapter(() => calls.push("send"));
	await adapter.configureJournal(journal, undefined, async () => {
		await evidence;
		return true;
	});
	const generation = adapter.compactionStarted();
	const completion = adapter.sendAndWait({ customType: "crew", content: "evidence" });
	adapter.compactionEnded(generation);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(calls, ["handoff", "send"]);
	releaseEvidence();
	await completion;
	assert.deepEqual(calls, ["handoff", "send", "delivered"]);
});

test("markDelivered failure keeps handoff successful for the caller", async () => {
	const sent: unknown[] = [];
	const journal = {
		filePath: "/tmp/compaction.json",
		append: async (envelope: any) => ({
			version: 1 as const,
			id: envelope.id,
			sequence: 1,
			acceptedAt: 1,
			bytes: envelope.bytes,
			state: "pending" as const,
			envelope,
		}),
		listPending: async () => [],
		markHandingOff: async () => undefined,
		markDelivered: async () => {
			throw new Error("disk unavailable");
		},
		reconcile: async () => undefined,
	};
	const adapter = createModelDeliveryAdapter((message) => sent.push(message));
	await adapter.configureJournal(journal);
	const generation = adapter.compactionStarted();
	const completion = adapter.sendAndWait({ customType: "crew", content: "sent" });
	adapter.compactionEnded(generation);
	await completion;
	assert.equal(sent.length, 1);
});

test("model delivery persists and acknowledges a deferred handoff", async () => {
	const sent: unknown[] = [];
	const calls: string[] = [];
	const journal = {
		filePath: "/tmp/compaction.json",
		append: async (envelope: any) => {
			calls.push(`append:${envelope.id}`);
			return {
				version: 1 as const,
				id: envelope.id,
				sequence: 1,
				acceptedAt: 1,
				bytes: envelope.bytes,
				state: "pending" as const,
				envelope,
			};
		},
		listPending: async () => [],
		markHandingOff: async (id: string) => void calls.push(`handoff:${id}`),
		markDelivered: async (id: string) => void calls.push(`delivered:${id}`),
		reconcile: async () => undefined,
	};
	const adapter = createModelDeliveryAdapter((message) => sent.push(message));
	await adapter.configureJournal(journal);
	const generation = adapter.compactionStarted();
	assert.deepEqual(adapter.send({ customType: "crew", content: "deferred" }), { disposition: "deferred" });
	assert.equal(adapter.compactionEnded(generation), true);
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(sent.length, 1);
	assert.deepEqual(
		calls.map((call) => call.split(":")[0]),
		["append", "handoff", "delivered"],
	);
});

test("mixed model-bound surfaces retain FIFO payloads, options, and correlation metadata", async () => {
	const sent: Array<{ message: any; options: unknown }> = [];
	const journal = {
		filePath: "/tmp/compaction.json",
		append: async (envelope: any) => ({
			version: 1 as const,
			id: envelope.id,
			sequence: Number(envelope.id.split("-")[1]),
			acceptedAt: 1,
			bytes: envelope.bytes,
			state: "pending" as const,
			envelope,
		}),
		listPending: async () => [],
		markHandingOff: async () => undefined,
		markDelivered: async () => undefined,
		reconcile: async () => undefined,
	};
	const adapter = createModelDeliveryAdapter((message, options) => sent.push({ message, options }));
	await adapter.configureJournal(journal);
	const fixtures = [
		["follow-up", { triggerTurn: true, deliverAs: "followUp" }],
		["redirect", { triggerTurn: true, deliverAs: "steer" }],
		["request", { triggerTurn: true }],
		["request-reminder", { triggerTurn: true, deliverAs: "followUp" }],
		["response-resume", { triggerTurn: true, deliverAs: "steer" }],
		["inbox", { triggerTurn: true, deliverAs: "followUp" }],
		["broadcast", { triggerTurn: true }],
		["intake", { triggerTurn: true }],
		["crew-letter", { triggerTurn: true }],
		["interrupt-recovery", { triggerTurn: true }],
		["presence", { triggerTurn: false }],
		["control-response", { triggerTurn: false }],
	] as const;
	const originals = fixtures.map(([surface]) => ({
		customType: "crew",
		content: `${surface} content`,
		details: {
			surface,
			messagePayload: { content: `${surface} payload`, instructions: [`${surface} instruction`] },
			correlation: `${surface}-correlation`,
		},
	}));
	const generation = adapter.compactionStarted();
	for (let index = 0; index < originals.length; index += 1) {
		assert.deepEqual(await adapter.sendDurably(originals[index], fixtures[index][1]), {
			disposition: "deferred",
			deferred: true,
		});
	}
	assert.deepEqual(sent, []);
	assert.equal(adapter.compactionEnded(generation), true);
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(
		sent.map(({ message }) => message.details.surface),
		fixtures.map(([surface]) => surface),
	);
	assert.deepEqual(
		sent.map(({ options }) => options),
		fixtures.map(([, options]) => options),
	);
	for (let index = 0; index < originals.length; index += 1) {
		assert.deepEqual(sent[index].message.content, originals[index].content);
		assert.deepEqual(sent[index].message.details.messagePayload, originals[index].details.messagePayload);
		assert.deepEqual(sent[index].message.details.correlation, originals[index].details.correlation);
		assert.equal(sent[index].message.details.deliveryId, `delivery-${index + 1}`);
		assert.equal(originals[index].details.deliveryId, undefined);
	}
});

test("model delivery drains journal-backed messages in FIFO handoff order", async () => {
	const sent: string[] = [];
	const journal = {
		filePath: "/tmp/compaction.json",
		append: async (envelope: any) => ({
			version: 1 as const,
			id: envelope.id,
			sequence: Number(envelope.id.split("-")[1]),
			acceptedAt: 1,
			bytes: envelope.bytes,
			state: "pending" as const,
			envelope,
		}),
		listPending: async () => [],
		markHandingOff: async () => undefined,
		markDelivered: async () => undefined,
		reconcile: async () => undefined,
	};
	const adapter = createModelDeliveryAdapter((message: any) => sent.push(message.content));
	await adapter.configureJournal(journal);
	const generation = adapter.compactionStarted();
	adapter.send({ customType: "crew", content: "first" });
	adapter.send({ customType: "crew", content: "second" });
	adapter.compactionEnded(generation);
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(sent, ["first", "second"]);
});

test("model delivery preserves complete message and delivery options while open", () => {
	const sent: unknown[] = [];
	const adapter = createModelDeliveryAdapter((message, options) => {
		sent.push({ message, options });
	});
	const message = { customType: "crew", content: "hello", details: { messagePayload: { id: 1 } } };
	assert.deepEqual(adapter.send(message, { triggerTurn: true, deliverAs: "followUp" }), { disposition: "direct" });
	assert.deepEqual(sent, [{ message, options: { triggerTurn: true, deliverAs: "followUp" } }]);
});

test("model delivery rejects unserializable envelopes without sending", () => {
	const adapter = createModelDeliveryAdapter(() => assert.fail("must not send"));
	const circular: Record<string, unknown> = {};
	circular.self = circular;
	assert.deepEqual(adapter.send(circular), { disposition: "invalid" });
});

test("model delivery injects its durable id into journal-backed messages", async () => {
	const sent: any[] = [];
	const journal = {
		filePath: "/tmp/compaction.json",
		append: async (envelope: any) => ({
			version: 1 as const,
			id: envelope.id,
			sequence: 1,
			acceptedAt: 1,
			bytes: envelope.bytes,
			state: "pending" as const,
			envelope,
		}),
		listPending: async () => [],
		markHandingOff: async () => undefined,
		markDelivered: async () => undefined,
		reconcile: async () => undefined,
	};
	const adapter = createModelDeliveryAdapter((message) => sent.push(message));
	await adapter.configureJournal(journal);
	const generation = adapter.compactionStarted();
	const message = { customType: "crew", content: "id", details: { requestId: "request-1" } };
	adapter.send(message);
	adapter.compactionEnded(generation);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal((sent[0].details as any).requestId, "request-1");
	assert.equal((sent[0].details as any).deliveryId, "delivery-1");
	assert.equal((message.details as any).deliveryId, undefined);
});

test("model delivery drops replayed requests whose source channel was lost", async () => {
	const sent: unknown[] = [];
	const removed: string[] = [];
	const journal = {
		filePath: "/tmp/compaction.json",
		append: async (envelope: any) => ({
			version: 1 as const,
			id: envelope.id,
			sequence: 1,
			acceptedAt: 1,
			bytes: envelope.bytes,
			state: "pending" as const,
			envelope,
		}),
		listPending: async () => [
			{
				version: 1 as const,
				id: "delivery-1",
				sequence: 1,
				acceptedAt: 1,
				bytes: 32,
				state: "pending" as const,
				envelope: {
					id: "delivery-1",
					bytes: 32,
					message: {
						customType: "crew",
						content: "request",
						details: {
							crewRequestId: "request-1",
							messagePayload: {
								content: "request",
								origin: { kind: "crew", name: "Mony", role: "lead" },
							},
						},
					},
					delivery: { triggerTurn: true },
					metadata: { deliveryId: "delivery-1" },
				},
			},
		],
		markHandingOff: async () => undefined,
		markDelivered: async (id: string) => void removed.push(id),
		reconcile: async () => undefined,
	};
	const adapter = createModelDeliveryAdapter((message) => sent.push(message));
	await adapter.configureJournal(journal, undefined, undefined, () => false);
	assert.deepEqual(sent, []);
	assert.deepEqual(removed, ["delivery-1"]);
});

test("model delivery resumes durable IDs after an adapter restart", async () => {
	const ids: string[] = [];
	let nextSequence = 1;
	const journal = {
		filePath: "/tmp/compaction.json",
		nextSequence: async () => nextSequence,
		append: async (envelope: any) => {
			ids.push(envelope.id);
			nextSequence += 1;
			return {
				version: 1 as const,
				id: envelope.id,
				sequence: nextSequence - 1,
				acceptedAt: 1,
				bytes: envelope.bytes,
				state: "pending" as const,
				envelope,
			};
		},
		listPending: async () => [],
		markHandingOff: async () => undefined,
		markDelivered: async () => undefined,
		reconcile: async () => undefined,
	};
	const first = createModelDeliveryAdapter(() => undefined);
	await first.configureJournal(journal);
	const firstGeneration = first.compactionStarted();
	first.send({ customType: "crew", content: "first" });
	first.compactionEnded(firstGeneration);
	await new Promise<void>((resolve) => setImmediate(resolve));
	const second = createModelDeliveryAdapter(() => undefined);
	await second.configureJournal(journal);
	const secondGeneration = second.compactionStarted();
	second.send({ customType: "crew", content: "second" });
	second.compactionEnded(secondGeneration);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(ids, ["delivery-1", "delivery-2"]);
});

test("model delivery replays an ambiguously handed-off envelope with bounded provenance", async () => {
	const sent: any[] = [];
	const journal = {
		filePath: "/tmp/compaction.json",
		append: async (envelope: any) => ({
			version: 1 as const,
			id: envelope.id,
			sequence: 2,
			acceptedAt: 1,
			bytes: envelope.bytes,
			state: "pending" as const,
			replayAttempts: 0 as const,
			envelope,
		}),
		listPending: async () => [
			{
				version: 1 as const,
				id: "delivery-1",
				sequence: 1,
				acceptedAt: 1,
				bytes: 32,
				state: "handing-off" as const,
				replayAttempts: 1 as const,
				envelope: {
					id: "delivery-1",
					bytes: 32,
					message: { customType: "crew", content: "hello", details: { source: "original" } },
					delivery: { triggerTurn: true },
					metadata: { deliveryId: "delivery-1" },
				},
			},
		],
		markHandingOff: async () => undefined,
		markDelivered: async () => undefined,
		reconcile: async () => undefined,
	};
	const adapter = createModelDeliveryAdapter((message) => sent.push(message));
	await adapter.configureJournal(journal);
	const generation = adapter.compactionStarted();
	adapter.compactionEnded(generation);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(sent.length, 1);
	assert.equal(sent[0].content, "[replayed after ambiguous restart; possible duplicate]\n\nhello");
	assert.deepEqual(sent[0].details.deliveryReplay, {
		kind: "ambiguous-restart",
		possibleDuplicate: true,
	});
	assert.equal(sent[0].details.deliveryId, "delivery-1");
});

test("model delivery keeps a replay-blocked head from reaching Pi", async () => {
	const sent: unknown[] = [];
	const appended: string[] = [];
	const journal = {
		filePath: "/tmp/compaction.json",
		append: async (envelope: any) => {
			appended.push(envelope.id);
			return {
				version: 1 as const,
				id: envelope.id,
				sequence: 2,
				acceptedAt: 1,
				bytes: envelope.bytes,
				state: "pending" as const,
				replayAttempts: 0 as const,
				envelope,
			};
		},
		listPending: async () => [
			{
				version: 1 as const,
				id: "delivery-1",
				sequence: 1,
				acceptedAt: 1,
				bytes: 32,
				state: "replay-blocked" as const,
				replayAttempts: 1 as const,
				envelope: {
					id: "delivery-1",
					bytes: 32,
					message: { customType: "crew", content: "blocked" },
					delivery: { triggerTurn: true },
					metadata: { deliveryId: "delivery-1" },
				},
			},
		],
		markHandingOff: async () => undefined,
		markDelivered: async () => undefined,
		reconcile: async () => undefined,
	};
	const adapter = createModelDeliveryAdapter((message) => sent.push(message));
	let blockedNotified = 0;
	await adapter.configureJournal(journal, undefined, undefined, undefined, () => blockedNotified++);
	const generation = adapter.compactionStarted();
	adapter.compactionEnded(generation);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(sent, []);
	assert.equal(blockedNotified, 1);
	assert.deepEqual(await adapter.sendDurably({ customType: "crew", content: "later" }), {
		disposition: "deferred",
		deferred: true,
	});
	assert.deepEqual(appended, ["delivery-2"]);
});

test("model delivery graceful shutdown closes acceptance without replaying queued work", async () => {
	const sent: unknown[] = [];
	let gracefullyReconciled = 0;
	const journal = {
		filePath: "/tmp/compaction.json",
		append: async (envelope: any) => ({
			version: 1 as const,
			id: envelope.id,
			sequence: 1,
			acceptedAt: 1,
			bytes: envelope.bytes,
			state: "pending" as const,
			replayAttempts: 0 as const,
			envelope,
		}),
		listPending: async () => [],
		markHandingOff: async () => undefined,
		markDelivered: async () => undefined,
		reconcile: async () => undefined,
		reconcileGracefully: async () => {
			gracefullyReconciled++;
		},
	};
	const adapter = createModelDeliveryAdapter((message) => sent.push(message));
	await adapter.configureJournal(journal, async () => false);
	const generation = adapter.compactionStarted();
	assert.deepEqual(adapter.send({ customType: "crew", content: "queued" }), { disposition: "deferred" });
	await adapter.gracefulShutdown!();
	assert.equal(gracefullyReconciled, 1);
	assert.deepEqual(adapter.compactionEnded(generation), true);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(sent, []);
	assert.deepEqual(adapter.send({ customType: "crew", content: "after shutdown" }), { disposition: "invalid" });
});

test("model delivery resolves sendAndWait only after deferred handoff", async () => {
	const sent: unknown[] = [];
	const adapter = createModelDeliveryAdapter((message, options) => sent.push({ message, options }));
	const generation = adapter.compactionStarted();
	let settled = false;
	const completion = adapter
		.sendAndWait({ customType: "crew", content: "request" }, { triggerTurn: true })
		.then(() => {
			settled = true;
		});
	assert.equal(settled, false);
	assert.deepEqual(adapter.compactionEnded(generation), true);
	await completion;
	assert.equal(settled, true);
	assert.equal(sent.length, 1);
});

test("model delivery defers Pi handoff until the terminal lifecycle task", async () => {
	const sent: unknown[] = [];
	const adapter = createModelDeliveryAdapter((message, options) => sent.push({ message, options }));
	const generation = adapter.compactionStarted();
	const message = { customType: "crew", content: "deferred", details: { messagePayload: { id: 2 } } };
	assert.deepEqual(adapter.send(message, { triggerTurn: true }), { disposition: "deferred" });
	assert.deepEqual(sent, []);
	assert.equal(adapter.compactionEnded(generation), true);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(sent, [{ message, options: { triggerTurn: true } }]);
});
