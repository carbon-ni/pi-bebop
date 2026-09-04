import { Type } from "@sinclair/typebox";
import { JSON_RPC_VERSION, RpcIdSchema, MemberStatusTargetSchema } from "./wire-base.ts";
import { MessageInstructionsSchema, MAX_MESSAGE_CONTENT_BYTES } from "../message-payload.ts";
import { MemberMessageContentSchema, RequestOutcomeRequestIdSchema } from "./wire-members.ts";

export const MemberInboxSendParamsSchema = Type.Object(
	{
		target: MemberStatusTargetSchema,
		message: MemberMessageContentSchema,
		instructions: MessageInstructionsSchema,
	},
	{ additionalProperties: false },
);
export const CrewBroadcastParamsSchema = Type.Object(
	{ message: MemberMessageContentSchema, instructions: MessageInstructionsSchema },
	{ additionalProperties: false },
);
export const MemberInboxSendRequestSchema = Type.Object(
	{
		jsonrpc: Type.Literal(JSON_RPC_VERSION),
		id: RpcIdSchema,
		method: Type.Literal("member.inbox_send"),
		params: MemberInboxSendParamsSchema,
	},
	{ additionalProperties: false },
);
export const CrewBroadcastRequestSchema = Type.Object(
	{
		jsonrpc: Type.Literal(JSON_RPC_VERSION),
		id: RpcIdSchema,
		method: Type.Literal("crew.broadcast"),
		params: CrewBroadcastParamsSchema,
	},
	{ additionalProperties: false },
);
export const MemberInboxSendCommandSchema = Type.Object(
	{
		type: Type.Literal("member_inbox_send"),
		target: MemberStatusTargetSchema,
		message: MemberMessageContentSchema,
		instructions: MessageInstructionsSchema,
		id: Type.Optional(RpcIdSchema),
	},
	{ additionalProperties: false },
);
export const CrewBroadcastCommandSchema = Type.Object(
	{
		type: Type.Literal("crew_broadcast"),
		message: MemberMessageContentSchema,
		instructions: MessageInstructionsSchema,
		id: Type.Optional(RpcIdSchema),
	},
	{ additionalProperties: false },
);

/** Guest admission is deliberately a narrow request: the target Member derives
 * Crew identity and approver context from its trusted local membership. */
export const GuestJoinParamsSchema = Type.Object(
	{
		guestIdentity: Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000\\r\\n]+$" }),
		guestName: Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000\\r\\n]+$" }),
		callbackEndpoint: Type.String({ minLength: 1, maxLength: 512, pattern: "^[^\\u0000\\r\\n]+$" }),
	},
	{ additionalProperties: false },
);
export const GuestJoinRpcRequestSchema = Type.Object(
	{
		jsonrpc: Type.Literal(JSON_RPC_VERSION),
		id: RpcIdSchema,
		method: Type.Literal("guest.join"),
		params: GuestJoinParamsSchema,
	},
	{ additionalProperties: false },
);
export const GuestJoinCommandSchema = Type.Object(
	{
		type: Type.Literal("guest_join"),
		...GuestJoinParamsSchema.properties,
		id: Type.Optional(RpcIdSchema),
	},
	{ additionalProperties: false },
);
export const GuestJoinCrewSchema = Type.Object(
	{ id: Type.String({ minLength: 1 }), displayName: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);
export const GuestJoinResultSchema = Type.Object(
	{
		status: Type.Union([Type.Literal("pending"), Type.Literal("approved")]),
		requestId: Type.String({ minLength: 1 }),
		crew: GuestJoinCrewSchema,
		/** Member-issued capability; delivered on the approved join response only. */
		capability: Type.Optional(Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000\\r\\n]+$" })),
	},
	{ additionalProperties: false },
);
export const GuestLeaveParamsSchema = Type.Object(
	{
		guestIdentity: Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000\\r\\n]+$" }),
		crewId: Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000\\r\\n]+$" }),
		callbackEndpoint: Type.String({ minLength: 1, maxLength: 512, pattern: "^[^\\u0000\\r\\n]+$" }),
	},
	{ additionalProperties: false },
);

export const GuestSendBoundedText = (maxLength: number) =>
	Type.String({ minLength: 1, maxLength, pattern: "^[^\\u0000\\r\\n]+$" });

