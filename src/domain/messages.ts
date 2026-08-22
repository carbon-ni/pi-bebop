import { Type, type Static } from "@sinclair/typebox";

export const SESSION_MESSAGE_TYPE = "bebop-session-message";

export const ExtractedMessageSchema = Type.Object({
	role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
	content: Type.String(),
	timestamp: Type.Number(),
}, { additionalProperties: false });
export type ExtractedMessage = Static<typeof ExtractedMessageSchema>;
