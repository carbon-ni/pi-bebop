import { Value } from "@sinclair/typebox/value";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { ExtractedMessageSchema, type ExtractedMessage } from "../messages.ts";
import { isMessagePayload, type MessagePayload } from "../message-payload.ts";
import type {
	PresenceHintParams,
	RpcRequest,
	RpcWireResponse,
	RpcCommand,
	RpcId,
	RpcInboundCommand,
} from "./protocol-types.ts";
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
export function isMemberUpdateNotification(value: unknown): value is Static<typeof MemberUpdateNotificationSchema> {
	return Value.Check(MemberUpdateNotificationSchema, value);
}
export interface CommandDefinition {
	readonly method: string;
	readonly requestSchema: TSchema;
	readonly resultSchema: TSchema;
	readonly toParams: (command: RpcCommand) => unknown;
	readonly fromParams: (params: unknown, id: RpcId) => RpcInboundCommand | ProtocolFailure;
}

export const invalidCommandParams = (message: string): ProtocolFailure => ({ code: RPC_ERROR.invalidParams, message });

/**
 * The single source of truth for the legacy command ↔ JSON-RPC mapping.
 * Each entry owns its wire schemas, result shape, and both mapping directions.
 */
