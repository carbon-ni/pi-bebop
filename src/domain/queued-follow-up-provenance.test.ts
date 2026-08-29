import test from "node:test";
import assert from "node:assert/strict";
import {
	DeliveryProvenanceSchema,
	QueuedFollowUpAcceptanceRegistry,
	formatQueueDelay,
	isDeliveryProvenance,
	queuedFollowUpLabel,
	renderQueuedFollowUpModelContent,
} from "./queued-follow-up-provenance.ts";
import { parseRenderedMessagePayload } from "./message-renderer.ts";
import { Type } from "@sinclair/typebox";

const payload = {
	content: "TASK-0011 completion facts",
	origin: { kind: "crew" as const, name: "Dave", role: "dev" },
};

test("formatQueueDelay is deterministic at compact-unit boundaries and never negative", () => {
	assert.equal(formatQueueDelay(-5_000), "0s");
	assert.equal(formatQueueDelay(0), "0s");
	assert.equal(formatQueueDelay(999), "0s");
	assert.equal(formatQueueDelay(1_000), "1s");
	assert.equal(formatQueueDelay(59_999), "59s");
	assert.equal(formatQueueDelay(60_000), "1m");
	assert.equal(formatQueueDelay(14 * 60_000 + 18_000), "14m");
	assert.equal(formatQueueDelay(3_599_999), "59m");
	assert.equal(formatQueueDelay(3_600_000), "1h");
	assert.equal(formatQueueDelay(23 * 3_600_000 + 59_000), "23h");
	assert.equal(formatQueueDelay(86_400_000), "1d");
	assert.equal(formatQueueDelay(3 * 86_400_000), "3d");
});

test("registry records target acceptance with injected clock and claims handoff exactly once", () => {
	let now = 1_000;
	const registry = new QueuedFollowUpAcceptanceRegistry({ now: () => now });
	const acceptance = registry.record("delivery-1");
	assert.deepEqual(acceptance, { deliveryId: "delivery-1", acceptedAt: 1_000 });
	assert.equal(registry.pendingCount(), 1);

	now = 1_000 + 14 * 60_000;
	const provenance = registry.claimHandoff("delivery-1");
	assert.deepEqual(provenance, {
		deliveryId: "delivery-1",
		acceptedAt: 1_000,
		handoffAt: 1_000 + 14 * 60_000,
		queueDelay: "14m",
		disposition: "queued",
	});
	assert.equal(registry.pendingCount(), 0);
	assert.equal(registry.claimHandoff("delivery-1"), null, "handoff claim is exactly once");
	assert.equal(registry.claimHandoff("delivery-unknown"), null);
});

test("registry hands off two queued acceptances in FIFO record order", () => {
	let now = 5_000;
	const registry = new QueuedFollowUpAcceptanceRegistry({ now: () => now });
	registry.record("delivery-a");
	now = 9_000;
	registry.record("delivery-b");
	now = 70_000;
	assert.equal(registry.claimHandoff("delivery-a")?.queueDelay, "1m");
	assert.equal(registry.claimHandoff("delivery-b")?.queueDelay, "1m");
});

test("queued label is the compact one-line form shared by model content and TUI", () => {
	assert.equal(queuedFollowUpLabel("14m"), "[follow-up · queued 14m before delivery · uncorrelated]");
	assert.equal(queuedFollowUpLabel("0s"), "[follow-up · queued 0s before delivery · uncorrelated]");
});

test("queued model content carries the label, uncorrelated + may-predate guidance, and one canonical payload", () => {
	const content = renderQueuedFollowUpModelContent(payload, {
		deliveryId: "delivery-1",
		acceptedAt: 1_000,
		handoffAt: 1_000 + 14 * 60_000,
		queueDelay: "14m",
		disposition: "queued",
	});
	assert.ok(content.startsWith("[follow-up · queued 14m before delivery · uncorrelated]"));
	assert.match(content, /no correlated Response expected/);
	assert.match(content, /may predate newer coordination/);
	assert.match(content, /never infer response causality from arrival order/);
	assert.match(content, /send_member_request/);
	// Exactly one canonical payload; it round-trips through the strict parser.
	const canonicalStart = content.indexOf("{");
	const canonicalEnd = content.lastIndexOf("}");
	assert.notEqual(canonicalStart, -1);
	const parsed = parseRenderedMessagePayload(content.slice(canonicalStart, canonicalEnd + 1));
	assert.equal(parsed.content, payload.content);
	// Guidance never implies reply, completion, current state, or task ownership
	// (checked on the guidance header, not sender-authored payload content).
	const guidance = content.slice(0, canonicalStart);
	assert.doesNotMatch(guidance, /response to|completion|currently|owns|owner/i);
});

