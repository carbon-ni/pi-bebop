import { Value } from "@sinclair/typebox/value";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { ExtractedMessageSchema, type ExtractedMessage } from "../messages.ts";
import { isMessagePayload, type MessagePayload } from "../message-payload.ts";
import { COMMAND_REGISTRY } from "./command-registry.ts";
import {
	isRpcRequest,
	isTurnEndNotification,
	isMemberUpdateNotification,
	type CommandDefinition,
	type ProtocolFailure,
} from "./protocol-guards.ts";
import type {
	RpcId,
	RpcMethodResult,
	RpcWireResponse,
	RpcNotification,
	RpcRequest,
	RpcCommand,
	RpcInboundCommand,
	MemberChannelUpdate,
	SendResult,
	InterruptResult,
	MemberStatusResult,
	MemberRequestResult,
	GuestJoinResult,
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

function commandDefinitionForMethod(method: string): CommandDefinition | undefined {
	return Object.values(COMMAND_REGISTRY).find((definition) => definition.method === method);
}

export function methodResultSchema(method: string) {
	return commandDefinitionForMethod(method)?.resultSchema;
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
export function isMemberRequestResult(value: unknown): value is MemberRequestResult {
	return Value.Check(MemberRequestResultSchema, value);
}
export function isGuestJoinResult(value: unknown): value is GuestJoinResult {
	return Value.Check(GuestJoinResultSchema, value);
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
export function buildMemberUpdateNotification(update: MemberChannelUpdate): RpcNotification {
	const value: RpcNotification = { jsonrpc: JSON_RPC_VERSION, method: "member.update", params: update };
	if (!isMemberUpdateNotification(value)) throw new Error("Invalid member update notification");
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
		!Value.Check(MemberIdleWaitNotificationSchema, value) &&
		!Value.Check(MemberUpdateNotificationSchema, value)
	)
		throw new Error("Invalid JSON-RPC message");
	return `${JSON.stringify(value)}\n`;
}
export function commandToRequest(command: RpcCommand, id: RpcId): RpcRequest {
	const definition = COMMAND_REGISTRY[command.type];
	const params = definition.toParams(command);
	return {
		jsonrpc: JSON_RPC_VERSION,
		id,
		method: definition.method,
		...(params === undefined ? {} : { params }),
	} as RpcRequest;
}
export function requestToCommand(request: RpcRequest): RpcInboundCommand | ProtocolFailure {
	const definition = commandDefinitionForMethod(request.method);
	if (!definition)
		return {
			code: RPC_ERROR.methodNotFound,
			message: `Method not found: ${request.method}`,
			data: { code: "method-not-found" },
		};
	return definition.fromParams("params" in request ? request.params : undefined, request.id);
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
