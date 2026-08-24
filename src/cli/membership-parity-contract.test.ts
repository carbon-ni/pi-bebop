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
import type { MemberMessageErrorCode } from "../application/member-message.ts";
import type { MemberInboxMessageErrorCode } from "../application/member-inbox-message.ts";
import type { BroadcastToCrewErrorCode } from "../application/crew-broadcast.ts";
import type { CrewBroadcastErrorCode } from "../domain/crew-broadcast.ts";
import type { MemberInterruptErrorCode } from "../domain/member-interrupt.ts";
import type { InterruptFlowErrorCode } from "../application/interrupt-flow.ts";
import type { MemberStatusFlowErrorCode } from "../application/member-status-flow.ts";
import type { MemberIdleWaitFlowErrorCode } from "../application/member-idle-wait-flow.ts";

/**
 * TASK-0060 (strengthened): the deterministic completeness/current-tool-schema
 * guard. Two layers:
 *
 * 1. Strict artifact schema: every object asserts its exact key set, so an
 *    unapproved field can never silently drift into the normative JSON.
 * 2. Stable error-code membership: every per-tool error code must belong to
 *    the owning application/domain module's typed code union (the literal
 *    arrays below are compile-time checked against those unions, so a code
 *    removed from the application breaks this test).
 *
 * Closed per-command error vocabulary = sourceSelection.errors (inherited,
 * shared) union tools[].errors (additional, disjoint).
 */

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
	idempotency?: Record<string, unknown>;
}

interface MembershipParityContract {
	schemaVersion: number;
	scope: { tools: string[]; excluded: string[] };
	formats: { default: string; alternatives: string[]; exitCodes: Record<string, number> };
	errorPolicy: {
		inherited: string;
		actionSpecific: string;
		usage: string;
		cliLayerCodes: string[];
		codeDisjointness: string;
	};
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
		membershipValues: string[];
		forbiddenFields: string[];
		bounds: Record<string, number>;
		truncation: { omittedField: string; meaning: string; omittedZero: string; topLevelOutput: string[] };
		aliasPrivacy: { included: string; excluded: string; classified: string };
		empty: Record<string, unknown>;
	};
	sharedInputs: {
		memberTarget: { type: string; maxUtf8Bytes: number; resolution: string };
		message: {
			sources: string[];
			rule: string;
			validationOrder: string[];
			maxUtf8Bytes: number;
			aggregateMaxUtf8Bytes: number;
			nul: string;
			trim: string;
			empty: string;
		};
		instructions: {
			flag: string;
			ordered: boolean;
			maximumItems: number;
			maxUtf8BytesEach: number;
			nul: string;
			trim: string;
			optional: boolean;
		};
	};
	pendingDecisions: Array<{ id: string; status: string; scope: string }>;
	tools: ToolContract[];
}

const contractPath = new URL("../../docs/cli-membership-parity.json", import.meta.url);
const contract = JSON.parse(readFileSync(contractPath, "utf8")) as MembershipParityContract;
const markdownPath = new URL("../../docs/CLI-MEMBERSHIP-PARITY.md", import.meta.url);
const markdown = readFileSync(markdownPath, "utf8");
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

