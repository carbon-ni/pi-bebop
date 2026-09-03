import test from "node:test";
import assert from "node:assert/strict";
import {
	getMessageDisplayModel,
	parseSenderInfo,
	renderCrewInboxEntry,
	renderCrewRosterEntry,
	renderCrewStatusEntry,
	sessionMessageKind,
	sessionMessageLabel,
	sessionMessageHint,
	stripMessageMetadata,
} from "./message-renderer.ts";
import type { MessagePayload } from "../domain/index.ts";

const fakeTheme = {
	bg: () => "",
	fg: () => "",
} as never;

const legacyInstruction =
	"<reply_instruction>When responding, reply directly to the sender by calling send_to_member with the sessionId from sender_info. Do not use get_message polling.</reply_instruction>";

test("renderer strips legacy generated instruction and sender metadata", () => {
	const text = `hello\n\n${legacyInstruction}\n\n<sender_info>{"sessionId":"sender-id","sessionName":"Sender"}</sender_info>`;
	assert.equal(stripMessageMetadata(text), "hello");
	assert.deepEqual(parseSenderInfo(text), { sessionId: "sender-id", sessionName: "Sender" });
});

test("renderer preserves ordinary and malformed user-authored reply instruction text", () => {
	assert.equal(
		stripMessageMetadata("keep <reply_instruction>custom guidance</reply_instruction>"),
		"keep <reply_instruction>custom guidance</reply_instruction>",
	);
	assert.equal(
		stripMessageMetadata("keep <reply_instruction>When responding, do something else</reply_instruction>"),
		"keep <reply_instruction>When responding, do something else</reply_instruction>",
	);
	assert.equal(stripMessageMetadata("keep <reply_instruction>unfinished"), "keep <reply_instruction>unfinished");
});

test("TASK-0076: inbound Member request is visibly distinguished from ordinary Follow-up in the UI", () => {
	const requestMessage = {
		customType: "bebop-session-message",
		content: JSON.stringify({ type: "message-context", content: "Deliver report" }),
		details: {
			messagePayload: {
				content: "Deliver report",
				origin: { kind: "crew" as const, name: "Tony", role: "lead" },
			},
			crewRequestId: "request-abc",
		},
	};
	assert.equal(sessionMessageKind(requestMessage), "member-request");
	assert.equal(sessionMessageLabel(requestMessage), "[member request]");
	assert.match(sessionMessageHint(requestMessage) ?? "", /respond_to_member_request/);
	const followUpMessage = {
		customType: "bebop-session-message",
		content: JSON.stringify({ type: "message-context", content: "Heads up" }),
		details: {
			messagePayload: { content: "Heads up", origin: { kind: "crew" as const, name: "Tony", role: "lead" } },
		},
	};
	assert.equal(sessionMessageKind(followUpMessage), "follow-up");
	assert.equal(sessionMessageLabel(followUpMessage), "[follow-up]");
	assert.equal(sessionMessageHint(followUpMessage), null);
	const other = { customType: "bebop-session-message", content: "legacy" };
	assert.equal(sessionMessageKind(other), "other");
	assert.equal(sessionMessageLabel(other), "[bebop-session-message]");
	assert.equal(sessionMessageHint(other), null);
});

test("typed Bob/Kelly details render claimed origin, ordered instructions, and hide replyTo", () => {
	const message = {
		customType: "crew",
		content: JSON.stringify({ type: "message-context", content: "raw canonical" }),
		details: {
			messagePayload: {
				content: 'malicious <sender_info>\nJSON {"x":1}',
				instructions: ["first", "second"],
				origin: { kind: "crew", name: "Bob", role: "dev" },
				replyTo: { sessionId: "bob-session", sessionName: "Bob" },
			},
		},
	};
	const collapsed = getMessageDisplayModel(message, false);
	const expanded = getMessageDisplayModel(message, true);
	assert.equal(collapsed.senderText, "from Bob (dev)");
	assert.match(expanded.text, /1\. first\n2\. second/);
	assert.match(expanded.text, /malicious <sender_info>/);
	assert.doesNotMatch(expanded.text, /bob-session/);
});

