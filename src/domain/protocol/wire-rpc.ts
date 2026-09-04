import { Type } from "@sinclair/typebox";
import { ExtractedMessageSchema } from "../messages.ts";
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
	MemberStatusTargetSchema,
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
	MemberUpdateIdleSchema,
	RequestOutcomeRequestIdSchema,
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
	MemberIdleWaitTimeoutSchema,
} from "./wire-guests.ts";
import { MemberIdleWaitResultSchema } from "../member-idle-wait.ts";
import { MAX_MESSAGE_CONTENT_BYTES, MAX_MESSAGE_INSTRUCTIONS } from "../message-payload.ts";

export const MemberIdleWaitParamsSchema = Type.Object(
	{
		member: MemberStatusTargetSchema,
		timeoutSeconds: Type.Optional(MemberIdleWaitTimeoutSchema),
	},
	{ additionalProperties: false },
);
/** Terminal outcome is the closed Member Idle Wait contract (TASK-0050); no message-content data. */
export const MemberIdleWaitSubscribeResultSchema = Type.Object(
	{ subscriptionId: Type.String({ minLength: 1 }), event: Type.Literal("member_idle") },
	{ additionalProperties: false },
);
export const MemberIdleWaitRequestSchema = Type.Object(
	{
		jsonrpc: Type.Literal(JSON_RPC_VERSION),
		id: RpcIdSchema,
		method: Type.Literal("member.idle_wait"),
		params: MemberIdleWaitParamsSchema,
	},
	{ additionalProperties: false },
);
export const MemberIdleWaitCommandSchema = Type.Object(
	{
		type: Type.Literal("member_idle_wait"),
		member: MemberStatusTargetSchema,
		timeoutSeconds: Type.Optional(MemberIdleWaitTimeoutSchema),
		id: Type.Optional(RpcIdSchema),
	},
	{ additionalProperties: false },
);
/** Server -> client one-shot terminal event for a member idle wait subscription. */
export const MemberIdleWaitNotificationSchema = Type.Object(
	{
		jsonrpc: Type.Literal(JSON_RPC_VERSION),
		method: Type.Literal("member.idle_wait"),
		params: Type.Object(
			{ subscriptionId: Type.String({ minLength: 1 }), result: MemberIdleWaitResultSchema },
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);
export const KnownRequestSchema = Type.Union([
	MessageSendRequestSchema,
	InterruptRequestSchema,
	SubscribeRequestSchema,
	StatusRequestSchema,
	GetMessageRequestSchema,
	ClearRequestSchema,
	AbortRequestSchema,
	PresenceHintRequestSchema,
	MemberStatusRequestSchema,
	MemberStatusTargetRequestSchema,
	MemberRequestRequestSchema,
	MemberResponseRequestSchema,
	MemberFollowUpRequestSchema,
	MemberRedirectRequestSchema,
	MemberInterruptRequestSchema,
	MemberInboxSendRequestSchema,
	CrewBroadcastRequestSchema,
	GuestJoinRpcRequestSchema,
	GuestLeaveRequestSchema,
	MemberIdleWaitRequestSchema,
]);
export const GenericRequestSchema = Type.Object(
	{
		jsonrpc: Type.Literal(JSON_RPC_VERSION),
		id: RpcIdSchema,
		method: Type.String({ minLength: 1 }),
		params: Type.Optional(UnknownMethodParamsSchema),
	},
	{ additionalProperties: false },
);
export const RpcRequestSchema = Type.Union([KnownRequestSchema, GenericRequestSchema]);

export const RpcErrorSchema = Type.Object(
	{
		code: Type.Integer(),
		message: Type.String(),
		data: Type.Optional(Type.Object({ code: Type.Optional(Type.String()) }, { additionalProperties: false })),
	},
	{ additionalProperties: false },
);
export const ResponseIdSchema = Type.Union([RpcIdSchema, Type.Null()]);
export const StatusResultSchema = Type.Object(
	{ status: Type.Union([Type.Literal("stopped"), Type.Literal("online"), Type.Literal("joined")]) },
	{ additionalProperties: false },
);
export const SendResultSchema = Type.Object(
	{
		deliveryId: Type.String({ minLength: 1 }),
		disposition: Type.Union([Type.Literal("direct"), Type.Literal("queued"), Type.Literal("steered")]),
	},
	{ additionalProperties: false },
);
export const GetMessageResultSchema = Type.Object(
	{ message: Type.Union([ExtractedMessageSchema, Type.Null()]) },
	{ additionalProperties: false },
);
export const ClearResultSchema = Type.Object(
	{
		cleared: Type.Literal(true),
		alreadyAtRoot: Type.Optional(Type.Boolean()),
		targetId: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);
export const SubscribeResultSchema = Type.Object(
	{ subscriptionId: Type.String({ minLength: 1 }), event: Type.Literal("turn_end") },
	{ additionalProperties: false },
);
export const EmptyResultSchema = Type.Object({}, { additionalProperties: false });
const MemberRequestListItemSchema = Type.Object(
	{
		direction: Type.Union([Type.Literal("inbound"), Type.Literal("outbound")]),
		requestId: RequestOutcomeRequestIdSchema,
		member: Type.Object(
			{ name: Type.String({ minLength: 1 }), role: Type.String({ minLength: 1 }) },
			{ additionalProperties: false },
		),
		state: Type.Union([Type.Literal("accepted"), Type.Literal("idle")]),
		deadlineAt: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
	},
	{ additionalProperties: false },
);
export const MemberRequestListResultSchema = Type.Object(
	{
		requests: Type.Array(MemberRequestListItemSchema, { maxItems: 16 }),
		omitted: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);
const MemberRequestWaitMemberSchema = Type.Object(
	{ name: Type.String({ minLength: 1 }), role: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);
const MemberRequestWaitResultResponseSchema = Type.Object(
	{
		kind: Type.Literal("response"),
		requestId: RequestOutcomeRequestIdSchema,
		requestAgeMs: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
		member: MemberRequestWaitMemberSchema,
		message: Type.String({ minLength: 1, maxLength: MAX_MESSAGE_CONTENT_BYTES }),
		instructions: Type.Array(Type.String({ minLength: 1 }), { maxItems: MAX_MESSAGE_INSTRUCTIONS }),
	},
	{ additionalProperties: false },
);
const MemberRequestWaitResultOfflineSchema = Type.Object(
	{
		kind: Type.Literal("offline"),
		requestId: RequestOutcomeRequestIdSchema,
		member: MemberRequestWaitMemberSchema,
	},
	{ additionalProperties: false },
);
const MemberRequestWaitResultTimeoutSchema = Type.Object(
	{
		kind: Type.Literal("timeout"),
		requestId: RequestOutcomeRequestIdSchema,
		member: MemberRequestWaitMemberSchema,
		reason: Type.Union([Type.Literal("max-wait"), Type.Literal("response-after-idle")]),
	},
	{ additionalProperties: false },
);
export const MemberRequestWaitResultSchema = Type.Union([
	MemberRequestWaitResultResponseSchema,
	MemberRequestWaitResultOfflineSchema,
	MemberRequestWaitResultTimeoutSchema,
]);
export const RpcMethodResultSchema = Type.Union([
	StatusResultSchema,
	SendResultSchema,
	InterruptResultSchema,
	GetMessageResultSchema,
	ClearResultSchema,
	SubscribeResultSchema,
	PresenceHintResultSchema,
	MemberStatusResultSchema,
	MemberRequestResultSchema,
	MemberRequestListResultSchema,
	MemberRequestWaitResultSchema,
	MemberUpdateResultSchema,
	MemberMessageResultSchema,
	MemberInterruptResultSchema,
	MemberInboxSendResultSchema,
	CrewBroadcastResultSchema,
	GuestJoinResultSchema,
	GuestSendResultSchema,
	MemberIdleWaitSubscribeResultSchema,
	EmptyResultSchema,
]);
export const RpcResponseSchema = Type.Union([
	Type.Object(
		{ jsonrpc: Type.Literal(JSON_RPC_VERSION), id: ResponseIdSchema, result: RpcMethodResultSchema },
		{ additionalProperties: false },
	),
	Type.Object(
		{ jsonrpc: Type.Literal(JSON_RPC_VERSION), id: ResponseIdSchema, error: RpcErrorSchema },
		{ additionalProperties: false },
	),
]);
export const TurnEndNotificationSchema = Type.Object(
	{
		jsonrpc: Type.Literal(JSON_RPC_VERSION),
		method: Type.Literal("session.turn_end"),
		params: Type.Object(
			{
				subscriptionId: Type.String({ minLength: 1 }),
				message: Type.Optional(Type.Union([ExtractedMessageSchema, Type.Null()])),
				turnIndex: Type.Optional(Type.Integer()),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);
