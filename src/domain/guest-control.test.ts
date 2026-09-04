import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseGuestControlAction } from "./guest-control.ts";

describe("Guest control parser", () => {
	test("parses join with one socket and explicit Guest name", () => {
		assert.deepEqual(parseGuestControlAction("join /tmp/member.sock --as Alex"), {
			action: "join",
			target: "/tmp/member.sock",
			guestName: "Alex",
		});
		assert.deepEqual(parseGuestControlAction('join "/tmp/member path.sock" --as "Alex Smith"'), {
			action: "join",
			target: "/tmp/member path.sock",
			guestName: "Alex Smith",
		});
		assert.deepEqual(parseGuestControlAction("crews"), { action: "crews" });
		assert.deepEqual(parseGuestControlAction("leave crew-alpha"), { action: "leave", target: "crew-alpha" });
	});

	test("rejects missing, duplicate, and conflicting Guest arguments", () => {
		for (const input of ["join", "join /tmp/member.sock", "join /tmp/member.sock --as"]) {
			assert.match(parseGuestControlAction(input).error ?? "", /Guest|target|--as/i, input);
		}
		assert.deepEqual(parseGuestControlAction("join --as Alex /tmp/member.sock"), {
			action: "join",
			target: "/tmp/member.sock",
			guestName: "Alex",
		});
		assert.match(
			parseGuestControlAction("join /tmp/member.sock --as Alex --as Bob").error ?? "",
			/exactly once|duplicate/i,
		);
		assert.match(parseGuestControlAction("crews extra").error ?? "", /exactly|arguments/i);
		assert.match(parseGuestControlAction("leave").error ?? "", /selector|target/i);
		assert.match(parseGuestControlAction("leave alpha beta").error ?? "", /exactly|arguments/i);
	});

	test("rejects unknown actions and empty values", () => {
		assert.match(parseGuestControlAction("unknown").error ?? "", /Unknown guest action/);
		assert.match(parseGuestControlAction("join '' --as Alex").error ?? "", /target/i);
		assert.match(parseGuestControlAction("join /tmp/member.sock --as ' '").error ?? "", /name/i);
		assert.match(parseGuestControlAction("leave ''").error ?? "", /selector/i);
		assert.match(parseGuestControlAction('join "/tmp/member.sock --as Alex').error ?? "", /quote/i);
	});
});