test("queued model content never leaks raw session IDs, aliases, sockets, or queue internals", () => {
	const content = renderQueuedFollowUpModelContent(payload, {
		deliveryId: "delivery-1",
		acceptedAt: 1_000,
		handoffAt: 2_000,
		queueDelay: "1s",
		disposition: "queued",
	});
	assert.ok(!content.includes("delivery-1"), "deliveryId stays structured-only");
	assert.ok(!/\d{13}|\d{1,2}:\d{2}/.test(content), "no raw epoch or clock timestamps in model content");
});

test("queued model content preserves bounded Unicode payload content verbatim", () => {
	const unicodePayload = {
		content: "完成 🎉 — café naïve “quoted” \u2028line-sep 日報",
		origin: { kind: "crew" as const, name: "Dave", role: "dev" },
	};
	const content = renderQueuedFollowUpModelContent(unicodePayload, {
		deliveryId: "d",
		acceptedAt: 1,
		handoffAt: 2,
		queueDelay: "1s",
		disposition: "queued",
	});
	const parsed = parseRenderedMessagePayload(content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1));
	assert.equal(parsed.content, unicodePayload.content);
	assert.equal(content.split("\n").length, 2, "label+guidance stays one line; payload stays one canonical line");
});

test("isDeliveryProvenance enforces the closed schema: no extra fields, delay grammar+bound, finite timestamps", () => {
	const valid = {
		deliveryId: "delivery-1",
		acceptedAt: 1_000,
		handoffAt: 2_000,
		queueDelay: "14m",
		disposition: "queued",
	};
	assert.ok(isDeliveryProvenance(valid));
	// Valid compact grammar across units and bounds.
	for (const delay of ["0s", "59s", "1m", "14m", "23h", "3d", "9999d"]) {
		assert.ok(isDeliveryProvenance({ ...valid, queueDelay: delay }), delay);
	}
	// Extra fields are rejected despite additionalProperties:false declaration.
	assert.equal(
		isDeliveryProvenance({ ...valid, queueDelay: "socket=/tmp/leak", extra: "not-allowed" }),
		false,
		"Kelly probe: arbitrary delay text plus extra field must fail",
	);
	assert.equal(isDeliveryProvenance({ ...valid, extra: 1 }), false);
	// Delay must be the exact compact formatter grammar, bounded, ASCII, control-free.
	const malformed = [
		"socket=/tmp/leak",
		"14m extra",
		"-5m",
		"0.5s",
		"",
		"14M",
		"１４m",
		"99999d",
		"14m\n",
		"14m\u0000",
	];
	for (const delay of malformed) {
		assert.equal(isDeliveryProvenance({ ...valid, queueDelay: delay }), false, JSON.stringify(delay));
	}
	// Timestamps must be finite epoch milliseconds (never NaN/±Infinity, never negative).
	for (const patch of [
		{ acceptedAt: Number.NaN },
		{ handoffAt: Number.POSITIVE_INFINITY },
		{ acceptedAt: Number.NEGATIVE_INFINITY },
		{ acceptedAt: -1 },
		{ handoffAt: -1 },
	]) {
		assert.equal(isDeliveryProvenance({ ...valid, ...patch }), false, JSON.stringify(patch));
	}
});

test("delivery provenance schema is strict TypeBox with frozen semantics", () => {
	assert.equal(
		JSON.stringify(DeliveryProvenanceSchema.properties ? Object.keys(DeliveryProvenanceSchema.properties) : []),
		JSON.stringify(["deliveryId", "acceptedAt", "handoffAt", "queueDelay", "disposition"]),
	);
	assert.equal(DeliveryProvenanceSchema.additionalProperties, false);
	assert.ok(
		isDeliveryProvenance({
			deliveryId: "d",
			acceptedAt: 1,
			handoffAt: 2,
			queueDelay: "1s",
			disposition: "queued",
		}),
	);
	assert.equal(isDeliveryProvenance({ deliveryId: "d", acceptedAt: 1, handoffAt: 2, queueDelay: "1s" }), false);
	assert.equal(Type.Kind === undefined, true, "typebox import stays available");
});
