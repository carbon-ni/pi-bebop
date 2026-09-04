import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ExtractedMessageSchema, type ExtractedMessage } from "../messages.ts";
import {
	MessageOriginSchema,
	MessagePayloadSchema,
	isMessagePayload,
	type MessagePayload,
	MessageInstructionsSchema,
	MAX_MESSAGE_CONTENT_BYTES,
	MAX_MESSAGE_INSTRUCTIONS,
} from "../message-payload.ts";
import { MemberStatusSchema } from "../member-status.ts";
import { MemberIdleWaitResultSchema } from "../member-idle-wait.ts";

export const JSON_RPC_VERSION = "2.0" as const;
export const RpcIdSchema = Type.Union([Type.String({ minLength: 1 }), Type.Integer()]);
// Keep the transport schema compatible with the TypeBox API exposed by Pi's peer floor.
// Method-specific payloads are strict; unknown methods may carry only an object params bag.
export const UnknownMethodParamsSchema = Type.Union([Type.Null(), Type.Object({}, { additionalProperties: true })]);

export const MessageSendParamsSchema = Type.Object(
	{
		...MessagePayloadSchema.properties,
		delivery: Type.Optional(Type.Union([Type.Literal("follow_up"), Type.Literal("immediate")])),
	},
	{ additionalProperties: false },
);
export const SubscribeParamsSchema = Type.Object({ event: Type.Literal("turn_end") }, { additionalProperties: false });
export const EmptyParamsSchema = Type.Object({}, { additionalProperties: false });
export const MAX_PRESENCE_HINT_FIELD_BYTES = 256;
export const PresenceHintTextSchema = Type.String({
	minLength: 1,
	maxLength: MAX_PRESENCE_HINT_FIELD_BYTES,
	pattern: "^[^\\u0000]+$",
});
export const PresenceHintParamsSchema = Type.Object(
	{
		member: Type.Object(
			{ identity: PresenceHintTextSchema, name: PresenceHintTextSchema, role: PresenceHintTextSchema },
			{ additionalProperties: false },
		),
		state: Type.Union([Type.Literal("online"), Type.Literal("offline")]),
		instanceId: PresenceHintTextSchema,
	},
	{ additionalProperties: false },
);