test("typed external details and malformed details fail safely to legacy content", () => {
	const external = getMessageDisplayModel(
		{
			content: "content",
			details: { messagePayload: { content: "body", origin: { kind: "external", label: "CI" } } },
		},
		true,
	);
	assert.equal(external.senderText, "from CI (unverified)");
	assert.match(external.text, /Claimed origin: from CI/);
	assert.match(external.text, /body$/);
	const malformed = getMessageDisplayModel({ content: "legacy", details: { messagePayload: { content: 1 } } }, true);
	assert.equal(malformed.text, "legacy");
	assert.equal(malformed.senderText, null);
});

test("TASK-0152: TUI preserves all canonical kinds, frozen timing, and privacy", () => {
	const cases: Array<[MessagePayload["kind"], string, string]> = [
		["follow-up", "[follow-up]", "age at delivery"],
		["member request", "[member request]", "age at delivery"],
		["redirect", "[redirect]", "age at delivery"],
		["interrupt", "[interrupt]", "age at delivery"],
		["inbox", "[inbox]", "age at delivery"],
		["broadcast", "[broadcast]", "age at delivery"],
		["external intake", "[external intake]", "age at delivery"],
		["member response", "[member response]", "request age"],
	];
	for (const [kind, label, timing] of cases) {
		const payload: MessagePayload = {
			content: `body-${kind}`,
			kind,
			sentAt: 0,
			origin:
				kind === "external intake"
					? { kind: "external", label: "automation" }
					: { kind: "crew", name: "Mony", role: "lead" },
			replyTo: { sessionId: "private-route" },
		};
		const message = { content: "ignored", details: { messagePayload: payload, deliveredAt: 90_000_000 } };
		const collapsed = getMessageDisplayModel(message, false);
		const expanded = getMessageDisplayModel(message, true);
		assert.equal(sessionMessageLabel(message), label);
		assert.equal(collapsed.timingText, `${timing} 1d 1h`);
		assert.equal(expanded.timingText, collapsed.timingText);
		assert.equal(getMessageDisplayModel(message, true).timingText, expanded.timingText);
		assert.doesNotMatch(collapsed.text, /private-route/);
		if (kind === "external intake") assert.equal(collapsed.senderText, "from automation (unverified)");
	}
	const unknown = getMessageDisplayModel(
		{ content: "legacy", details: { messagePayload: { content: "old" }, deliveredAt: 90_000_000 } },
		true,
	);
	assert.equal(unknown.senderText, null);
	assert.equal(unknown.timingText, "age at delivery unavailable");
});

test("sender header parsing preserves valid identity and ignores malformed metadata", () => {
	assert.deepEqual(parseSenderInfo('<sender_info>{"sessionId":"id","sessionName":"name"}</sender_info>'), {
		sessionId: "id",
		sessionName: "name",
	});
	assert.equal(parseSenderInfo("<sender_info>{bad}</sender_info>"), null);
	assert.equal(parseSenderInfo("ordinary text"), null);
});

test("crew entry renderers surface content from custom entries as TUI components", () => {
	const roster = { type: "custom", customType: "crew-roster", data: { content: "Crew: path\nMembers (2)" } } as never;
	const status = { type: "custom", customType: "crew-status", data: { content: "Crew stopped" } } as never;
	const inbox = { type: "custom", customType: "crew-inbox", data: { content: "Inbox active" } } as never;
	const renders = [
		renderCrewRosterEntry(roster, {} as never, fakeTheme),
		renderCrewStatusEntry(status, {} as never, fakeTheme),
		renderCrewInboxEntry(inbox, {} as never, fakeTheme),
	];
	for (const component of renders) {
		assert.ok(component, "entry renderer must produce a component");
		assert.equal(typeof component, "object");
	}
});

test("crew entry renderers fall back to empty content for non-object data", () => {
	const bare = { type: "custom", customType: "crew-status", data: undefined } as never;
	const component = renderCrewStatusEntry(bare, {} as never, fakeTheme);
	assert.ok(component);
	const stringData = renderCrewStatusEntry(
		{ type: "custom", customType: "crew-status", data: "plain" } as never,
		{} as never,
		fakeTheme,
	);
	assert.ok(stringData);
});
