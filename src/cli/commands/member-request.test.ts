import test from "node:test";
import assert from "node:assert/strict";
import {
	parseMemberRequestSendCommand,
	parseMemberRequestListCommand,
	parseMemberRequestWaitCommand,
	parseMemberRequestRespondCommand,
	runMemberRequestCommand,
} from "./member-request.ts";

const sendArgs = [
	"Dev",
	"--message",
	"status?",
	"--response-grace",
	"30s",
	"--max-wait",
	"5m",
	"--instruction",
	"ordered",
];

test("Member Request CLI parses exact lifecycle surfaces and bounded durations", () => {
	assert.deepEqual(parseMemberRequestSendCommand(sendArgs), {
		command: "member-request-send",
		member: "Dev",
		message: "status?",
		stdin: false,
		instructions: ["ordered"],
		responseGraceSeconds: 30,
		maxWaitSeconds: 300,
		direction: "all",
		format: "toon",
	});
	assert.equal(parseMemberRequestListCommand(["--direction", "inbound"]).direction, "inbound");
	assert.equal(parseMemberRequestWaitCommand(["opaque-id"]).requestId, "opaque-id");
	assert.equal(parseMemberRequestRespondCommand(["opaque-id", "--message", "answer"]).requestId, "opaque-id");
});

test("Member Request CLI rejects max-wait not strictly greater than grace and duplicate values", () => {
	assert.throws(
		() => parseMemberRequestSendCommand(["Dev", "--message", "x", "--response-grace", "5m", "--max-wait", "5m"]),
		/strictly greater/,
	);
	assert.throws(() => parseMemberRequestListCommand(["--direction", "bad"]), /Invalid --direction/);
	assert.throws(() => parseMemberRequestWaitCommand(["id", "--session", "a", "--session", "b"]), /Duplicate flag/);
});

test("Member Request CLI sends through the selected source and preserves opaque IDs", async () => {
	const calls: any[] = [];
	const outcome = await runMemberRequestCommand(
		parseMemberRequestSendCommand(["Dev", "--message", "status?"]),
		{ cwd: "/tmp", input: process.stdin, signal: new AbortController().signal },
		{
			resolveSource: () => ({ ok: true, kind: "id", idSocketPath: "/id.sock", aliasSocketPath: "/alias.sock" }),
			send: async (_source, command) => {
				calls.push(command);
				return {
					response: {
						success: true,
						data: { accepted: true, requestId: "opaque-1", member: { name: "Dev", role: "developer" } },
					} as any,
				};
			},
			readStdin: async () => "",
			environmentSession: () => undefined,
		},
	);
	assert.equal(outcome.kind, "result");
	assert.equal((outcome as any).result.data.requestId, "opaque-1");
	assert.equal(calls[0].type, "member_request_start");
	assert.equal("origin" in calls[0], false);
});