export const GuestSendParamsSchema = Type.Object(
	{
		crewId: GuestSendBoundedText(256),
		guestIdentity: GuestSendBoundedText(256),
		callbackEndpoint: GuestSendBoundedText(512),
		capability: GuestSendBoundedText(256),
		target: GuestSendBoundedText(256),
		content: Type.String({ minLength: 1, maxLength: 1_000_000 }),
		kind: Type.Optional(Type.Union([Type.Literal("follow-up"), Type.Literal("broadcast")])),
		instructions: Type.Optional(Type.Array(GuestSendBoundedText(100_000), { maxItems: 32 })),
	},
	{ additionalProperties: false },
);
export const GuestSendResultSchema = Type.Object(
	{
		deliveryId: Type.String({ minLength: 1 }),
		disposition: Type.Union([Type.Literal("direct"), Type.Literal("queued"), Type.Literal("steered")]),
		fromGuestName: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);
export const GuestSendCommandSchema = Type.Object(
	{
		type: Type.Literal("guest_send"),
		...GuestSendParamsSchema.properties,
		id: Type.Optional(RpcIdSchema),
	},
	{ additionalProperties: false },
);
export const GuestLeaveRequestSchema = Type.Object(
	{
		jsonrpc: Type.Literal(JSON_RPC_VERSION),
		id: RpcIdSchema,
		method: Type.Literal("guest.leave"),
		params: GuestLeaveParamsSchema,
	},
	{ additionalProperties: false },
);
export const GuestLeaveCommandSchema = Type.Object(
	{ type: Type.Literal("guest_leave"), ...GuestLeaveParamsSchema.properties, id: Type.Optional(RpcIdSchema) },
	{ additionalProperties: false },
);
/** Delivery acknowledgement
 to the CLI: resolved member identity plus the
 * delivery ack. Accepted-delivery only; never a response correlation. */
export const MemberMessageResultSchema = Type.Object(
	{
		member: Type.Object(
			{ name: Type.String({ minLength: 1 }), role: Type.String({ minLength: 1 }) },
			{ additionalProperties: false },
		),
		deliveryId: Type.String({ minLength: 1 }),
		disposition: Type.Union([Type.Literal("direct"), Type.Literal("queued"), Type.Literal("steered")]),
	},
	{ additionalProperties: false },
);
export const MemberInboxSendResultSchema = Type.Object(
	{
		member: Type.Object(
			{ name: Type.String({ minLength: 1 }), role: Type.String({ minLength: 1 }) },
			{ additionalProperties: false },
		),
		itemId: Type.String({ minLength: 1 }),
		persisted: Type.Literal(true),
		hint: Type.Union([Type.Literal("sent"), Type.Literal("skipped")]),
	},
	{ additionalProperties: false },
);
export const BroadcastDispositionBaseSchema = {
	member: Type.String({ minLength: 1 }),
	role: Type.String({ minLength: 1 }),
};
export const BroadcastDispositionSchema = Type.Union([
	Type.Object(
		{
			...BroadcastDispositionBaseSchema,
			deliveryId: Type.String({ minLength: 1 }),
			disposition: Type.Literal("delivered"),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			...BroadcastDispositionBaseSchema,
			disposition: Type.Literal("failed"),
			code: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
]);
export const BroadcastSummarySchema = Type.Object(
	{
		delivered: Type.Integer({ minimum: 0 }),
		failed: Type.Integer({ minimum: 0 }),
		total: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);
export const CrewBroadcastResultSchema = Type.Object(
	{
		dispositions: Type.Array(BroadcastDispositionSchema),
		summary: BroadcastSummarySchema,
	},
	{ additionalProperties: false },
);
export const MAX_MEMBER_IDLE_WAIT_TIMEOUT = 7200;
export const MIN_MEMBER_IDLE_WAIT_TIMEOUT = 60;
export const MemberIdleWaitTimeoutSchema = Type.Integer({
	minimum: MIN_MEMBER_IDLE_WAIT_TIMEOUT,
	maximum: MAX_MEMBER_IDLE_WAIT_TIMEOUT,
});
/** One-shot idle wait: one bounded member label and an optional bounded timeout. */
