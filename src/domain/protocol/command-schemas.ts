import { Type, type Static } from "@sinclair/typebox";
import { ExtractedMessageSchema } from "../messages.ts";
import { MessagePayloadSchema } from "../message-payload.ts";
import {
	JSON_RPC_VERSION,
	RpcIdSchema,
	UnknownMethodParamsSchema,
	MessageSendParamsSchema,
	SubscribeParamsSchema,
	EmptyParamsSchema,
	MAX_PRESENCE_HINT_FIELD_BYTES,
	PresenceHintParamsSchema,
	MessageSendRequestSchema,
	InterruptPayloadSchema,
	InterruptParamsSchema,
	InterruptResultSchema,
	InterruptRequestSchema,
	SubscribeRequestSchema,
	StatusRequestSchema,
	GetMessageRequestSchema,
	ClearRequestSchema,
	AbortRequestSchema,
	PresenceHintResultSchema,
	MAX_MEMBER_STATUS_TARGET_BYTES,
	MemberStatusParamsSchema,
	MemberStatusResultSchema,
	PresenceHintRequestSchema,
	MemberStatusRequestSchema,
	MemberStatusCommandSchema,
	MemberStatusTargetParamsSchema,
	MemberStatusTargetRequestSchema,
	MemberStatusTargetCommandSchema,
} from "./wire-base.ts";
import {
	MemberMessageParamsSchema,
	MemberFollowUpParamsSchema,
	MemberRedirectParamsSchema,
	MemberFollowUpRequestSchema,
	MemberRedirectRequestSchema,
	MemberFollowUpCommandSchema,
	MemberRedirectCommandSchema,
	MemberRequestParamsSchema,
	MemberRequestRequestSchema,
	MemberRequestCommandSchema,
	MemberRequestResultSchema,
	MemberRequestStartParamsSchema,
	MemberRequestStartRequestSchema,
	MemberRequestStartCommandSchema,
	MemberRequestListParamsSchema,
	MemberRequestListRequestSchema,
	MemberRequestListCommandSchema,
	MemberRequestWaitParamsSchema,
	MemberRequestWaitRequestSchema,
	MemberRequestWaitCommandSchema,
	MemberResponseParamsSchema,
	MemberResponseRequestSchema,
	MemberResponseCommandSchema,
	MemberUpdateNotificationSchema,
	MemberUpdateResultSchema,
	MemberUpdateIdleSchemaExport,
	MemberInterruptParamsSchema,
	MemberInterruptRequestSchema,
	MemberInterruptCommandSchema,
	MemberInterruptResultSchema,
} from "./wire-members.ts";
import {
	MemberInboxSendParamsSchema,
	CrewBroadcastParamsSchema,
	MemberInboxSendRequestSchema,
	CrewBroadcastRequestSchema,
	MemberInboxSendCommandSchema,
	CrewBroadcastCommandSchema,
	GuestJoinParamsSchema,
	GuestJoinRpcRequestSchema,
	GuestJoinCommandSchema,
	GuestJoinResultSchema,
	GuestLeaveParamsSchema,
	GuestSendParamsSchema,
	GuestSendResultSchema,
	GuestSendCommandSchema,
	GuestLeaveRequestSchema,
	GuestLeaveCommandSchema,
	MemberMessageResultSchema,
	MemberInboxSendResultSchema,
	CrewBroadcastResultSchema,
	MAX_MEMBER_IDLE_WAIT_TIMEOUT,
	MIN_MEMBER_IDLE_WAIT_TIMEOUT,
} from "./wire-guests.ts";
import {
	MemberIdleWaitParamsSchema,
	MemberIdleWaitSubscribeResultSchema,
	MemberIdleWaitRequestSchema,
	MemberIdleWaitCommandSchema,
	MemberIdleWaitNotificationSchema,
	KnownRequestSchema,
	GenericRequestSchema,
	RpcRequestSchema,
	RpcErrorSchema,
	ResponseIdSchema,
	StatusResultSchema,
	SendResultSchema,
	GetMessageResultSchema,
	ClearResultSchema,
	SubscribeResultSchema,
	EmptyResultSchema,
	MemberRequestListResultSchema,
	MemberRequestWaitResultSchema,
	RpcMethodResultSchema,
	RpcResponseSchema,
	TurnEndNotificationSchema,
} from "./wire-rpc.ts";

export const MessageSendCommandSchema = Type.Object(
	{
		type: Type.Literal("send"),
		payload: MessagePayloadSchema,
		delivery: Type.Optional(Type.Union([Type.Literal("follow_up"), Type.Literal("immediate")])),
		id: Type.Optional(RpcIdSchema),
	},
	{ additionalProperties: false },
);
export const InterruptCommandSchema = Type.Object(
	{
		type: Type.Literal("interrupt"),
		payload: InterruptPayloadSchema,
		id: Type.Optional(RpcIdSchema),
	},
	{ additionalProperties: false },
);
export const SubscribeCommandSchema = Type.Object(
	{
		type: Type.Literal("subscribe"),
		...SubscribeParamsSchema.properties,
		id: Type.Optional(RpcIdSchema),
	},
	{ additionalProperties: false },
);
export const StatusCommandSchema = Type.Object(
	{ type: Type.Literal("status"), id: Type.Optional(RpcIdSchema) },
	{ additionalProperties: false },
);
export const GetMessageCommandSchema = Type.Object(
	{ type: Type.Literal("get_message"), id: Type.Optional(RpcIdSchema) },
	{ additionalProperties: false },
);
export const ClearCommandSchema = Type.Object(
	{ type: Type.Literal("clear"), id: Type.Optional(RpcIdSchema) },
	{ additionalProperties: false },
);
export const AbortCommandSchema = Type.Object(
	{ type: Type.Literal("abort"), id: Type.Optional(RpcIdSchema) },
	{ additionalProperties: false },
);
export const PresenceHintCommandSchema = Type.Object(
	{ type: Type.Literal("presence_hint"), ...PresenceHintParamsSchema.properties, id: Type.Optional(RpcIdSchema) },
	{ additionalProperties: false },
);

export const RPC_ERROR = {
	parse: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	invalidParams: -32602,
	internal: -32603,
} as const;
export const RpcCommandResponseSchema = Type.Object(
	{
		type: Type.Literal("response"),
		command: Type.String({ minLength: 1 }),
		success: Type.Boolean(),
		error: Type.Optional(Type.String()),
		data: Type.Optional(RpcMethodResultSchema),
		id: RpcIdSchema,
	},
	{ additionalProperties: false },
);
export const RpcTurnEndNotificationSchema = Type.Object(
	{
		type: Type.Literal("event"),
		event: Type.Literal("turn_end"),
		data: Type.Optional(
			Type.Object(
				{
					message: Type.Optional(Type.Union([ExtractedMessageSchema, Type.Null()])),
					turnIndex: Type.Optional(Type.Integer()),
				},
				{ additionalProperties: false },
			),
		),
		subscriptionId: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);
export type RpcCommandResponse = Static<typeof RpcCommandResponseSchema>;
export type RpcTurnEndNotification = Static<typeof RpcTurnEndNotificationSchema>;