export const MessageSendRequestSchema = Type.Object(
	{
		jsonrpc: Type.Literal(JSON_RPC_VERSION),
		id: RpcIdSchema,
		method: Type.Literal("message.send"),
		params: MessageSendParamsSchema,
	},
	{ additionalProperties: false },
);
const { replyTo: _replyTo, ...InterruptPayloadProperties } = MessagePayloadSchema.properties;
export const InterruptPayloadSchema = Type.Object(InterruptPayloadProperties, { additionalProperties: false });
export const InterruptParamsSchema = Type.Object({ payload: InterruptPayloadSchema }, { additionalProperties: false });
export const InterruptResultSchema = Type.Object(
	{
		interruptId: Type.String({ minLength: 1 }),
		disposition: Type.Union([Type.Literal("interrupt-requested"), Type.Literal("direct")]),
	},
	{ additionalProperties: false },
);
export const InterruptRequestSchema = Type.Object(
	{
		jsonrpc: Type.Literal(JSON_RPC_VERSION),
		id: RpcIdSchema,
		method: Type.Literal("message.interrupt"),
		params: InterruptParamsSchema,
	},
	{ additionalProperties: false },
);
export const SubscribeRequestSchema = Type.Object(
	{
		jsonrpc: Type.Literal(JSON_RPC_VERSION),
		id: RpcIdSchema,
		method: Type.Literal("event.subscribe"),
		params: SubscribeParamsSchema,
	},
	{ additionalProperties: false },
);
export const StatusRequestSchema = Type.Object(
	{ jsonrpc: Type.Literal(JSON_RPC_VERSION), id: RpcIdSchema, method: Type.Literal("session.status") },
	{ additionalProperties: false },
);
export const GetMessageRequestSchema = Type.Object(
	{ jsonrpc: Type.Literal(JSON_RPC_VERSION), id: RpcIdSchema, method: Type.Literal("session.get_message") },
	{ additionalProperties: false },
);
export const ClearRequestSchema = Type.Object(
	{ jsonrpc: Type.Literal(JSON_RPC_VERSION), id: RpcIdSchema, method: Type.Literal("session.clear") },
	{ additionalProperties: false },
);
export const AbortRequestSchema = Type.Object(
	{ jsonrpc: Type.Literal(JSON_RPC_VERSION), id: RpcIdSchema, method: Type.Literal("session.abort") },
	{ additionalProperties: false },
);
export const PresenceHintResultSchema = Type.Object({ accepted: Type.Boolean() }, { additionalProperties: false });
export const MAX_MEMBER_STATUS_TARGET_BYTES = 256;
export const MemberStatusTargetSchema = Type.String({ minLength: 1, maxLength: MAX_MEMBER_STATUS_TARGET_BYTES });
/** Read-only status query: exactly one bounded member label, no caller-selected fields. */
export const MemberStatusParamsSchema = Type.Object(
	{ member: MemberStatusTargetSchema },
	{ additionalProperties: false },
);
/** Result is the closed Member Status contract (TASK-0046); no message-content data. */
export const MemberStatusResultSchema = Type.Object({ status: MemberStatusSchema }, { additionalProperties: false });
export const PresenceHintRequestSchema = Type.Object(
	{
		jsonrpc: Type.Literal(JSON_RPC_VERSION),
		id: RpcIdSchema,
		method: Type.Literal("presence.hint"),
		params: PresenceHintParamsSchema,
	},
	{ additionalProperties: false },
);
export const MemberStatusRequestSchema = Type.Object(
	{
		jsonrpc: Type.Literal(JSON_RPC_VERSION),
		id: RpcIdSchema,
		method: Type.Literal("member.status"),
		params: MemberStatusParamsSchema,
	},
	{ additionalProperties: false },
);
export const MemberStatusCommandSchema = Type.Object(
	{
		type: Type.Literal("member_status"),
		member: MemberStatusTargetSchema,
		id: Type.Optional(RpcIdSchema),
	},
	{ additionalProperties: false },
);
/**
 * Delegated read-only status query (CLI -> source session, TASK-0061): one
 * bounded target label, no caller-selected fields. The source session runs
 * its own authoritative member-status flow; the CLI never supplies identity.
 */
export const MemberStatusTargetParamsSchema = Type.Object(
	{ target: MemberStatusTargetSchema },
	{ additionalProperties: false },
);
export const MemberStatusTargetRequestSchema = Type.Object(
	{
		jsonrpc: Type.Literal(JSON_RPC_VERSION),
		id: RpcIdSchema,
		method: Type.Literal("member.status_target"),
		params: MemberStatusTargetParamsSchema,
	},
	{ additionalProperties: false },
);
export const MemberStatusTargetCommandSchema = Type.Object(
	{
		type: Type.Literal("member_status_target"),
		target: MemberStatusTargetSchema,
		id: Type.Optional(RpcIdSchema),
	},
	{ additionalProperties: false },
);

/**
 * Delegated message delivery (CLI -> source session, TASK-0062): one bounded
 * target label, verbatim message content (bounded, non-blank), ordered
 * instructions within the Message Payload limits, and explicit delivery
 * intent via the command type (member_follow_up vs member_redirect). The CLI
 * never supplies source identity; the source session runs the shared
 * member-message application operation. Accepted-delivery only: the result
 * is the delivery acknowledgement (deliveryId + disposition), never a
 * response correlation.
 */
const MemberMessageContentSchema = Type.String({
	minLength: 1,
	maxLength: MAX_MESSAGE_CONTENT_BYTES,
});
