import assert from "node:assert/strict";
import test from "node:test";
import { buildMemberIdleWaitCommand, readMemberIdleWaitCommand } from "./member-idle-wait.ts";
import { buildMemberStatusCommand, readMemberStatusCommand } from "./member-status.ts";
import { buildMemberMessageCommand, readMemberMessageCommand } from "./member-message.ts";
import {
	buildMemberRequestListCommand,
	buildMemberRequestRespondCommand,
	buildMemberRequestSendCommand,
	buildMemberRequestWaitCommand,
	readMemberRequestListCommand,
	readMemberRequestRespondCommand,
	readMemberRequestSendCommand,
	readMemberRequestWaitCommand,
} from "./member-request.ts";

function parse(command: { parse: (args: string[], options: { from: "user" }) => unknown }, args: string[]) {
	command.parse(args, { from: "user" });
}

test("migrated member Commander readers preserve optional values and defaults", () => {
	const status = buildMemberStatusCommand();
	parse(status, ["Alice", "--session", "source"]);
	assert.deepEqual(readMemberStatusCommand(status), {
		command: "member-status",
		member: "Alice",
		session: "source",
		format: "toon",
	});

	const idle = buildMemberIdleWaitCommand();
	parse(idle, ["developer", "--timeout", "1s", "--format", "json"]);
	assert.deepEqual(readMemberIdleWaitCommand(idle), {
		command: "member-idle-wait",
		member: "developer",
		timeoutSeconds: 1,
		format: "json",
	});

	const followUp = buildMemberMessageCommand("follow_up");
	parse(followUp, ["Alice", "--message", "hello", "--instruction", "first", "--format", "text"]);
	assert.deepEqual(readMemberMessageCommand(followUp, "follow_up"), {
		command: "member-follow-up",
		intent: "follow_up",
		member: "Alice",
		message: "hello",
		instructions: ["first"],
		stdin: false,
		format: "text",
	});
});

test("member request readers preserve each command vocabulary and source", () => {
	const send = buildMemberRequestSendCommand();
	parse(send, ["Alice", "--message", "hello", "--response-grace", "60s", "--max-wait", "120s"]);
	assert.equal(readMemberRequestSendCommand(send).command, "member-request-send");

	const list = buildMemberRequestListCommand();
	parse(list, ["--direction", "inbound", "--format", "json"]);
	assert.deepEqual(readMemberRequestListCommand(list), {
		command: "member-request-list",
		stdin: false,
		instructions: [],
		responseGraceSeconds: 120,
		maxWaitSeconds: 1800,
		direction: "inbound",
		format: "json",
	});

	const wait = buildMemberRequestWaitCommand();
	parse(wait, ["request-1"]);
	assert.equal(readMemberRequestWaitCommand(wait).command, "member-request-wait");

	const respond = buildMemberRequestRespondCommand();
	parse(respond, ["request-1", "--message", "answer"]);
	assert.equal(readMemberRequestRespondCommand(respond).command, "member-request-respond");
});
