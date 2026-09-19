import assert from "node:assert/strict";
import test from "node:test";
import { buildMemberIdleWaitCommand, memberIdleWaitHelp, readMemberIdleWaitCommand } from "./member-idle-wait.ts";
import { buildMemberStatusCommand, memberStatusHelp, readMemberStatusCommand } from "./member-status.ts";
import { buildDurableMessageCommand, readDurableMessageCommand } from "./durable-message.ts";
import { buildMemberInterruptCommand, readMemberInterruptCommand } from "./member-interrupt.ts";
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
