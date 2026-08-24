import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSocketState } from "../pi/control-runtime.ts";
import { CrewUpdateFlow } from "../application/crew-update-flow.ts";
import {
	registerRequestMemberTool,
	registerRespondToMemberRequestTool,
	registerWaitForCrewUpdateTool,
} from "./crew-update.ts";

type Tool = { name: string; description: string; execute: (...args: any[]) => Promise<any> };
function setup() {
	const tools = new Map<string, Tool>();
	const pi = {
		registerTool: (tool: unknown) => tools.set((tool as Tool).name, tool as Tool),
	} as unknown as ExtensionAPI;
	const state = createSocketState();
	state.crewUpdateFlow = new CrewUpdateFlow({
		resolveEndpoint: async (path) => path,
		createRequestId: () => "request-1",
		setTimeout: (() => undefined) as any,
		clearTimeout: (() => undefined) as any,
		transport: {
			open: async (_endpoint, _command, _options) => ({ close: () => undefined }),
			respond: async () => undefined,
		},
	});
	return { tools, state, pi };
}

test("coordination tools are distinct from accepted-only follow-up vocabulary", () => {
	const { tools, state, pi } = setup();
	registerRequestMemberTool(pi, state);
	registerRespondToMemberRequestTool(pi, state);
	registerWaitForCrewUpdateTool(pi, state);
	assert.deepEqual([...tools.keys()], ["request_member", "respond_to_member_request", "wait_for_crew_update"]);
	assert.match(tools.get("request_member")!.description, /response.*required/i);
	assert.match(tools.get("request_member")!.description, /send_follow_up/i);
	assert.match(tools.get("respond_to_member_request")!.description, /correlated/i);
	assert.match(tools.get("wait_for_crew_update")!.description, /does not poll/i);
});

test("wait cancellation releases only the waiter and preserves active request state", async () => {
	const { tools, state, pi } = setup();
	registerWaitForCrewUpdateTool(pi, state);
	state.crewUpdateFlow!.registry.registerOutbound({
		requestId: "active",
		member: { name: "qa", role: "reviewer" },
		now: 1_000,
	});
	const controller = new AbortController();
	const pending = tools.get("wait_for_crew_update")!.execute("id", {}, controller.signal);
	controller.abort();
	const result = await pending;
	assert.equal(result.details.error, "aborted");
	assert.equal(state.crewUpdateFlow!.registry.outboundCount(), 1);
});

test("empty wait fails immediately and never starts a polling loop", async () => {
	const { tools, state, pi } = setup();
	registerWaitForCrewUpdateTool(pi, state);
	const result = await tools.get("wait_for_crew_update")!.execute("id", {}, new AbortController().signal);
	assert.equal(result.isError, true);
	assert.equal(result.details.error, "no-pending-requests");
});
