import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { MAX_MESSAGE_CONTENT_BYTES } from "./message-payload.ts";

const MAX_MEMBER_LABEL_BYTES = 256;

const MemberLastMessageIdentitySchema = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: MAX_MEMBER_LABEL_BYTES }),
		role: Type.String({ minLength: 1, maxLength: MAX_MEMBER_LABEL_BYTES }),
	},
	{ additionalProperties: false },
);
const AssistantMessageSchema = Type.Object(
	{
		role: Type.Literal("assistant"),
		content: Type.String({ minLength: 1, maxLength: MAX_MESSAGE_CONTENT_BYTES }),
		timestamp: Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	},
	{ additionalProperties: false },
);

export const MemberLastMessageResultSchema = Type.Object(
	{
		member: MemberLastMessageIdentitySchema,
		message: Type.Union([AssistantMessageSchema, Type.Null()]),
	},
	{ additionalProperties: false },
);

export type MemberLastMessageIdentity = Static<typeof MemberLastMessageIdentitySchema>;
export type MemberLastMessage = Static<typeof AssistantMessageSchema>;
export type MemberLastMessageResult = Static<typeof MemberLastMessageResultSchema>;

function boundedLabel(value: string): boolean {
	return (
		value.trim() === value && !/[\0\r\n]/u.test(value) && Buffer.byteLength(value, "utf8") <= MAX_MEMBER_LABEL_BYTES
	);
}

function validMessage(message: MemberLastMessage): boolean {
	return (
		message.role === "assistant" &&
		message.content.length > 0 &&
		!message.content.includes("\0") &&
		Buffer.byteLength(message.content, "utf8") <= MAX_MESSAGE_CONTENT_BYTES &&
		Number.isSafeInteger(message.timestamp) &&
		message.timestamp >= 0
	);
}

export function isMemberLastMessage(value: unknown): value is MemberLastMessage {
	return Value.Check(AssistantMessageSchema, value) && validMessage(value as MemberLastMessage);
}

export function isMemberLastMessageResult(value: unknown): value is MemberLastMessageResult {
	if (!Value.Check(MemberLastMessageResultSchema, value)) return false;
	const result = value as MemberLastMessageResult;
	return (
		boundedLabel(result.member.name) &&
		boundedLabel(result.member.role) &&
		(result.message === null || isMemberLastMessage(result.message))
	);
}
