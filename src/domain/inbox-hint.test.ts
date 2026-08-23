import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { INBOX_HINT_PREFIX, isInboxHint, type InboxHintPayload } from "./inbox-hint.ts";

describe("inbox hint detection", () => {
	test("recognizes the canonical best-effort hint payload", () => {
		const hint: InboxHintPayload = {
			content: `${INBOX_HINT_PREFIX} You have a new durable inbox item from Bob. Check your inbox when available.`,
			instructions: ["Check your crew inbox for pending items"],
			origin: { kind: "crew", name: "Bob", role: "dev" },
		};
		assert.equal(isInboxHint(hint), true);
	});

	test("does not match ordinary member messages even when they mention inbox", () => {
		const ordinary: InboxHintPayload = {
			content: "Please check your inbox tomorrow",
			origin: { kind: "crew", name: "Bob", role: "dev" },
		};
		assert.equal(isInboxHint(ordinary), false);
	});

	test("does not match content that merely starts with the prefix in another context", () => {
		assert.equal(isInboxHint({ content: "[inbox] is also a UI label we discuss in prose" }), false);
	});

	test("leading whitespace does not defeat detection", () => {
		assert.equal(isInboxHint({ content: `  ${INBOX_HINT_PREFIX} new durable inbox item waiting` }), true);
	});
});
