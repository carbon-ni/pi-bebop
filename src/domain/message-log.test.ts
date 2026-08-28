import test from "node:test";
import assert from "node:assert/strict";
import { canonicalMessageLogBytes } from "./message-log.ts";

test("canonical message log bytes are deterministic and reject open fields", () => {
	const entry = {
		id: "entry-1",
		occurredAt: "2026-08-28T00:00:00.000Z",
		surface: "follow-up",
		content: "hello",
	} as const;
	assert.deepEqual(canonicalMessageLogBytes(entry), canonicalMessageLogBytes({ ...entry }));
	assert.throws(() => canonicalMessageLogBytes({ ...entry, secret: "raw" } as never), /invalid-message-log-entry/);
});
