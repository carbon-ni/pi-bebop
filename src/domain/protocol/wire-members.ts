import { Type } from "@sinclair/typebox";
import {
	JSON_RPC_VERSION,
	RpcIdSchema,
	MessageSendParamsSchema,
	SubscribeParamsSchema,
	EmptyParamsSchema,
	PresenceHintParamsSchema,
	PresenceHintResultSchema,
	PresenceHintRequestSchema,
	MemberStatusTargetSchema,
	MemberStatusParamsSchema,
	MemberStatusResultSchema,
	MemberStatusRequestSchema,
	MemberStatusCommandSchema,
	MemberStatusTargetParamsSchema,
} from "./wire-base.ts";
import {
	MessagePayloadSchema,
	MessageInstructionsSchema,
	MAX_MESSAGE_CONTENT_BYTES,
	MAX_MESSAGE_INSTRUCTIONS,
} from "../message-payload.ts";

export const MemberMessageContentSchema = Type.String({
	minLength: 1,
	maxLength: MAX_MESSAGE_CONTENT_BYTES,
});

export const MemberMessageParamsSchema = Type.Object(
	{
		target: MemberStatusTargetSchema,
		message: MemberMessageContentSchema,
		instructions: MessageInstructionsSchema,
	},
	{ additionalProperties: false },
);
export const MemberFollowUpParamsSchema = MemberMessageParamsSchema;
export const MemberRedirectParamsSchema = MemberMessageParamsSchema;
export const MemberFollowUpRequestSchema = Type.Object(
	{
		jsonrpc: Type.Literal(JSON_RPC_VERSION),
		id: RpcIdSchema,
		method: Type.Literal("member.follow_up"),
		params: MemberFollowUpParamsSchema,
	},
	{ additionalProperties: false },
);
export const MemberRedirectRequestSchema = Type.Object(
	{
		jsonrpc: Type.Literal(JSON_RPC_VERSION),
		id: RpcIdSchema,
		method: Type.Literal("member.redirect"),
		params: MemberRedirectParamsSchema,
	},
	{ additionalProperties: false },
);
export const MemberFollowUpCommandSchema = Type.Object(
	{
		type: Type.Literal("member_follow_up"),
		target: MemberStatusTargetSchema,
		message: MemberMessageContentSchema,
		instructions: MessageInstructionsSchema,
		id: Type.Optional(RpcIdSchema),
	},
	{ additionalProperties: false },
);
export const MemberRedirectCommandSchema = Type.Object(
	{
		type: Type.Literal("member_redirect"),
		target: MemberStatusTargetSchema,
		message: MemberMessageContentSchema,
		instructions: MessageInstructionsSchema,
		id: Type.Optional(RpcIdSchema),
	},
	{ additionalProperties: false },
);
export const RequestOutcomeRequestIdSchema = Type.String({ minLength: 1, maxLength: 128 });
export const RequestOutcomeTimeoutSchema = Type.Integer({ minimum: 1, maximum: 600 });
export const MemberRequestParamsSchema = Type.Object(
	{
		requestId: RequestOutcomeRequestIdSchema,
		payload: MessagePayloadSchema,
		timeoutSeconds: RequestOutcomeTimeoutSchema,
	},
	{ additionalProperties: false },
);
export const MemberRequestRequestSchema = Type.Object(
	{
		jsonrpc: Type.Literal(JSON_RPC_VERSION),
		id: RpcIdSchema,
		method: Type.Literal("member.request"),
		params: MemberRequestParamsSchema,
	},
	{ additionalProperties: false },
);
export const MemberRequestCommandSchema = Type.Object(
	{
		type: Type.Literal("member_request"),
		...MemberRequestParamsSchema.properties,
		id: Type.Optional(RpcIdSchema),
	},
	{ additionalProperties: false },
);
export const MemberRequestResultSchema = Type.Object(
	{
		accepted: Type.Literal(true),
		requestId: RequestOutcomeRequestIdSchema,
		member: Type.Object(
			{ name: Type.String({ minLength: 1 }), role: Type.String({ minLength: 1 }) },
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);
export const MemberRequestStartParamsSchema = Type.Object(
	{
		target: MemberStatusTargetSchema,
		message: MemberMessageContentSchema,
		instructions: Type.Optional(MessageInstructionsSchema),
		timeoutSeconds: RequestOutcomeTimeoutSchema,
		maxWaitSeconds: Type.Integer({ minimum: 60, maximum: 7200 }),
	},
	{ additionalProperties: false },
);
export const MemberRequestStartRequestSchema = Type.Object(
	{
		jsonrpc: Type.Literal(JSON_RPC_VERSION),
		id: RpcIdSchema,
		method: Type.Literal("member.request_start"),
		params: MemberRequestStartParamsSchema,
	},
	{ additionalProperties: false },
);
export const MemberRequestStartCommandSchema = Type.Object(
	{
		type: Type.Literal("member_request_start"),
		...MemberRequestStartParamsSchema.properties,
		id: Type.Optional(RpcIdSchema),
	},
	{ additionalProperties: false },
);
export const MemberRequestListParamsSchema = Type.Object(
	{ direction: Type.Optional(Type.Union([Type.Literal("inbound"), Type.Literal("outbound"), Type.Literal("all")])) },
	{ additionalProperties: false },
);
export const MemberRequestListRequestSchema = Type.Object(
	{
		jsonrpc: Type.Literal(JSON_RPC_VERSION),
		id: RpcIdSchema,
		method: Type.Literal("member.request_list"),
		params: MemberRequestListParamsSchema,
	},
	{ additionalProperties: false },
);
export const MemberRequestListCommandSchema = Type.Object(
	{
		type: Type.Literal("member_request_list"),
		...MemberRequestListParamsSchema.properties,
		id: Type.Optional(RpcIdSchema),
	},
	{ additionalProperties: false },
);
export const MemberRequestWaitParamsSchema = Type.Object(
	{ requestId: RequestOutcomeRequestIdSchema },
	{ additionalProperties: false },
);
export const MemberRequestWaitRequestSchema = Type.Object(
	{
		jsonrpc: Type.Literal(JSON_RPC_VERSION),
		id: RpcIdSchema,
		method: Type.Literal("member.request_wait"),
		params: MemberRequestWaitParamsSchema,
	},
	{ additionalProperties: false },
);
export const MemberRequestWaitCommandSchema = Type.Object(
	{
		type: Type.Literal("member_request_wait"),
		...MemberRequestWaitParamsSchema.properties,
		id: Type.Optional(RpcIdSchema),
	},
	{ additionalProperties: false },
);
export const MemberResponseParamsSchema = Type.Object(
	{
		requestId: RequestOutcomeRequestIdSchema,
		message: MemberMessageContentSchema,
		instructions: MessageInstructionsSchema,
	},
	{ additionalProperties: false },
);
export const MemberResponseRequestSchema = Type.Object(
	{
		jsonrpc: Type.Literal(JSON_RPC_VERSION),
		id: RpcIdSchema,
		method: Type.Literal("member.respond"),
		params: MemberResponseParamsSchema,
	},
	{ additionalProperties: false },
);
export const MemberResponseCommandSchema = Type.Object(
	{
		type: Type.Literal("member_response"),
		...MemberResponseParamsSchema.properties,
		id: Type.Optional(RpcIdSchema),
	},
	{ additionalProperties: false },
);
export const MemberUpdateResponseSchema = Type.Object(
	{
		kind: Type.Literal("response"),
		requestId: RequestOutcomeRequestIdSchema,
		member: Type.Object(
			{ name: Type.String({ minLength: 1 }), role: Type.String({ minLength: 1 }) },
			{ additionalProperties: false },
		),
		message: MemberMessageContentSchema,
		instructions: Type.Optional(MessageInstructionsSchema),
	},
	{ additionalProperties: false },
);
export const MemberUpdateMechanicalSchema = Type.Object(
	{
		kind: Type.Union([Type.Literal("offline"), Type.Literal("timeout")]),
		requestId: RequestOutcomeRequestIdSchema,
		member: Type.Object(
			{ name: Type.String({ minLength: 1 }), role: Type.String({ minLength: 1 }) },
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);
// TASK-0080: internal, NONTERMINAL first-idle notification (request-scoped).
// It is not a Request outcome; the source uses it only to arm the grace window
// once. Payload carries the original requestId + member (idle attribution).
export const MemberUpdateIdleSchema = Type.Object(
	{
		kind: Type.Literal("idle"),
		requestId: RequestOutcomeRequestIdSchema,
		member: Type.Object(
			{ name: Type.String({ minLength: 1 }), role: Type.String({ minLength: 1 }) },
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);
export const MemberUpdateNotificationSchema = Type.Object(
	{
		jsonrpc: Type.Literal(JSON_RPC_VERSION),
		method: Type.Literal("member.update"),
		params: Type.Union([MemberUpdateResponseSchema, MemberUpdateMechanicalSchema, MemberUpdateIdleSchema]),
	},
	{ additionalProperties: false },
);
export const MemberUpdateResultSchema = Type.Union([MemberUpdateResponseSchema, MemberUpdateMechanicalSchema]);
export const MemberUpdateIdleSchemaExport = MemberUpdateIdleSchema;

export const MemberInterruptParamsSchema = Type.Object(
	{
		target: MemberStatusTargetSchema,
		message: MemberMessageContentSchema,
		instructions: MessageInstructionsSchema,
	},
	{ additionalProperties: false },
);
export const MemberInterruptRequestSchema = Type.Object(
	{
		jsonrpc: Type.Literal(JSON_RPC_VERSION),
		id: RpcIdSchema,
		method: Type.Literal("member.interrupt"),
		params: MemberInterruptParamsSchema,
	},
	{ additionalProperties: false },
);
export const MemberInterruptCommandSchema = Type.Object(
	{
		type: Type.Literal("member_interrupt"),
		target: MemberStatusTargetSchema,
		message: MemberMessageContentSchema,
		instructions: MessageInstructionsSchema,
		id: Type.Optional(RpcIdSchema),
	},
	{ additionalProperties: false },
);
export const MemberInterruptResultSchema = Type.Object(
	{
		member: Type.Object(
			{ name: Type.String({ minLength: 1 }), role: Type.String({ minLength: 1 }) },
			{ additionalProperties: false },
		),
		interruptId: Type.String({ minLength: 1 }),
		disposition: Type.Union([Type.Literal("direct"), Type.Literal("interrupt-requested")]),
	},
	{ additionalProperties: false },
);
