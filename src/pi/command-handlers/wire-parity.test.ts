import test from "node:test";
import assert from "node:assert/strict";
import { createSocketState, handleCommand } from "../control-runtime.ts";
import { wireParityFixtures } from "./wire-parity.fixture.ts";

test("RPC extraction preserves the characterized raw response line for every command type", async () => {
	const state = createSocketState();
	state.server = {} as never;
	state.context = {
		sessionManager: {
			getSessionId: () => "wire-session",
			getBranch: () => [],
			getEntries: () => [],
			getLeafId: () => "root",
		},
		isIdle: () => true,
		isCompacting: () => false,
		hasPendingMessages: () => false,
		isProjectTrusted: () => true,
		abort: () => undefined,
	} as never;
	const pi = { sendMessage: () => undefined, appendEntry: () => undefined } as never;

	for (const fixture of wireParityFixtures) {
		const writes: string[] = [];
		const socket = { write: (value: string) => writes.push(value), once: () => socket } as never;
		await handleCommand(pi, state, fixture.command as never, socket);
		assert.deepEqual(writes, [fixture.expected], fixture.type);
	}
});
