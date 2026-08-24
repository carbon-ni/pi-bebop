import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { registerBroadcastToCrewTool } from "../tools/broadcast-to-crew.ts";
import { registerGetMemberStatusTool } from "../tools/get-member-status.ts";
import { registerInterruptMemberTool } from "../tools/interrupt-member.ts";
import { registerMemberIntentTool } from "../tools/member-tool-adapter.ts";
import { registerSendToInboxTool } from "../tools/send-to-inbox.ts";
import { registerUpdateMemberFocusTool } from "../tools/update-member-focus.ts";
import { registerWaitForMemberIdleTool } from "../tools/wait-for-member-idle.ts";

interface ToolContract {
	tool: string;
	commands: string[];
	inputs: string[];
	defaults: Record<string, unknown>;
	result: Record<string, unknown>;
	errors: string[];
	delivery: string;
	cancellation: string;
	inputContract?: Record<string, unknown>;
}

interface MembershipParityContract {
	schemaVersion: number;
	scope: { tools: string[]; excluded: string[] };
	formats: { default: string; alternatives: string[]; exitCodes: Record<string, number> };
	errorPolicy: { inherited: string; actionSpecific: string; usage: string };
	sourceSelection: {
		flag: string;
		placement: string;
		environmentFallback: string;
		precedence: string;
		environmentRule: string;
		maxUtf8Bytes: number;
		errors: string[];
		recoveryHint: string;
	};
	sessionList: {
		command: string;
		requiresSourceSession: boolean;
		mutates: boolean;
		fields: string[];
		forbiddenFields: string[];
		membershipValues: string[];
		bounds: Record<string, number>;
		empty: Record<string, unknown>;
	};
	sharedInputs: Record<string, unknown>;
	tools: ToolContract[];
}

const contractPath = new URL("../../docs/cli-membership-parity.json", import.meta.url);
const contract = JSON.parse(readFileSync(contractPath, "utf8")) as MembershipParityContract;
const byTool = new Map(contract.tools.map((entry) => [entry.tool, entry]));
const expectedTools = [
	"send_follow_up",
	"redirect_member",
	"send_to_inbox",
	"broadcast_to_crew",
	"interrupt_member",
	"get_member_status",
	"update_member_focus",
	"wait_for_member_idle",
];

function entry(tool: string): ToolContract {
	const value = byTool.get(tool);
	assert.ok(value, `missing ${tool}`);
	return value;
}

test("membership CLI decision covers exactly eight registered tools with complete matrix dimensions", () => {
	assert.equal(contract.schemaVersion, 1);
	assert.deepEqual(contract.scope.tools, expectedTools);
	assert.deepEqual(
		contract.tools.map((item) => item.tool),
		expectedTools,
	);
	assert.equal(new Set(contract.tools.map((item) => item.tool)).size, expectedTools.length);

	for (const item of contract.tools) {
		assert.ok(item.commands.length > 0, `${item.tool}: commands`);
		assert.ok(item.inputs.length > 0, `${item.tool}: inputs`);
		assert.equal(typeof item.defaults, "object", `${item.tool}: defaults`);
		assert.equal(typeof item.result, "object", `${item.tool}: result`);
		assert.ok(Array.isArray(item.errors), `${item.tool}: errors`);
		assert.equal(new Set(item.errors).size, item.errors.length, `${item.tool}: duplicate error`);
		assert.ok(item.delivery.length > 20, `${item.tool}: delivery`);
		assert.ok(item.cancellation.length > 20, `${item.tool}: cancellation`);
	}
});

test("matrix input decisions stay aligned with the eight current tool schemas", () => {
	const registered: Array<{ name: string; parameters: { properties?: Record<string, unknown> } }> = [];
	const pi = {
		registerTool: (tool: { name: string; parameters: { properties?: Record<string, unknown> } }) =>
			registered.push(tool),
	};
	const state = {};
	registerMemberIntentTool(pi as never, state as never, "follow_up", {} as never);
	registerMemberIntentTool(pi as never, state as never, "immediate", {} as never);
	registerSendToInboxTool(pi as never, state as never, { hintTransport: null });
	registerBroadcastToCrewTool(pi as never, state as never, { isProjectTrusted: () => true });
	registerInterruptMemberTool(pi as never, state as never);
	registerGetMemberStatusTool(pi as never, state as never, {} as never);
	registerUpdateMemberFocusTool(pi as never, state as never);
	registerWaitForMemberIdleTool(pi as never, state as never, {} as never);

	assert.deepEqual(
		registered.map((tool) => tool.name),
		expectedTools,
	);
	const parameters = Object.fromEntries(
		registered.map((tool) => [tool.name, Object.keys(tool.parameters.properties ?? {}).sort()]),
	);
	assert.deepEqual(parameters, {
		send_follow_up: ["instructions", "member", "message", "wait_for"],
		redirect_member: ["instructions", "member", "message", "wait_for"],
		send_to_inbox: ["instructions", "member", "message"],
		broadcast_to_crew: ["instructions", "message"],
		interrupt_member: ["instructions", "member", "message"],
		get_member_status: ["member"],
		update_member_focus: ["action", "focus"],
		wait_for_member_idle: ["member", "timeout_seconds"],
	});
	assert.deepEqual(Object.fromEntries(contract.tools.map((item) => [item.tool, item.inputs])), {
		send_follow_up: ["memberTarget", "message", "instructions", "sourceSelection", "format"],
		redirect_member: ["memberTarget", "message", "instructions", "sourceSelection", "format"],
		send_to_inbox: ["memberTarget", "message", "instructions", "sourceSelection", "format"],
		broadcast_to_crew: ["message", "instructions", "sourceSelection", "format"],
		interrupt_member: ["memberTarget", "message", "instructions", "sourceSelection", "format"],
		get_member_status: ["memberTarget", "sourceSelection", "format"],
		update_member_focus: ["sourceSelection", "format", "focusAction", "focusText"],
		wait_for_member_idle: ["memberTarget", "sourceSelection", "format", "timeout"],
	});
	assert.match(String(entry("send_follow_up").defaults.waitFor), /accepted-only/);
	assert.match(String(entry("redirect_member").defaults.waitFor), /accepted-only/);
});

