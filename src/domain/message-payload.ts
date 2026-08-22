import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** Transport limits are measured in UTF-8 bytes, not JavaScript code units. */
export const MAX_MESSAGE_CONTENT_BYTES = 1_000_000;
export const MAX_MESSAGE_INSTRUCTIONS = 32;
export const MAX_MESSAGE_INSTRUCTION_BYTES = 100_000;
export const MAX_MESSAGE_PAYLOAD_BYTES = 1_000_000;
export const MAX_MESSAGE_ORIGIN_FIELD_BYTES = 256;

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
export const MessagePayloadSchema = Type.Object(
	{
		content: Type.String({ minLength: 1, maxLength: MAX_MESSAGE_CONTENT_BYTES }),
		instructions: Type.Optional(Type.Array(NonEmptyText, { minItems: 1, maxItems: MAX_MESSAGE_INSTRUCTIONS })),
		origin: Type.Optional(MessageOriginSchema),
	},
	{ additionalProperties: false },
);

export type CrewOrigin = Static<typeof CrewOriginSchema>;
export type ExternalOrigin = Static<typeof ExternalOriginSchema>;
export type MessageOrigin = Static<typeof MessageOriginSchema>;
export type MessagePayload = Static<typeof MessagePayloadSchema>;

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");
const hasNul = (value: string): boolean => value.includes("\0");

export function isMessagePayload(value: unknown): value is MessagePayload {
	if (!Value.Check(MessagePayloadSchema, value) || typeof value !== "object" || value === null) return false;
	const payload = value as MessagePayload;
	if (hasNul(payload.content) || utf8Bytes(payload.content) > MAX_MESSAGE_CONTENT_BYTES) return false;
	const instructions = payload.instructions ?? [];
	if (
		instructions.some(
			(instruction) => hasNul(instruction) || utf8Bytes(instruction) > MAX_MESSAGE_INSTRUCTION_BYTES,
		)
	)
		return false;
	if (payload.origin) {
		const fields =
			payload.origin.kind === "crew" ? [payload.origin.name, payload.origin.role] : [payload.origin.label];
		if (fields.some((field) => hasNul(field) || utf8Bytes(field) > MAX_MESSAGE_ORIGIN_FIELD_BYTES)) return false;
	}
	const aggregate =
		utf8Bytes(payload.content) + instructions.reduce((total, instruction) => total + utf8Bytes(instruction), 0);
	return aggregate <= MAX_MESSAGE_PAYLOAD_BYTES;
}
