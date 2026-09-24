import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "@sinclair/typebox/value";
import {
	MemberLastMessageResultSchema,
	MemberLastMessageTargetCommandSchema,
	MemberLastMessageTargetRequestSchema,
	commandToRequest,
	requestToCommand,
} from "../index.ts";

test("member.last_message_target is strict and round-trips its closed result", () => {
	const request = {
		jsonrpc: "2.0" as const,
		id: "last-1",
		method: "member.last_message_target" as const,
		params: { target: "developer" },
	};
	assert.equal(Value.Check(MemberLastMessageTargetRequestSchema, request), true);
	assert.deepEqual(requestToCommand(request), {
		type: "member_last_message_target",
		target: "developer",
		id: "last-1",
	});
	assert.deepEqual(commandToRequest({ type: "member_last_message_target", target: "developer" }, "last-2"), {
		jsonrpc: "2.0",
		id: "last-2",
		method: "member.last_message_target",
		params: { target: "developer" },
	});
	assert.equal(
		Value.Check(MemberLastMessageTargetCommandSchema, {
			type: "member_last_message_target",
			target: "developer",
			extra: true,
		}),
		false,
	);
	assert.equal(
		Value.Check(MemberLastMessageResultSchema, {
			member: { name: "developer", role: "Developer" },
			message: { role: "assistant", content: "latest", timestamp: 1 },
		}),
		true,
	);
	assert.equal(
		Value.Check(MemberLastMessageResultSchema, {
			member: { name: "developer", role: "Developer" },
			message: { role: "user", content: "private", timestamp: 1 },
		}),
		false,
	);
});
