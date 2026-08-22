import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** Transport limits are deterministic UTF-8 byte limits. Aggregate size is UTF-8 bytes of compact JSON payload (framing excluded). */
export const MAX_MESSAGE_CONTENT_BYTES = 1_000_000;
export const MAX_MESSAGE_INSTRUCTIONS = 32;
export const MAX_MESSAGE_INSTRUCTION_BYTES = 100_000;
export const MAX_MESSAGE_PAYLOAD_BYTES = 1_000_000;
export const MAX_MESSAGE_ORIGIN_FIELD_BYTES = 256;
export const MAX_MESSAGE_REPLY_FIELD_BYTES = 256;

const NonEmptyText = Type.String({ minLength: 1 });
export const CrewOriginSchema = Type.Object(
	{ kind: Type.Literal("crew"), name: NonEmptyText, role: NonEmptyText },
	{ additionalProperties: false },
);
export const ExternalOriginSchema = Type.Object(
	{ kind: Type.Literal("external"), label: NonEmptyText },
	{ additionalProperties: false },
);
export const MessageOriginSchema = Type.Union([CrewOriginSchema, ExternalOriginSchema]);
export const MessageInstructionsSchema = Type.Optional(
	Type.Array(NonEmptyText, { minItems: 1, maxItems: MAX_MESSAGE_INSTRUCTIONS }),
);
export const ReplyToSchema = Type.Object(
	{ sessionId: NonEmptyText, sessionName: Type.Optional(NonEmptyText) },
	{ additionalProperties: false },
);
export const MessagePayloadSchema = Type.Object(
	{
		content: Type.String({ minLength: 1, maxLength: MAX_MESSAGE_CONTENT_BYTES }),
		instructions: MessageInstructionsSchema,
		origin: Type.Optional(MessageOriginSchema),
		replyTo: Type.Optional(ReplyToSchema),
	},
	{ additionalProperties: false },
);

export type CrewOrigin = Static<typeof CrewOriginSchema>;
export type ExternalOrigin = Static<typeof ExternalOriginSchema>;
export type MessageOrigin = Static<typeof MessageOriginSchema>;
export type ReplyTo = Static<typeof ReplyToSchema>;
export type MessagePayload = Static<typeof MessagePayloadSchema>;

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");
export const messagePayloadUtf8Bytes = (payload: MessagePayload): number => utf8Bytes(JSON.stringify(payload));
const invalidContent = (value: string): boolean =>
	value.trim().length === 0 || value.includes("\0") || utf8Bytes(value) > MAX_MESSAGE_CONTENT_BYTES;
const invalidInstruction = (value: string): boolean =>
	value.trim().length === 0 || value.includes("\0") || utf8Bytes(value) > MAX_MESSAGE_INSTRUCTION_BYTES;
const invalidIdentity = (value: string, limit: number): boolean =>
	value.trim().length === 0 || value !== value.trim() || value.includes("\0") || utf8Bytes(value) > limit;

export function isMessagePayload(value: unknown): value is MessagePayload {
	if (!Value.Check(MessagePayloadSchema, value) || typeof value !== "object" || value === null) return false;
	const payload = value as MessagePayload;
	if (invalidContent(payload.content)) return false;
	const instructions = payload.instructions ?? [];
	if (instructions.some(invalidInstruction)) return false;
	if (payload.origin) {
		const fields =
			payload.origin.kind === "crew" ? [payload.origin.name, payload.origin.role] : [payload.origin.label];
		if (fields.some((field) => invalidIdentity(field, MAX_MESSAGE_ORIGIN_FIELD_BYTES))) return false;
	}
	if (payload.replyTo) {
		const fields = [payload.replyTo.sessionId, payload.replyTo.sessionName].filter(
			(field): field is string => field !== undefined,
		);
		if (fields.some((field) => invalidIdentity(field, MAX_MESSAGE_REPLY_FIELD_BYTES))) return false;
	}
	return messagePayloadUtf8Bytes(payload) <= MAX_MESSAGE_PAYLOAD_BYTES;
}