/** Exact-key schema guard: rejects any unapproved field in a section. */
function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], where: string): void {
	assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${where} key set`);
}

function assertArrayEqualSets(actual: readonly string[], expected: readonly string[], where: string): void {
	assert.deepEqual([...actual].sort(), [...expected].sort(), where);
}

// ============================================================================
// Strict artifact schema (schemaVersion 2)
// ============================================================================

test("contract artifact schema is closed to approved keys", () => {
	assert.equal(contract.schemaVersion, 2);
	assertExactKeys(
		contract,
		[
			"schemaVersion",
			"scope",
			"formats",
			"errorPolicy",
			"sourceSelection",
			"sessionList",
			"sharedInputs",
			"pendingDecisions",
			"tools",
		],
		"contract",
	);
	assertExactKeys(contract.scope, ["tools", "excluded"], "scope");
	assertExactKeys(contract.formats, ["default", "alternatives", "exitCodes"], "formats");
	assertExactKeys(
		contract.errorPolicy,
		["inherited", "actionSpecific", "usage", "cliLayerCodes", "codeDisjointness"],
		"errorPolicy",
	);
	assertExactKeys(
		contract.sourceSelection,
		[
			"flag",
			"placement",
			"environmentFallback",
			"precedence",
			"environmentRule",
			"maxUtf8Bytes",
			"resolution",
			"authority",
			"privacy",
			"errors",
			"recoveryHint",
		],
		"sourceSelection",
	);
	assertExactKeys(
		contract.sessionList,
		[
			"command",
			"requiresSourceSession",
			"mutates",
			"defaultFormat",
			"fields",
			"membershipValues",
			"forbiddenFields",
			"ordering",
			"bounds",
			"staleEntryBehavior",
			"truncation",
			"aliasPrivacy",
			"empty",
			"successStatus",
			"operationalErrors",
			"exit",
		],
		"sessionList",
	);
	assertExactKeys(
		contract.sessionList.bounds,
		["maxFilesystemEntries", "maxOutputSessions", "maxAliasesPerSession", "probeTimeoutMs"],
		"sessionList.bounds",
	);
	assertExactKeys(
		contract.sessionList.truncation,
		["omittedField", "meaning", "omittedZero", "topLevelOutput"],
		"sessionList.truncation",
	);
	assertExactKeys(
		contract.sessionList.aliasPrivacy,
		["included", "excluded", "classified"],
		"sessionList.aliasPrivacy",
	);
	assertExactKeys(
		contract.sessionList.empty,
		["status", "sessions", "total", "omitted", "next"],
		"sessionList.empty",
	);
	assertExactKeys(contract.sharedInputs, ["memberTarget", "message", "instructions", "format"], "sharedInputs");
	assertExactKeys(
		contract.sharedInputs.memberTarget,
		["type", "maxUtf8Bytes", "resolution"],
		"sharedInputs.memberTarget",
	);
	assertExactKeys(
		contract.sharedInputs.message,
		["sources", "rule", "validationOrder", "maxUtf8Bytes", "aggregateMaxUtf8Bytes", "nul", "trim", "empty"],
		"sharedInputs.message",
	);
	assertExactKeys(
		contract.sharedInputs.instructions,
		["flag", "ordered", "maximumItems", "maxUtf8BytesEach", "nul", "trim", "optional"],
		"sharedInputs.instructions",
	);
	for (const item of contract.tools) {
		const allowed: string[] = [
			"tool",
			"commands",
			"inputs",
			"defaults",
			"result",
			"errors",
			"delivery",
			"cancellation",
		];
		if (item.tool === "update_member_focus" || item.tool === "wait_for_member_idle") allowed.push("inputContract");
		if (item.tool === "broadcast_to_crew") allowed.push("idempotency");
		assertExactKeys(item, allowed, `tools[${item.tool}]`);
	}
});

test("per-tool result shapes are closed (no unapproved fields)", () => {
	const allowedResultKeys: Record<string, string[]> = {
		send_follow_up: ["status", "fields", "disposition", "exit"],
		redirect_member: ["status", "fields", "disposition", "exit"],
		send_to_inbox: ["status", "fields", "hint", "exit"],
		broadcast_to_crew: ["status", "fields", "recipientFields", "recipientDisposition", "recipientPairing", "exit"],
		interrupt_member: ["status", "fields", "disposition", "exit"],
		get_member_status: ["status", "fields", "online", "offline", "exit"],
		update_member_focus: ["status", "fields", "rules", "exit"],
		wait_for_member_idle: ["status", "fields", "outcome", "idleDisposition", "exit"],
	};
	for (const item of contract.tools) {
		assertExactKeys(item.result, allowedResultKeys[item.tool]!, `tools[${item.tool}].result`);
	}
});

// ============================================================================
// Stable application error-code membership (compile-time checked literals)
// ============================================================================

const MEMBER_MESSAGE_CODES: readonly MemberMessageErrorCode[] = [
	"unknown-member",
	"ambiguous-member",
	"self-send",
	"not-joined",
	"response-correlation-unsupported",
	"invalid-payload",
	"remote-rejected",
	"invalid-ack",
	"outcome-unknown",
];
const INBOX_MESSAGE_CODES: readonly MemberInboxMessageErrorCode[] = [
	"unknown-member",
	"ambiguous-role",
	"self-send",
	"not-joined",
	"invalid-payload",
	"untrusted-project",
	"inbox-full",
	"inbox-untrusted-path",
	"storage-unavailable",
	"storage-failed",
];
const BROADCAST_FLOW_CODES: readonly (CrewBroadcastErrorCode | BroadcastToCrewErrorCode)[] = [
	"invalid-request",
	"unknown-sender",
	"no-recipients",
	"invalid-payload",
	"not-joined",
	"untrusted-project",
];
/** Per-recipient codes produced by the broadcast store-error mapping (application/crew-broadcast.ts). */
const BROADCAST_RECIPIENT_CODES: readonly string[] = [
	"inbox-full",
	"inbox-untrusted-path",
	"untrusted-project",
	"storage-unavailable",
	"storage-failed",
	"invalid-payload",
	"invalid-item-id",
	"aborted",
];
const INTERRUPT_RESOLUTION_CODES: readonly MemberInterruptErrorCode[] = [
	"invalid-request",
	"unknown-member",
	"ambiguous-member",
	"self-interrupt",
	"not-a-member",
	"invalid-payload",
];
const INTERRUPT_FLOW_CODES: readonly InterruptFlowErrorCode[] = [
	"invalid-payload",
	"already-pending",
	"abort-failed",
	"no-context",
	"handoff-failed",
];
const STATUS_FLOW_CODES: readonly MemberStatusFlowErrorCode[] = [
	"not-joined",
	"untrusted",
	"unknown-member",
	"ambiguous-member",
	"self-query",
	"invalid-action",
	"invalid-focus",
	"remote-rejected",
	"malformed-response",
	"timeout",
	"aborted",
	"transport-error",
];
const IDLE_FLOW_CODES: readonly MemberIdleWaitFlowErrorCode[] = [
	"not-joined",
	"untrusted",
	"unknown-member",
	"ambiguous-member",
	"self-wait",
	"not-a-member",
	"invalid-timeout",
	"timeout",
	"offline",
	"aborted",
	"malformed-response",
	"remote-rejected",
	"capacity-exceeded",
	"transport-error",
];
const CLI_LAYER_CODES = ["offline", "outcome-unknown"];

const allowedByTool: Record<string, readonly string[]> = {
	send_follow_up: [...MEMBER_MESSAGE_CODES, ...CLI_LAYER_CODES],
	redirect_member: [...MEMBER_MESSAGE_CODES, ...CLI_LAYER_CODES],
	send_to_inbox: [...INBOX_MESSAGE_CODES, ...CLI_LAYER_CODES],
	broadcast_to_crew: [...BROADCAST_FLOW_CODES, ...BROADCAST_RECIPIENT_CODES, ...CLI_LAYER_CODES],
	interrupt_member: [...INTERRUPT_RESOLUTION_CODES, ...INTERRUPT_FLOW_CODES, ...CLI_LAYER_CODES],
	get_member_status: [...STATUS_FLOW_CODES, ...CLI_LAYER_CODES],
	update_member_focus: [...STATUS_FLOW_CODES, ...CLI_LAYER_CODES],
	wait_for_member_idle: [...IDLE_FLOW_CODES],
};

test("every tool error code is a stable application/CLI-layer code and disjoint from inherited source codes", () => {
	const sourceCodes = new Set(contract.sourceSelection.errors);
	for (const item of contract.tools) {
		const allowed = new Set(allowedByTool[item.tool]!);
		for (const code of item.errors) {
			assert.ok(allowed.has(code), `${item.tool}: '${code}' is not a stable code for this command`);
			assert.ok(
				!sourceCodes.has(code),
				`${item.tool}: '${code}' is inherited via sourceSelection and must not repeat`,
			);
		}
	}
});

test("errorPolicy declares the closed-vocabulary rule and the CLI-layer codes", () => {
	assert.match(contract.errorPolicy.inherited, /sourceSelection\.errors/);
	assert.match(contract.errorPolicy.actionSpecific, /current tool\/application stable code/);
	assert.match(contract.errorPolicy.usage, /exit 2 before source IO/);
	assertArrayEqualSets(contract.errorPolicy.cliLayerCodes, CLI_LAYER_CODES, "errorPolicy.cliLayerCodes");
});

// ============================================================================
// Enums, defaults, and limits
// ============================================================================

test("frozen enums: formats, exits, membership, and result discriminators", () => {
	assert.equal(contract.formats.default, "toon");
	assertArrayEqualSets(contract.formats.alternatives, ["json", "text"], "formats.alternatives");
	assert.deepEqual(contract.formats.exitCodes, { successOrExpectedOutcome: 0, operational: 1, usage: 2 });
	assertArrayEqualSets(contract.sessionList.membershipValues, ["joined", "unjoined", "unknown"], "membershipValues");
	assert.equal(contract.sourceSelection.environmentFallback, "PI_SESSION_ID");
	assert.equal(contract.sourceSelection.maxUtf8Bytes, 256);

	const followUp = entry("send_follow_up");
	assertArrayEqualSets(followUp.result.disposition as string[], ["direct", "queued"], "follow-up disposition");
	assertArrayEqualSets(
		entry("redirect_member").result.disposition as string[],
		["direct", "steered"],
		"redirect disposition",
	);
	assertArrayEqualSets(
		entry("interrupt_member").result.disposition as string[],
		["direct", "interrupt-requested"],
		"interrupt disposition",
	);
	assertArrayEqualSets(entry("send_to_inbox").result.hint as string[], ["sent", "skipped"], "inbox hint");
	assertArrayEqualSets(
		entry("broadcast_to_crew").result.recipientDisposition as string[],
		["persisted", "already-persisted", "failed"],
		"broadcast recipient dispositions",
	);
	assertArrayEqualSets(
		entry("update_member_focus").result.status as string[],
		["updated", "cleared", "unchanged"],
		"focus status",
	);
	assertArrayEqualSets(
		entry("wait_for_member_idle").result.outcome as string[],
		["idle", "offline", "timeout"],
		"idle outcome",
	);
	assertArrayEqualSets(
		entry("wait_for_member_idle").result.idleDisposition as string[],
		["already-idle", "became-idle"],
		"idle disposition",
	);
	const statusResult = entry("get_member_status").result.online as { activity: string[]; focus: string[] };
	assertArrayEqualSets(statusResult.activity, ["idle", "busy", "compacting"], "status activity");
	assertArrayEqualSets(statusResult.focus, ["reported", "unspecified"], "status focus");
});

test("terminal result.status and ordered result.fields are exact for all eight tools", () => {
	const expected: Record<string, { status: unknown; fields: string[] }> = {
		send_follow_up: {
			status: "accepted",
			fields: ["member.name", "member.role", "deliveryId", "disposition"],
		},
		redirect_member: {
			status: "accepted",
			fields: ["member.name", "member.role", "deliveryId", "disposition"],
		},
		send_to_inbox: {
			status: "persisted",
			fields: ["member.name", "member.role", "itemId", "persisted", "hint"],
		},
		broadcast_to_crew: {
			status: ["persisted", "partial"],
			fields: ["broadcastId", "persisted", "alreadyPersisted", "failed", "total", "recipients"],
		},
		interrupt_member: {
			status: "accepted",
			fields: ["member.name", "member.role", "interruptId", "disposition"],
		},
		get_member_status: {
			status: "observed",
			fields: ["member.name", "member.role", "presence", "activity", "hasPendingMessages", "focus", "observedAt"],
		},
		update_member_focus: {
			status: ["updated", "cleared", "unchanged"],
			fields: ["focus.state", "focus.text", "focus.updatedAt"],
		},
		wait_for_member_idle: {
			status: "observed",
			fields: ["member.name", "member.role", "outcome", "disposition", "observedAt"],
		},
	};
	for (const item of contract.tools) {
		assert.deepEqual(item.result.status, expected[item.tool]!.status, `${item.tool} result.status`);
		assert.deepEqual(item.result.fields, expected[item.tool]!.fields, `${item.tool} result.fields (exact order)`);
	}
});

test("discriminated nested result shapes are exact for all eight tools", () => {
	const status = entry("get_member_status");
	assert.deepEqual(status.result.online, {
		activity: ["idle", "busy", "compacting"],
		hasPendingMessages: "boolean",
		focus: ["reported", "unspecified"],
	});
	assert.deepEqual(status.result.offline, {
		activity: "unavailable",
		hasPendingMessages: "unavailable",
		focus: "unavailable",
	});

	const focus = entry("update_member_focus");
	assert.deepEqual(focus.result.status, ["updated", "cleared", "unchanged"]);
	assert.deepEqual(focus.result.fields, ["focus.state", "focus.text", "focus.updatedAt"]);
	assert.match(String(focus.result.rules), /clear while unspecified is unchanged/i);

	const idle = entry("wait_for_member_idle");
	assert.deepEqual(idle.result.outcome, ["idle", "offline", "timeout"]);
	assert.deepEqual(idle.result.idleDisposition, ["already-idle", "became-idle"]);

	assert.deepEqual(entry("send_follow_up").result.disposition, ["direct", "queued"]);
	assert.deepEqual(entry("redirect_member").result.disposition, ["direct", "steered"]);
	assert.deepEqual(entry("interrupt_member").result.disposition, ["direct", "interrupt-requested"]);
	assert.deepEqual(entry("send_to_inbox").result.hint, ["sent", "skipped"]);
});

test("broadcast recipient fields, disposition, and code pairing are exact", () => {
	const broadcast = entry("broadcast_to_crew");
	assert.deepEqual(broadcast.result.recipientFields, ["member", "role", "itemId", "disposition", "code"]);
	assert.deepEqual(broadcast.result.recipientDisposition, ["persisted", "already-persisted", "failed"]);
	assert.deepEqual(broadcast.result.recipientPairing, {
		failed: "requires-stable-code",
		persisted: "no-code",
		"already-persisted": "no-code",
	});
	assert.match(broadcast.delivery, /one independent non-interrupting Inbox copy/);
});

test("per-tool exit shapes are closed: success 0, broadcast partial 1", () => {
	const exitByTool: Record<string, unknown> = {
		send_follow_up: 0,
		redirect_member: 0,
		send_to_inbox: 0,
		broadcast_to_crew: { allPersistedOrAlready: 0, partial: 1 },
		interrupt_member: 0,
		get_member_status: 0,
		update_member_focus: 0,
		wait_for_member_idle: 0,
	};
	for (const item of contract.tools) {
		assert.deepEqual(item.result.exit, exitByTool[item.tool], `${item.tool} result.exit`);
	}
});

test("session-list ordering and recovery next-step are explicit", () => {
	assert.match(contract.sessionList.ordering, /lexical/);
	assert.match(contract.sessionList.ordering, /session id/);
	assert.match(String(contract.sessionList.empty.next), /start and join/);
	assert.equal(contract.sourceSelection.recoveryHint, "pi-bebop session list");
});

test("limits and defaults match the Message Payload and session-list contracts", () => {
	assert.deepEqual(contract.sessionList.bounds, {
		maxFilesystemEntries: 256,
		maxOutputSessions: 100,
		maxAliasesPerSession: 8,
		probeTimeoutMs: 500,
	});
	assert.equal(contract.sharedInputs.memberTarget.maxUtf8Bytes, 256);
	assert.equal(contract.sharedInputs.message.maxUtf8Bytes, 1_000_000);
	assert.equal(contract.sharedInputs.message.aggregateMaxUtf8Bytes, 1_000_000);
	assert.equal(contract.sharedInputs.instructions.maximumItems, 32);
	assert.equal(contract.sharedInputs.instructions.maxUtf8BytesEach, 100_000);
	assert.equal(entry("update_member_focus").inputContract?.focusText ? 256 : 0, 256);

	const idle = entry("wait_for_member_idle");
	assert.equal(idle.defaults.timeout, "5m");
	assert.equal(idle.defaults.setupDeadline, "5s");
	assert.equal(idle.defaults.responseGrace, "5s");
	assert.match(String(idle.inputContract?.timeout), /exact whole 1–600 seconds/);

	for (const tool of ["send_follow_up", "redirect_member"]) {
		assert.match(String(entry(tool).defaults.waitFor), /accepted-only/);
		assert.ok(!entry(tool).commands[0]!.includes("wait_for"));
	}
	assert.equal(entry("send_follow_up").defaults.format, "toon");
	assert.equal(entry("get_member_status").defaults.format, "toon");
	assert.equal(entry("update_member_focus").defaults.format, "toon");
	assert.equal(entry("wait_for_member_idle").defaults.format, "toon");
});

test("validation ordering and payload hygiene are explicit", () => {
	const order = contract.sharedInputs.message.validationOrder;
	assert.ok(order.length >= 3, "validationOrder lists at least three phases");
	assert.match(order[0]!, /before any stdin read/);
	assert.match(order[1]!, /bounded/);
	assert.match(order[2]!, /before session or target IO/);
	assert.match(contract.sharedInputs.message.nul, /NUL-free/);
	assert.match(contract.sharedInputs.message.trim, /verbatim/);
	assert.match(contract.sharedInputs.instructions.nul, /NUL-free/);
	assert.match(contract.sharedInputs.instructions.trim, /trimmed/);
});

test("session-list truncation and classified alias privacy are explicit", () => {
	assert.equal(contract.sessionList.truncation.omittedField, "omitted");
	assertArrayEqualSets(
		contract.sessionList.truncation.topLevelOutput,
		["sessions", "total", "omitted"],
		"session list top-level output",
	);
	assert.match(contract.sessionList.truncation.omittedZero, /0/);
	assert.equal(contract.sessionList.empty.omitted, 0);
	assert.match(contract.sessionList.aliasPrivacy.classified, /safe slugs/);
	assert.match(contract.sessionList.aliasPrivacy.excluded, /private\/foreign/);
});

// ============================================================================
// Pending decisions: idempotency-conflict waits for product wording
// ============================================================================

test("broadcast idempotency-conflict remains pending product wording", () => {
	assert.equal(contract.pendingDecisions.length, 1);
	const decision = contract.pendingDecisions[0]!;
	assert.equal(decision.id, "broadcast-idempotency-conflict");
	assert.match(decision.status, /pending product wording/);
	for (const item of contract.tools) {
		assert.ok(
			!item.errors.includes("idempotency-conflict"),
			`${item.tool} must not assert an undecided idempotency-conflict code`,
		);
	}
	const broadcast = entry("broadcast_to_crew");
	assert.ok(broadcast.idempotency, "broadcast idempotency scope is documented");
	assert.match(String(broadcast.idempotency?.approved), /already-persisted/);
	assert.match(String(broadcast.idempotency?.conflictCode), /pending product wording/);
	assert.match(broadcast.cancellation, /identical retry reuses ids/);
});

// ============================================================================
// Markdown/JSON agreement (P0 reconciliation spot checks)
// ============================================================================

test("Markdown agrees with the JSON on the reconciled terminal shapes", () => {
	assert.match(markdown, /The JSON artifact is normative for full fields and error lists/);
	assert.match(markdown, /idempotency-conflict.*pending product wording/s);
	assert.match(markdown, /self-interrupt/);
	assert.match(markdown, /no-context/);
	assert.match(markdown, /already-persisted/);
	assert.match(markdown, /omitted/);
	assert.match(markdown, /[Vv]alidation order is fixed/);
	assert.match(markdown, /1–600 whole seconds/);
	assert.match(markdown, /500 ms per-session probe deadline/);
	assert.match(markdown, /8 safe aliases per session/);
	assert.match(markdown, /1,000,000 UTF-8 bytes/);
	assert.match(markdown, /outcome-unknown/);
});

// ============================================================================
// Original TASK-0060 decision-matrix completeness (unchanged)
// ============================================================================

test("membership CLI decision covers exactly eight registered tools with complete matrix dimensions", () => {
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
