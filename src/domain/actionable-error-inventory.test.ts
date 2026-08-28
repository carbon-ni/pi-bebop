import test from "node:test";
import assert from "node:assert/strict";
import { createCliRegistry } from "../cli/registry.ts";
import { MEMBERSHIP_TOOLS } from "../pi/control-runtime.ts";
import { parseSessionControlAction } from "./cli.ts";
import { parseCrewBoardCommand } from "./crew-board-command.ts";
import {
	ACTIONABLE_ERROR_CREW_ACTIONS,
	ACTIONABLE_ERROR_CREW_SUBACTIONS,
	ACTIONABLE_ERROR_CLI_LEAVES,
	ACTIONABLE_ERROR_TOOLS,
} from "./actionable-error-inventory.ts";

/**
 * TASK-0088 frozen inventory: the registered public surfaces must match the
 * frozen v1 inventory exactly. Adding or renaming a CLI leaf, tool, or `/crew`
 * action without an inventory decision (docs/ACTIONABLE-ERRORS.md) fails here,
 * which makes the migration unit and the direct-render guard scope stay in
 * sync with the real registry.
 */

test("frozen inventory: CLI registry leaves match the frozen v1 list", () => {
	const registry = createCliRegistry();
	assert.deepEqual(registry.leaves.map((leaf) => leaf.id).sort(), [...ACTIONABLE_ERROR_CLI_LEAVES].sort());
});

test("frozen inventory: registered agent tools match the frozen v1 list", () => {
	assert.deepEqual([...MEMBERSHIP_TOOLS].sort(), [...ACTIONABLE_ERROR_TOOLS].sort());
});

test("frozen inventory: /crew parser accepts exactly the frozen top-level actions", () => {
	const validInvocation: Record<(typeof ACTIONABLE_ERROR_CREW_ACTIONS)[number], string> = {
		join: "join /tmp/member.sock",
		leave: "leave",
		members: "members",
		status: "status",
		stop: "stop",
		agreements: "agreements activate revision-1",
		inbox: "inbox status",
		board: "board",
		post: "post message",
	};
	for (const action of ACTIONABLE_ERROR_CREW_ACTIONS) {
		const parsed = parseSessionControlAction(validInvocation[action]);
		assert.equal(parsed.error, undefined, `frozen action must parse: ${action}`);
		assert.equal(parsed.action, action);
	}
	const unknown = parseSessionControlAction("frobnicate");
	assert.notEqual(unknown.error, undefined, "an unfrozen top-level action must be rejected");
});

test("frozen inventory: board and post subcommand vocabulary stays bounded", () => {
	const validInvocation = { board: "", post: "message" } as const;
	for (const action of ["board", "post"] as const) {
		const parsed = parseCrewBoardCommand(action, validInvocation[action]);
		assert.equal(parsed.error, undefined, `frozen subcommand must parse: ${action}`);
	}
	const bad = parseCrewBoardCommand("board", "--frobnicate");
	assert.notEqual(bad.error, undefined, "unknown board option must be rejected");
});

test("frozen inventory: inbox and agreements subaction vocabulary is recorded", () => {
	// Subactions are consumed by the /crew handlers; the inventory is the
	// frozen record that migration slices must cover.
	assert.deepEqual([...ACTIONABLE_ERROR_CREW_SUBACTIONS.agreements], ["activate"]);
	assert.deepEqual([...ACTIONABLE_ERROR_CREW_SUBACTIONS.inbox], ["status", "cancel", "pause", "resume"]);
	const inbox = parseSessionControlAction("inbox status");
	assert.equal(inbox.action, "inbox");
	assert.equal(inbox.target, "status");
	const agreements = parseSessionControlAction("agreements activate rev-1");
	assert.equal(agreements.action, "agreements");
	assert.equal(agreements.target, "activate rev-1");
});
