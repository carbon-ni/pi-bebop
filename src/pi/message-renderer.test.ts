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

test("queued follow-up label and hint expose the compact immutable delay consistently", () => {
	const queued = {
		customType: "bebop-session-message",
		content: "[follow-up · queued 14m before delivery · uncorrelated] …",
		details: {
			messagePayload: { content: "Heads up", origin: { kind: "crew" as const, name: "Tony", role: "lead" } },
			deliveryProvenance: {
				deliveryId: "delivery-q1",
				acceptedAt: 1_000,
				handoffAt: 1_000 + 14 * 60_000,
				queueDelay: "14m",
				disposition: "queued",
			},
		},
	};
	assert.equal(sessionMessageKind(queued), "follow-up");
	assert.equal(sessionMessageLabel(queued), "[follow-up · queued 14m before delivery · uncorrelated]");
	assert.match(sessionMessageHint(queued) ?? "", /may predate newer coordination/);
	assert.match(sessionMessageHint(queued) ?? "", /never infer response causality from arrival order/);
	assert.match(sessionMessageHint(queued) ?? "", /send_member_request/);
	// Display never leaks the deliveryId or raw timestamps; collapsed/expanded parity.
	const collapsed = JSON.stringify(getMessageDisplayModel(queued, false));
	const expanded = JSON.stringify(getMessageDisplayModel(queued, true));
	assert.ok(!collapsed.includes("delivery-q1"));
	assert.ok(!expanded.includes("delivery-q1"));
	assert.ok(!expanded.includes("840000"));
	// Historical follow-ups without provenance stay byte-identical.
	const legacy = {
		customType: "bebop-session-message",
		content: "old",
		details: { messagePayload: { content: "old" } },
	};
	assert.equal(sessionMessageLabel(legacy), "[follow-up]");
	assert.equal(sessionMessageHint(legacy), null);
	// Malformed provenance fails safe to the plain follow-up label.
	const malformed = {
		customType: "bebop-session-message",
		content: "old",
		details: { messagePayload: { content: "old" }, deliveryProvenance: { queueDelay: 14 } },
	};
	assert.equal(sessionMessageLabel(malformed), "[follow-up]");
	assert.equal(sessionMessageHint(malformed), null);
	// Arbitrary delay text or extra fields never reach the TUI label (QA probe).
	const injected = {
		customType: "bebop-session-message",
		content: "old",
		details: {
			messagePayload: { content: "old" },
			deliveryProvenance: {
				deliveryId: "d",
				acceptedAt: 1,
				handoffAt: 2,
				queueDelay: "socket=/tmp/leak",
				disposition: "queued",
				extra: "not-allowed",
			},
		},
	};
	assert.equal(sessionMessageLabel(injected), "[follow-up]");
	assert.equal(sessionMessageHint(injected), null);
	// Non-finite timestamps fail safe too.
	const nanTimestamps = {
		customType: "bebop-session-message",
		content: "old",
		details: {
			messagePayload: { content: "old" },
			deliveryProvenance: {
				deliveryId: "d",
				acceptedAt: Number.NaN,
				handoffAt: 2,
				queueDelay: "1m",
				disposition: "queued",
			},
		},
	};
	assert.equal(sessionMessageLabel(nanTimestamps), "[follow-up]");
	assert.equal(sessionMessageHint(nanTimestamps), null);
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

	const resumeMessage = {
		customType: "crew-wait-resume",
		content: "[wait resume] member-idle Kelly became-idle",
		details: { wait: { kind: "member-idle", target: "Kelly", outcome: "became-idle", observedAt: 1_000 } },
	};
	assert.equal(sessionMessageKind(resumeMessage), "wait-resume");
	assert.equal(sessionMessageLabel(resumeMessage), "[wait resume]");
	assert.match(sessionMessageHint(resumeMessage) ?? "", /crew-wait-resume/);
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
	assert.equal(external.senderText, "from CI");
	assert.match(external.text, /Claimed origin: from CI/);
	assert.match(external.text, /body$/);
	const malformed = getMessageDisplayModel({ content: "legacy", details: { messagePayload: { content: 1 } } }, true);
	assert.equal(malformed.text, "legacy");
	assert.equal(malformed.senderText, null);
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

test("inbound crew correspondence renders the claimed return address visibly and never a callback route", () => {
	const message = {
		customType: "bebop-session-message",
		content: JSON.stringify({ type: "message-context", content: "Question for your crew" }),
		details: {
			messagePayload: {
				content: "Question for your crew",
				origin: { kind: "crew" as const, name: "Dave", role: "developer" },
				replyTo: { sessionId: "hidden-session", sessionName: "Hidden" },
				crewReturnAddress: {
					manifestPath: "/projects/alpha/.pi/bebop/crew.json",
					crewName: "Alpha Crew",
				},
			},
		},
	};
	const { text, senderText } = getMessageDisplayModel(message, true);
	assert.match(senderText ?? "", /from Dave \(developer\)/);
	assert.match(text, /Claimed crew return address: \/projects\/alpha\/\.pi\/bebop\/crew\.json \(Alpha Crew\)/);
	assert.match(text, /claimed attribution/);
	assert.equal(text.includes("hidden-session"), false);
	assert.equal(sessionMessageKind(message), "follow-up");
});

test("typed inbox details show the recipient-derived crew label and fail safe on malformed metadata", () => {
	const inboxMessage = {
		customType: "bebop-session-message",
		content: JSON.stringify({ type: "message-context", content: "Queued note" }),
		details: {
			messagePayload: {
				content: "Queued note",
				origin: { kind: "crew" as const, name: "Dave", role: "developer" },
			},
			inbox: { itemId: "inbox-0-abc", crewName: "Alpha Crew" },
		},
	};
	const { text, senderText } = getMessageDisplayModel(inboxMessage, true);
	assert.match(senderText ?? "", /from Dave \(developer\)/);
	assert.match(text, /Crew inbox: Alpha Crew/);

	for (const crewName of ["", " ", "x".repeat(257), "Alpha\nCrew", 5, null]) {
		const malformed = {
			...inboxMessage,
			details: { ...inboxMessage.details, inbox: { itemId: "inbox-0-abc", crewName } },
		};
		const model = getMessageDisplayModel(malformed, true);
		assert.doesNotMatch(model.text, /Crew inbox:/, `failed safe for ${JSON.stringify(crewName)}`);
	}

	const noInbox = {
		...inboxMessage,
		details: { messagePayload: inboxMessage.details.messagePayload },
	};
	assert.doesNotMatch(getMessageDisplayModel(noInbox, true).text, /Crew inbox:/);
	// UTF-8 bound, not UTF-16: 64 flags are exactly 256 UTF-8 bytes; 65 exceed it.
	const exactBound = {
		...inboxMessage,
		details: { ...inboxMessage.details, inbox: { itemId: "i", crewName: "🚩".repeat(64) } },
	};
	assert.equal((getMessageDisplayModel(exactBound, true).text.match(/🚩/gu) ?? []).length, 64);
	const overBound = {
		...inboxMessage,
		details: { ...inboxMessage.details, inbox: { itemId: "i", crewName: "🚩".repeat(65) } },
	};
	assert.doesNotMatch(getMessageDisplayModel(overBound, true).text, /Crew inbox:/);
});
