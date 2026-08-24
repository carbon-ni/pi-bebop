import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ExtractedMessageSchema, type ExtractedMessage } from "./messages.ts";
import {
	MessageOriginSchema,
	MessagePayloadSchema,
	isMessagePayload,
	type MessagePayload,
	MessageInstructionsSchema,
	MAX_MESSAGE_CONTENT_BYTES,
} from "./message-payload.ts";
import { MemberStatusSchema } from "./member-status.ts";
import { MemberIdleWaitResultSchema } from "./member-idle-wait.ts";

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
const PresenceHintTextSchema = Type.String({
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
export const InterruptPayloadSchema = Type.Object(
	{
		content: Type.String({ minLength: 1, maxLength: MAX_MESSAGE_CONTENT_BYTES }),
		instructions: Type.Optional(MessageInstructionsSchema),
		origin: Type.Optional(MessageOriginSchema),
	},
	{ additionalProperties: false },
);
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
const MemberStatusTargetSchema = Type.String({ minLength: 1, maxLength: MAX_MEMBER_STATUS_TARGET_BYTES });
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
/** Delivery acknowledgement to the CLI: resolved member identity plus the
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
const BroadcastDispositionBaseSchema = {
	member: Type.String({ minLength: 1 }),
	role: Type.String({ minLength: 1 }),
	itemId: Type.String({ minLength: 1 }),
};
const BroadcastDispositionSchema = Type.Union([
	Type.Object(
		{ ...BroadcastDispositionBaseSchema, disposition: Type.Literal("persisted") },
		{ additionalProperties: false },
	),
	Type.Object(
		{ ...BroadcastDispositionBaseSchema, disposition: Type.Literal("already-persisted") },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			...BroadcastDispositionBaseSchema,
			disposition: Type.Literal("failed"),
			code: Type.Union([
				Type.Literal("inbox-full"),
				Type.Literal("inbox-untrusted-path"),
				Type.Literal("untrusted-project"),
				Type.Literal("storage-unavailable"),
				Type.Literal("storage-failed"),
				Type.Literal("invalid-payload"),
				Type.Literal("invalid-item-id"),
				Type.Literal("aborted"),
			]),
		},
		{ additionalProperties: false },
	),
]);
const BroadcastSummarySchema = Type.Object(
	{
		persisted: Type.Integer({ minimum: 0 }),
		alreadyPersisted: Type.Integer({ minimum: 0 }),
		failed: Type.Integer({ minimum: 0 }),
		total: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);
export const CrewBroadcastResultSchema = Type.Object(
	{
		broadcastId: Type.String({ minLength: 1 }),
		dispositions: Type.Array(BroadcastDispositionSchema),
		summary: BroadcastSummarySchema,
	},
	{ additionalProperties: false },
);
export const MAX_MEMBER_IDLE_WAIT_TIMEOUT = 600;
const MemberIdleWaitTimeoutSchema = Type.Integer({ minimum: 1, maximum: MAX_MEMBER_IDLE_WAIT_TIMEOUT });
/** One-shot idle wait: one bounded member label and an optional bounded timeout. */
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
	MemberFollowUpRequestSchema,
	MemberRedirectRequestSchema,
	MemberInboxSendRequestSchema,
	CrewBroadcastRequestSchema,
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
export const RpcMethodResultSchema = Type.Union([
	StatusResultSchema,
	SendResultSchema,
	InterruptResultSchema,
	GetMessageResultSchema,
	ClearResultSchema,
	SubscribeResultSchema,
	PresenceHintResultSchema,
	MemberStatusResultSchema,
	MemberMessageResultSchema,
	MemberInboxSendResultSchema,
	CrewBroadcastResultSchema,
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

export type RpcId = Static<typeof RpcIdSchema>;
export type RpcRequest = Static<typeof RpcRequestSchema>;
export type MessageSendRequest = Static<typeof MessageSendRequestSchema>;
export type InterruptParams = Static<typeof InterruptParamsSchema>;
export type InterruptResult = Static<typeof InterruptResultSchema>;
export type InterruptRequest = Static<typeof InterruptRequestSchema>;
export type SubscribeRequest = Static<typeof SubscribeRequestSchema>;
export type StatusRequest = Static<typeof StatusRequestSchema>;
export type GetMessageRequest = Static<typeof GetMessageRequestSchema>;
export type ClearRequest = Static<typeof ClearRequestSchema>;
export type AbortRequest = Static<typeof AbortRequestSchema>;
export type PresenceHintParams = Static<typeof PresenceHintParamsSchema>;
export type MemberStatusParams = Static<typeof MemberStatusParamsSchema>;
export type MemberIdleWaitParams = Static<typeof MemberIdleWaitParamsSchema>;
export type MemberStatusCommand = Static<typeof MemberStatusCommandSchema>;
export type MemberStatusResult = Static<typeof MemberStatusResultSchema>;
export type MemberStatusTargetParams = Static<typeof MemberStatusTargetParamsSchema>;
export type MemberStatusTargetCommand = Static<typeof MemberStatusTargetCommandSchema>;
export type MemberMessageParams = Static<typeof MemberMessageParamsSchema>;
export type MemberFollowUpParams = Static<typeof MemberFollowUpParamsSchema>;
export type MemberRedirectParams = Static<typeof MemberRedirectParamsSchema>;
export type MemberInboxSendParams = Static<typeof MemberInboxSendParamsSchema>;
export type CrewBroadcastParams = Static<typeof CrewBroadcastParamsSchema>;
export type MemberFollowUpCommand = Static<typeof MemberFollowUpCommandSchema>;
export type MemberRedirectCommand = Static<typeof MemberRedirectCommandSchema>;
export type MemberMessageResult = Static<typeof MemberMessageResultSchema>;
export function isMemberMessageResult(value: unknown): value is MemberMessageResult {
	return Value.Check(MemberMessageResultSchema, value);
}
export function isMemberInboxSendResult(value: unknown): value is MemberInboxSendResult {
	return Value.Check(MemberInboxSendResultSchema, value);
}
export function isCrewBroadcastResult(value: unknown): value is CrewBroadcastRpcResult {
	return Value.Check(CrewBroadcastResultSchema, value);
}
export type PresenceHintRequest = Static<typeof PresenceHintRequestSchema>;
export type PresenceHintResult = Static<typeof PresenceHintResultSchema>;
export type MessageSendParams = Static<typeof MessageSendParamsSchema>;
export type MessageSendPayload = MessagePayload;
export type SubscribeParams = Static<typeof SubscribeParamsSchema>;
export type StatusParams = Static<typeof EmptyParamsSchema>;
export type GetMessageParams = Static<typeof EmptyParamsSchema>;
export type ClearParams = Static<typeof EmptyParamsSchema>;
export type AbortParams = Static<typeof EmptyParamsSchema>;
export type StatusResult = Static<typeof StatusResultSchema>;
export type SendResult = Static<typeof SendResultSchema>;
export type DeliveryIntent = NonNullable<MessageSendParams["delivery"]>;
export type DeliveryDisposition = SendResult["disposition"];
export type GetMessageResult = Static<typeof GetMessageResultSchema>;
export type ClearResult = Static<typeof ClearResultSchema>;
export type SubscribeResult = Static<typeof SubscribeResultSchema>;
export type AbortResult = Static<typeof EmptyResultSchema>;
export type RpcError = Static<typeof RpcErrorSchema>;
export type RpcWireResponse = Static<typeof RpcResponseSchema>;
export type RpcMethodResult = Static<typeof RpcMethodResultSchema>;
export type RpcNotification =
	| Static<typeof TurnEndNotificationSchema>
	| Static<typeof MemberIdleWaitNotificationSchema>;
export type RpcCommand =
	| Static<typeof MessageSendCommandSchema>
	| Static<typeof InterruptCommandSchema>
	| Static<typeof SubscribeCommandSchema>
	| Static<typeof StatusCommandSchema>
	| Static<typeof GetMessageCommandSchema>
	| Static<typeof ClearCommandSchema>
	| Static<typeof AbortCommandSchema>
	| Static<typeof PresenceHintCommandSchema>
	| Static<typeof MemberStatusCommandSchema>
	| Static<typeof MemberStatusTargetCommandSchema>
	| Static<typeof MemberFollowUpCommandSchema>
	| Static<typeof MemberRedirectCommandSchema>
	| Static<typeof MemberInboxSendCommandSchema>
	| Static<typeof CrewBroadcastCommandSchema>
	| Static<typeof MemberIdleWaitCommandSchema>;
type RequiredId<T extends { id?: RpcId }> = Omit<T, "id"> & { id: RpcId };
export type RpcInboundCommand =
	| RequiredId<Static<typeof MessageSendCommandSchema>>
	| RequiredId<Static<typeof InterruptCommandSchema>>
	| RequiredId<Static<typeof SubscribeCommandSchema>>
	| RequiredId<Static<typeof StatusCommandSchema>>
	| RequiredId<Static<typeof GetMessageCommandSchema>>
	| RequiredId<Static<typeof ClearCommandSchema>>
	| RequiredId<Static<typeof AbortCommandSchema>>
	| RequiredId<Static<typeof PresenceHintCommandSchema>>
	| RequiredId<Static<typeof MemberStatusCommandSchema>>
	| RequiredId<Static<typeof MemberStatusTargetCommandSchema>>
	| RequiredId<Static<typeof MemberFollowUpCommandSchema>>
	| RequiredId<Static<typeof MemberRedirectCommandSchema>>
	| RequiredId<Static<typeof MemberInboxSendCommandSchema>>
	| RequiredId<Static<typeof CrewBroadcastCommandSchema>>
	| RequiredId<Static<typeof MemberIdleWaitCommandSchema>>;
export type MessageSendCommand = Static<typeof MessageSendCommandSchema>;
export type InterruptCommand = Static<typeof InterruptCommandSchema>;
export type SubscribeCommand = Static<typeof SubscribeCommandSchema>;
export type StatusCommand = Static<typeof StatusCommandSchema>;
export type GetMessageCommand = Static<typeof GetMessageCommandSchema>;
export type ClearCommand = Static<typeof ClearCommandSchema>;
export type AbortCommand = Static<typeof AbortCommandSchema>;
export type PresenceHintCommand = Static<typeof PresenceHintCommandSchema>;
export type MemberInboxSendCommand = Static<typeof MemberInboxSendCommandSchema>;
export type CrewBroadcastCommand = Static<typeof CrewBroadcastCommandSchema>;
export type MemberInboxSendResult = Static<typeof MemberInboxSendResultSchema>;
export type CrewBroadcastRpcResult = Static<typeof CrewBroadcastResultSchema>;
export type MemberIdleWaitCommand = Static<typeof MemberIdleWaitCommandSchema>;
export type MemberIdleWaitSubscribeResult = Static<typeof MemberIdleWaitSubscribeResultSchema>;
export type RpcSendCommand = MessageSendCommand;
export type RpcSubscribeCommand = SubscribeCommand;

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
export interface ProtocolFailure {
	code: number;
	message: string;
	data?: { code?: string };
}
export function isPresenceHintParams(value: unknown): value is PresenceHintParams {
	if (!Value.Check(PresenceHintParamsSchema, value)) return false;
	const params = value as PresenceHintParams;
	return [params.member.identity, params.member.name, params.member.role, params.instanceId].every(
		(field) => field.trim() === field && Buffer.byteLength(field, "utf8") <= MAX_PRESENCE_HINT_FIELD_BYTES,
	);
}
export function isRpcRequest(value: unknown): value is RpcRequest {
	return Value.Check(RpcRequestSchema, value);
}
export function isRpcResponse(value: unknown): value is RpcWireResponse {
	return Value.Check(RpcResponseSchema, value);
}
export function isTurnEndNotification(value: unknown): value is Static<typeof TurnEndNotificationSchema> {
	return Value.Check(TurnEndNotificationSchema, value);
}
export function methodResultSchema(method: string) {
	return method === "session.status"
		? StatusResultSchema
		: method === "message.send"
			? SendResultSchema
			: method === "message.interrupt"
				? InterruptResultSchema
				: method === "member.status"
					? MemberStatusResultSchema
					: method === "member.status_target"
						? MemberStatusResultSchema
						: method === "member.follow_up"
							? MemberMessageResultSchema
							: method === "member.redirect"
								? MemberMessageResultSchema
								: method === "member.inbox_send"
									? MemberInboxSendResultSchema
									: method === "crew.broadcast"
										? CrewBroadcastResultSchema
										: method === "member.idle_wait"
											? MemberIdleWaitSubscribeResultSchema
											: method === "session.get_message"
												? GetMessageResultSchema
												: method === "session.clear"
													? ClearResultSchema
													: method === "session.abort"
														? EmptyResultSchema
														: method === "event.subscribe"
															? SubscribeResultSchema
															: method === "presence.hint"
																? PresenceHintResultSchema
																: undefined;
}
export function isMethodResult(method: string, value: unknown): value is RpcMethodResult {
	const schema = methodResultSchema(method);
	return schema ? Value.Check(schema, value) : false;
}
export function isSendResult(value: unknown): value is SendResult {
	return Value.Check(SendResultSchema, value);
}
export function isInterruptResult(value: unknown): value is InterruptResult {
	return Value.Check(InterruptResultSchema, value);
}
export function isMemberStatusResult(value: unknown): value is MemberStatusResult {
	return Value.Check(MemberStatusResultSchema, value);
}
export function isMemberIdleWaitSubscribeResult(
	value: unknown,
): value is Static<typeof MemberIdleWaitSubscribeResultSchema> {
	return Value.Check(MemberIdleWaitSubscribeResultSchema, value);
}
export function isMemberIdleWaitNotification(value: unknown): value is Static<typeof MemberIdleWaitNotificationSchema> {
	return Value.Check(MemberIdleWaitNotificationSchema, value);
}
export function isSubscribeResult(value: unknown): value is Static<typeof SubscribeResultSchema> {
	return Value.Check(SubscribeResultSchema, value);
}
export function isGetMessageResult(value: unknown): value is Static<typeof GetMessageResultSchema> {
	return Value.Check(GetMessageResultSchema, value);
}
export function isExtractedMessage(value: unknown): value is Static<typeof ExtractedMessageSchema> {
	return Value.Check(ExtractedMessageSchema, value);
}
export function isClearResult(value: unknown): value is Static<typeof ClearResultSchema> {
	return Value.Check(ClearResultSchema, value);
}
export function buildResultResponse(id: RpcId, method: string, result: unknown): RpcWireResponse | ProtocolFailure {
	if (!isMethodResult(method, result))
		return { code: RPC_ERROR.internal, message: "Invalid method result", data: { code: "invalid-result" } };
	return { jsonrpc: JSON_RPC_VERSION, id, result };
}
export function buildErrorResponse(
	id: RpcId | null,
	code: number,
	message: string,
	data?: { code?: string },
): RpcWireResponse {
	return { jsonrpc: JSON_RPC_VERSION, id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}
export function buildTurnEndNotification(
	subscriptionId: string,
	message: ExtractedMessage | null,
	turnIndex?: number,
): RpcNotification {
	const value: RpcNotification = {
		jsonrpc: JSON_RPC_VERSION,
		method: "session.turn_end",
		params: { subscriptionId, message, ...(turnIndex === undefined ? {} : { turnIndex }) },
	};
	if (!isTurnEndNotification(value)) throw new Error("Invalid turn-end notification");
	return value;
}
export function serializeRequest(request: RpcRequest): string {
	if (!isRpcRequest(request)) throw new Error("Invalid JSON-RPC request");
	return `${JSON.stringify(request)}\n`;
}
export function serializeProtocolMessage(value: RpcWireResponse | RpcNotification): string {
	if (
		!Value.Check(RpcResponseSchema, value) &&
		!Value.Check(TurnEndNotificationSchema, value) &&
		!Value.Check(MemberIdleWaitNotificationSchema, value)
	)
		throw new Error("Invalid JSON-RPC message");
	return `${JSON.stringify(value)}\n`;
}
export function commandToRequest(command: RpcCommand, id: RpcId): RpcRequest {
	if (command.type === "send")
		return {
			jsonrpc: JSON_RPC_VERSION,
			id,
			method: "message.send",
			params: {
				...command.payload,
				delivery: command.delivery ?? "follow_up",
			},
		};
	if (command.type === "interrupt")
		return { jsonrpc: JSON_RPC_VERSION, id, method: "message.interrupt", params: { payload: command.payload } };
	if (command.type === "member_status")
		return { jsonrpc: JSON_RPC_VERSION, id, method: "member.status", params: { member: command.member } };
	if (command.type === "member_status_target")
		return { jsonrpc: JSON_RPC_VERSION, id, method: "member.status_target", params: { target: command.target } };
	if (command.type === "member_follow_up")
		return {
			jsonrpc: JSON_RPC_VERSION,
			id,
			method: "member.follow_up",
			params: {
				target: command.target,
				message: command.message,
				...(command.instructions === undefined ? {} : { instructions: command.instructions }),
			},
		};
	if (command.type === "member_redirect")
		return {
			jsonrpc: JSON_RPC_VERSION,
			id,
			method: "member.redirect",
			params: {
				target: command.target,
				message: command.message,
				...(command.instructions === undefined ? {} : { instructions: command.instructions }),
			},
		};
	if (command.type === "member_inbox_send")
		return {
			jsonrpc: JSON_RPC_VERSION,
			id,
			method: "member.inbox_send",
			params: {
				target: command.target,
				message: command.message,
				...(command.instructions === undefined ? {} : { instructions: command.instructions }),
			},
		};
	if (command.type === "crew_broadcast")
		return {
			jsonrpc: JSON_RPC_VERSION,
			id,
			method: "crew.broadcast",
			params: {
				message: command.message,
				...(command.instructions === undefined ? {} : { instructions: command.instructions }),
			},
		};
	if (command.type === "member_idle_wait")
		return {
			jsonrpc: JSON_RPC_VERSION,
			id,
			method: "member.idle_wait",
			params: {
				member: command.member,
				...(command.timeoutSeconds === undefined ? {} : { timeoutSeconds: command.timeoutSeconds }),
			},
		};
	if (command.type === "subscribe")
		return { jsonrpc: JSON_RPC_VERSION, id, method: "event.subscribe", params: { event: command.event } };
	if (command.type === "status") return { jsonrpc: JSON_RPC_VERSION, id, method: "session.status" };
	if (command.type === "get_message") return { jsonrpc: JSON_RPC_VERSION, id, method: "session.get_message" };
	if (command.type === "clear") return { jsonrpc: JSON_RPC_VERSION, id, method: "session.clear" };
	if (command.type === "presence_hint")
		return {
			jsonrpc: JSON_RPC_VERSION,
			id,
			method: "presence.hint",
			params: { member: command.member, state: command.state, instanceId: command.instanceId },
		};
	return { jsonrpc: JSON_RPC_VERSION, id, method: "session.abort" };
}
export function requestToCommand(request: RpcRequest): RpcInboundCommand | ProtocolFailure {
	const params = "params" in request ? request.params : undefined;
	const invalid = (message: string): ProtocolFailure => ({ code: RPC_ERROR.invalidParams, message });
	if (request.method === "message.send") {
		const rawParams = params && typeof params === "object" ? (params as Record<string, unknown>) : undefined;
		const payload = rawParams
			? {
					content: rawParams.content,
					...(rawParams.instructions === undefined ? {} : { instructions: rawParams.instructions }),
					...(rawParams.origin === undefined ? {} : { origin: rawParams.origin }),
					...(rawParams.replyTo === undefined ? {} : { replyTo: rawParams.replyTo }),
				}
			: undefined;
		if (!Value.Check(MessageSendParamsSchema, params) || !isMessagePayload(payload))
			return invalid("Invalid message.send params");
		const validParams = params as MessageSendParams;
		return {
			type: "send",
			payload: payload as MessagePayload,
			delivery: validParams.delivery ?? "follow_up",
			id: request.id,
		};
	}
	if (request.method === "message.interrupt") {
		if (!Value.Check(InterruptParamsSchema, params)) return invalid("Invalid message.interrupt params");
		const payload = (params as InterruptParams).payload;
		if (!isMessagePayload(payload)) return invalid("Invalid message.interrupt payload");
		return { type: "interrupt", payload, id: request.id };
	}
	if (request.method === "member.status") {
		if (!Value.Check(MemberStatusParamsSchema, params)) return invalid("Invalid member.status params");
		return { type: "member_status", member: (params as MemberStatusParams).member, id: request.id };
	}
	if (request.method === "member.status_target") {
		if (!Value.Check(MemberStatusTargetParamsSchema, params)) return invalid("Invalid member.status_target params");
		return { type: "member_status_target", target: (params as MemberStatusTargetParams).target, id: request.id };
	}
	if (request.method === "member.follow_up") {
		if (!Value.Check(MemberFollowUpParamsSchema, params)) return invalid("Invalid member.follow_up params");
		const delivery = params as MemberFollowUpParams;
		return {
			type: "member_follow_up",
			target: delivery.target,
			message: delivery.message,
			...(delivery.instructions === undefined ? {} : { instructions: delivery.instructions }),
			id: request.id,
		};
	}
	if (request.method === "member.redirect") {
		if (!Value.Check(MemberRedirectParamsSchema, params)) return invalid("Invalid member.redirect params");
		const delivery = params as MemberRedirectParams;
		return {
			type: "member_redirect",
			target: delivery.target,
			message: delivery.message,
			...(delivery.instructions === undefined ? {} : { instructions: delivery.instructions }),
			id: request.id,
		};
	}
	if (request.method === "member.inbox_send") {
		if (!Value.Check(MemberInboxSendParamsSchema, params)) return invalid("Invalid member.inbox_send params");
		const delivery = params as Static<typeof MemberInboxSendParamsSchema>;
		return {
			type: "member_inbox_send",
			target: delivery.target,
			message: delivery.message,
			...(delivery.instructions === undefined ? {} : { instructions: delivery.instructions }),
			id: request.id,
		};
	}
	if (request.method === "crew.broadcast") {
		if (!Value.Check(CrewBroadcastParamsSchema, params)) return invalid("Invalid crew.broadcast params");
		const delivery = params as Static<typeof CrewBroadcastParamsSchema>;
		return {
			type: "crew_broadcast",
			message: delivery.message,
			...(delivery.instructions === undefined ? {} : { instructions: delivery.instructions }),
			id: request.id,
		};
	}
	if (request.method === "member.idle_wait") {
		if (!Value.Check(MemberIdleWaitParamsSchema, params)) return invalid("Invalid member.idle_wait params");
		const waitParams = params as MemberIdleWaitParams;
		return {
			type: "member_idle_wait",
			member: waitParams.member,
			...(waitParams.timeoutSeconds === undefined ? {} : { timeoutSeconds: waitParams.timeoutSeconds }),
			id: request.id,
		};
	}
	if (request.method === "presence.hint") {
		if (!isPresenceHintParams(params)) return invalid("Invalid presence.hint params");
		return { type: "presence_hint", ...params, id: request.id } as RpcInboundCommand;
	}
	if (["session.status", "session.get_message", "session.clear", "session.abort"].includes(request.method)) {
		if (params !== undefined) return invalid(`Invalid ${request.method} params`);
		if (request.method === "session.status") return { type: "status", id: request.id };
		if (request.method === "session.get_message") return { type: "get_message", id: request.id };
		if (request.method === "session.clear") return { type: "clear", id: request.id };
		return { type: "abort", id: request.id };
	}
	if (request.method === "event.subscribe")
		return Value.Check(SubscribeParamsSchema, params)
			? { type: "subscribe", event: "turn_end", id: request.id }
			: invalid("Invalid event.subscribe params");
	return {
		code: RPC_ERROR.methodNotFound,
		message: `Method not found: ${request.method}`,
		data: { code: "method-not-found" },
	};
}
export function parseRequest(line: string): { request?: RpcRequest; error?: ProtocolFailure } {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return { error: { code: RPC_ERROR.parse, message: "Parse error" } };
	}
	if (!isRpcRequest(value)) return { error: { code: RPC_ERROR.invalidRequest, message: "Invalid Request" } };
	return { request: value };
}
