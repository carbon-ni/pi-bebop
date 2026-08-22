import test from "node:test";
import assert from "node:assert/strict";

import extension from "../extension.ts";

test("defers active-tool configuration until the extension runtime is initialized", async () => {
	let loading = true;
	let activeTools = ["read", "send_to_session", "list_sessions", "send_to_member", "other_extension"];
	const handlers = new Map<string, (...args: any[]) => unknown>();
	let activeToolReads = 0;

	const pi = {
		registerFlag() {},
		registerMessageRenderer() {},
		registerTool() {},
		registerCommand() {},
		on(event: string, handler: (...args: any[]) => unknown) {
			handlers.set(event, handler);
		},
		getFlag() { return undefined; },
		getActiveTools() {
			activeToolReads += 1;
			if (loading) throw new Error("Extension runtime not initialized");
			return activeTools;
		},
		setActiveTools(tools: string[]) {
			if (loading) throw new Error("Extension runtime not initialized");
			activeTools = tools;
		},
		sendMessage() {},
	} as never;

	assert.doesNotThrow(() => extension(pi));
	assert.equal(activeToolReads, 0);

	loading = false;
	await handlers.get("session_start")?.({}, {
		hasUI: false,
		sessionManager: {
			getSessionId: () => "session",
			getSessionName: () => undefined,
		},
	});

	assert.equal(activeToolReads, 1);
	assert.equal(activeTools.includes("send_to_member"), false);
	assert.equal(activeTools.includes("other_extension"), true);
	await handlers.get("session_shutdown")?.();
});