test("source selection is leaf-local, explicit-first, bounded, discoverable, and privacy-safe", () => {
	assert.equal(contract.sourceSelection.flag, "--session <id|alias>");
	assert.match(contract.sourceSelection.placement, /leaf-command-local/);
	assert.match(contract.sourceSelection.placement, /before any -- terminator/);
	assert.match(contract.sourceSelection.precedence, /explicit flag wins/);
	assert.match(contract.sourceSelection.environmentRule, /exact session id only, never an alias/);
	assert.equal(contract.sourceSelection.environmentFallback, "PI_SESSION_ID");
	assert.equal(contract.sourceSelection.maxUtf8Bytes, 256);
	assert.equal(contract.sourceSelection.recoveryHint, "pi-bebop session list");
	assert.deepEqual(contract.sourceSelection.errors, [
		"session-required",
		"invalid-session",
		"unknown-session",
		"offline-session",
		"not-joined",
		"untrusted",
		"malformed-response",
		"timeout",
		"aborted",
		"transport-error",
	]);

	assert.equal(contract.sessionList.command, "pi-bebop session list [--format toon|json|text]");
	assert.equal(contract.sessionList.requiresSourceSession, false);
	assert.equal(contract.sessionList.mutates, false);
	assert.deepEqual(contract.sessionList.fields, ["sessionId", "aliases", "membership"]);
	assert.deepEqual(contract.sessionList.membershipValues, ["joined", "unjoined", "unknown"]);
	for (const privateField of [
		"socketPath",
		"manifestPath",
		"messages",
		"prompts",
		"model",
		"instructions",
		"tools",
		"focus",
	]) {
		assert.ok(contract.sessionList.forbiddenFields.includes(privateField), privateField);
	}
	assert.deepEqual(contract.sessionList.bounds, {
		maxFilesystemEntries: 256,
		maxOutputSessions: 100,
		maxAliasesPerSession: 8,
		probeTimeoutMs: 500,
	});
	assert.deepEqual(contract.sessionList.empty.sessions, []);
	assert.equal(contract.sessionList.empty.total, 0);
});

test("command names preserve product delivery distinctions and future Inbox namespace", () => {
	assert.match(entry("send_follow_up").commands[0]!, /member follow-up/);
	assert.match(entry("redirect_member").commands[0]!, /member redirect/);
	assert.match(entry("send_to_inbox").commands[0]!, /member inbox send/);
	assert.match(entry("broadcast_to_crew").commands[0]!, /crew broadcast/);
	assert.match(entry("interrupt_member").commands[0]!, /member interrupt/);
	assert.match(entry("get_member_status").commands[0]!, /member status/);
	assert.match(entry("update_member_focus").commands[0]!, /member focus set/);
	assert.match(entry("wait_for_member_idle").commands[0]!, /member wait-idle/);

	for (const tool of ["send_follow_up", "redirect_member"]) {
		assert.match(String(entry(tool).defaults.waitFor), /accepted-only/);
		assert.ok(!entry(tool).commands[0]!.includes("wait_for"));
		assert.match(entry(tool).delivery, /never means reply|No reply/i);
	}
});

test("reviewed status, broadcast, Focus, and idle edge contracts remain explicit", () => {
	const status = entry("get_member_status");
	assert.match(status.delivery, /successful offline\/unavailable/i);
	assert.deepEqual((status.result.offline as Record<string, unknown>).focus, "unavailable");

	const broadcast = entry("broadcast_to_crew");
	assert.match(broadcast.cancellation, /completed writes remain/i);
	assert.match(broadcast.cancellation, /identical retry reuses ids/i);
	assert.ok(broadcast.errors.includes("outcome-unknown"));

	const focus = entry("update_member_focus");
	assert.match(focus.commands[0]!, /\[--\] <text>/);
	assert.match(String(focus.inputContract?.dashLeading), /preserved verbatim/);
	assert.match(String(focus.result.rules), /clear while unspecified is unchanged/i);

	const idle = entry("wait_for_member_idle");
	assert.match(String(idle.inputContract?.timeout), /exact whole 1–600 seconds/);
	assert.equal(idle.defaults.timeout, "5m");
	assert.equal(idle.defaults.setupDeadline, "5s");
	assert.equal(idle.defaults.responseGrace, "5s");
	assert.match(idle.cancellation, /semantic timeout wins/i);
});

test("formats and exits retain frozen Commander-era AXI boundary", () => {
	assert.equal(contract.formats.default, "toon");
	assert.deepEqual(contract.formats.alternatives, ["json", "text"]);
	assert.deepEqual(contract.formats.exitCodes, { successOrExpectedOutcome: 0, operational: 1, usage: 2 });
	assert.match(contract.errorPolicy.inherited, /sourceSelection\.errors/);
	assert.match(contract.errorPolicy.actionSpecific, /current tool\/application stable code/);
	assert.match(contract.errorPolicy.usage, /exit 2 before source IO/);
	assert.deepEqual(contract.scope.excluded, ["read", "bash", "edit", "write", "external-crew-intake"]);

	for (const item of contract.tools) {
		for (const command of item.commands) {
			assert.match(command, /^pi-bebop (member|crew) /);
			assert.ok(!command.startsWith("pi-bebop --session"), `${item.tool}: root-global session`);
		}
	}
});
