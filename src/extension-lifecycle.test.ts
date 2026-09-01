import test from "node:test";
import assert from "node:assert/strict";
import { createInboxTerminalOfferCallbacks, registerInboxTerminalOfferHandlers } from "./pi/inbox-terminal-handlers.ts";

test("Inbox terminal handlers dispatch settled and both compaction outcomes", async () => {
	const handlers = new Map<string, (...args: any[]) => void>();
	const pi = { on: (name: string, handler: (...args: any[]) => void) => handlers.set(name, handler) } as any;
	const calls: string[] = [];
	let offers = 0;
	const callbacks = createInboxTerminalOfferCallbacks({
		emitSettled: () => calls.push("settled"),
		offer: () => {
			offers += 1;
		},
		markSettled: () => calls.push("marked"),
		onCompaction: () => calls.push("compaction-event"),
	});
	registerInboxTerminalOfferHandlers(pi, callbacks);
	// Callbacks are produced by the same factory used by extension.ts.
	handlers.get("agent_settled")?.({}, {});
	handlers.get("session_compact")?.({}, {});
	handlers.get("session_compact_failed")?.({}, {});
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(calls, ["settled", "marked", "compaction-event", "compaction-event"]);
	assert.equal(offers, 3);
});
