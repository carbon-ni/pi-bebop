import { Value } from "@sinclair/typebox/value";
import type { Static } from "@sinclair/typebox";
import type { MessagePayload } from "../message-payload.ts";
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
	MemberUpdateIdleSchema,
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
import {
	MessageSendCommandSchema,
	InterruptCommandSchema,
	SubscribeCommandSchema,
	StatusCommandSchema,
	GetMessageCommandSchema,
	ClearCommandSchema,
	AbortCommandSchema,
	PresenceHintCommandSchema,
	RPC_ERROR,
	RpcCommandResponseSchema,
	RpcTurnEndNotificationSchema,
} from "./command-schemas.ts";

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
export type MemberRequestParams = Static<typeof MemberRequestParamsSchema>;
export type MemberRequestCommand = Static<typeof MemberRequestCommandSchema>;
export type MemberRequestStartParams = Static<typeof MemberRequestStartParamsSchema>;
export type MemberRequestStartCommand = Static<typeof MemberRequestStartCommandSchema>;
export type MemberRequestListCommand = Static<typeof MemberRequestListCommandSchema>;
export type MemberRequestWaitCommand = Static<typeof MemberRequestWaitCommandSchema>;
export type MemberRequestResult = Static<typeof MemberRequestResultSchema>;
export type MemberResponseParams = Static<typeof MemberResponseParamsSchema>;
export type MemberUpdateResult = Static<typeof MemberUpdateResultSchema>;
export type MemberUpdateIdle = Static<typeof MemberUpdateIdleSchema>;
/** TASK-0080: everything a request channel may deliver: terminals + the internal nonterminal idle. */
export type MemberChannelUpdate = MemberUpdateResult | MemberUpdateIdle;
export type MemberResponseCommand = Static<typeof MemberResponseCommandSchema>;
export type MemberInterruptParams = Static<typeof MemberInterruptParamsSchema>;
export type MemberInterruptCommand = Static<typeof MemberInterruptCommandSchema>;
export type MemberInterruptResult = Static<typeof MemberInterruptResultSchema>;
export type MemberMessageParams = Static<typeof MemberMessageParamsSchema>;
export type MemberFollowUpParams = Static<typeof MemberFollowUpParamsSchema>;
export type MemberRedirectParams = Static<typeof MemberRedirectParamsSchema>;
export type MemberInboxSendParams = Static<typeof MemberInboxSendParamsSchema>;
export type CrewBroadcastParams = Static<typeof CrewBroadcastParamsSchema>;
export type GuestJoinParams = Static<typeof GuestJoinParamsSchema>;
export type GuestJoinResult = Static<typeof GuestJoinResultSchema>;
export type GuestJoinCommand = Static<typeof GuestJoinCommandSchema>;
export type GuestSendCommand = Static<typeof GuestSendCommandSchema>;
export type GuestSendParams = Static<typeof GuestSendParamsSchema>;
export type GuestSendResult = Static<typeof GuestSendResultSchema>;
export type GuestLeaveParams = Static<typeof GuestLeaveParamsSchema>;
export type GuestLeaveCommand = Static<typeof GuestLeaveCommandSchema>;
export type MemberFollowUpCommand = Static<typeof MemberFollowUpCommandSchema>;
export type MemberRedirectCommand = Static<typeof MemberRedirectCommandSchema>;
export type MemberMessageResult = Static<typeof MemberMessageResultSchema>;
export function isMemberInterruptResult(value: unknown): value is MemberInterruptResult {
	return Value.Check(MemberInterruptResultSchema, value);
}
export function isMemberMessageResult(value: unknown): value is MemberMessageResult {
	return Value.Check(MemberMessageResultSchema, value);
}
export function isMemberInboxSendResult(value: unknown): value is MemberInboxSendResult {
	return Value.Check(MemberInboxSendResultSchema, value);
}
export function isCrewBroadcastResult(value: unknown): value is CrewBroadcastRpcResult {
	if (!Value.Check(CrewBroadcastResultSchema, value)) return false;
	const result = value as CrewBroadcastRpcResult;
	const delivered = result.dispositions.filter((item) => item.disposition === "delivered").length;
	const failed = result.dispositions.filter((item) => item.disposition === "failed").length;
	return (
		result.summary.total === result.dispositions.length &&
		result.summary.delivered === delivered &&
		result.summary.failed === failed
	);
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
	| Static<typeof MemberIdleWaitNotificationSchema>
	| Static<typeof MemberUpdateNotificationSchema>;
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
	| Static<typeof MemberRequestCommandSchema>
	| Static<typeof MemberRequestStartCommandSchema>
	| Static<typeof MemberRequestListCommandSchema>
	| Static<typeof MemberRequestWaitCommandSchema>
	| Static<typeof MemberResponseCommandSchema>
	| Static<typeof MemberInterruptCommandSchema>
	| Static<typeof MemberFollowUpCommandSchema>
	| Static<typeof MemberRedirectCommandSchema>
	| Static<typeof MemberInboxSendCommandSchema>
	| Static<typeof CrewBroadcastCommandSchema>
	| Static<typeof GuestJoinCommandSchema>
	| Static<typeof GuestLeaveCommandSchema>
	| Static<typeof GuestSendCommandSchema>
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
	| RequiredId<Static<typeof MemberRequestCommandSchema>>
	| RequiredId<Static<typeof MemberRequestStartCommandSchema>>
	| RequiredId<Static<typeof MemberRequestListCommandSchema>>
	| RequiredId<Static<typeof MemberRequestWaitCommandSchema>>
	| RequiredId<Static<typeof MemberResponseCommandSchema>>
	| RequiredId<Static<typeof MemberInterruptCommandSchema>>
	| RequiredId<Static<typeof MemberFollowUpCommandSchema>>
	| RequiredId<Static<typeof MemberRedirectCommandSchema>>
	| RequiredId<Static<typeof MemberInboxSendCommandSchema>>
	| RequiredId<Static<typeof CrewBroadcastCommandSchema>>
	| RequiredId<Static<typeof GuestJoinCommandSchema>>
	| RequiredId<Static<typeof GuestLeaveCommandSchema>>
	| RequiredId<Static<typeof GuestSendCommandSchema>>
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
