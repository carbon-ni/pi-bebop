import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const JSON_RPC_VERSION = "2.0" as const;
export const RpcIdSchema = Type.Union([Type.String({ minLength: 1 }), Type.Integer()]);
export const MessageSendParamsSchema = Type.Object({ message: Type.String({ minLength: 1, maxLength: 1_000_000 }), mode: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("follow_up")])), }, { additionalProperties: false });
export const SubscribeParamsSchema = Type.Object({ event: Type.Literal("turn_end") }, { additionalProperties: false });
export const RpcRequestSchema = Type.Object({ jsonrpc: Type.Literal(JSON_RPC_VERSION), id: RpcIdSchema, method: Type.String({ minLength: 1 }), params: Type.Optional(Type.Unknown()) }, { additionalProperties: false });
export const RpcErrorSchema = Type.Object({ code: Type.Integer(), message: Type.String(), data: Type.Optional(Type.Unknown()) }, { additionalProperties: false });
export const ResponseIdSchema = Type.Union([RpcIdSchema, Type.Null()]);
export const StatusResultSchema = Type.Object({ status: Type.Union([Type.Literal("stopped"), Type.Literal("online"), Type.Literal("joined")]) }, { additionalProperties: false });
export const SendResultSchema = Type.Object({ delivered: Type.Literal(true), mode: Type.Optional(Type.Union([Type.Literal("direct"), Type.Literal("steer"), Type.Literal("follow_up")])) }, { additionalProperties: false });
export const GetMessageResultSchema = Type.Object({ message: Type.Optional(Type.Unknown()) }, { additionalProperties: false });
export const ClearResultSchema = Type.Object({ cleared: Type.Literal(true), alreadyAtRoot: Type.Optional(Type.Boolean()), targetId: Type.Optional(Type.String()) }, { additionalProperties: false });
export const SubscribeResultSchema = Type.Object({ subscriptionId: Type.String({ minLength: 1 }), event: Type.Literal("turn_end") }, { additionalProperties: false });
export const EmptyResultSchema = Type.Object({}, { additionalProperties: false });
export const RpcResponseSchema = Type.Object({ jsonrpc: Type.Literal(JSON_RPC_VERSION), id: ResponseIdSchema, result: Type.Optional(Type.Unknown()), error: Type.Optional(RpcErrorSchema) }, { additionalProperties: false });
export const TurnEndNotificationSchema = Type.Object({ jsonrpc: Type.Literal(JSON_RPC_VERSION), method: Type.Literal("session.turn_end"), params: Type.Object({ subscriptionId: Type.String({ minLength: 1 }), message: Type.Optional(Type.Unknown()), turnIndex: Type.Optional(Type.Integer()) }, { additionalProperties: false }) }, { additionalProperties: false });

export type RpcId = Static<typeof RpcIdSchema>;
export type RpcRequest = Static<typeof RpcRequestSchema>;
export type RpcError = Static<typeof RpcErrorSchema>;
export type RpcWireResponse = Static<typeof RpcResponseSchema>;
export type RpcMethodResult = Static<typeof StatusResultSchema> | Static<typeof SendResultSchema> | Static<typeof GetMessageResultSchema> | Static<typeof ClearResultSchema> | Static<typeof SubscribeResultSchema> | Static<typeof EmptyResultSchema>;
export type RpcNotification = Static<typeof TurnEndNotificationSchema>;

export const RPC_ERROR = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603 } as const;

export interface RpcCommandResponse { type: "response"; command: string; success: boolean; error?: string; data?: unknown; id?: RpcId; }
export interface RpcTurnEndNotification { type: "event"; event: "turn_end"; data?: { message?: unknown; turnIndex?: number }; subscriptionId?: string; }
export interface RpcSendCommand { type: "send"; message: string; mode?: "steer" | "follow_up"; id?: RpcId; }
export interface RpcGetMessageCommand { type: "get_message"; id?: RpcId; }
export interface RpcClearCommand { type: "clear"; id?: RpcId; }
export interface RpcAbortCommand { type: "abort"; id?: RpcId; }
export interface RpcSubscribeCommand { type: "subscribe"; event: "turn_end"; id?: RpcId; }
export interface RpcStatusCommand { type: "status"; id?: RpcId; }
export type RpcCommand = RpcSendCommand | RpcGetMessageCommand | RpcClearCommand | RpcAbortCommand | RpcSubscribeCommand | RpcStatusCommand;

export interface ProtocolFailure { code: number; message: string; data?: { code?: string }; }
export function isRpcRequest(value: unknown): value is RpcRequest { return Value.Check(RpcRequestSchema, value); }
export function isRpcResponse(value: unknown): value is RpcWireResponse { return Value.Check(RpcResponseSchema, value) && (Object.hasOwn(value, "result") !== Object.hasOwn(value, "error")); }
export function isTurnEndNotification(value: unknown): value is RpcNotification { return Value.Check(TurnEndNotificationSchema, value); }
export function isMethodResult(method: string, value: unknown): boolean {
	const schema = method === "session.status" ? StatusResultSchema : method === "message.send" ? SendResultSchema : method === "session.get_message" ? GetMessageResultSchema : method === "session.clear" ? ClearResultSchema : method === "session.abort" ? EmptyResultSchema : method === "event.subscribe" ? SubscribeResultSchema : undefined;
	return schema ? Value.Check(schema, value) : false;
}

export function commandToRequest(command: RpcCommand, id: RpcId): RpcRequest {
	const map: Record<RpcCommand["type"], string> = { send: "message.send", get_message: "session.get_message", clear: "session.clear", abort: "session.abort", subscribe: "event.subscribe", status: "session.status" };
	const { type, id: _ignored, ...params } = command as RpcCommand & { id?: RpcId };
	return { jsonrpc: JSON_RPC_VERSION, id, method: map[type], ...(Object.keys(params).length > 0 ? { params } : {}) };
}

export function requestToCommand(request: RpcRequest): RpcCommand | ProtocolFailure {
	const params = request.params;
	const invalid = (message: string): ProtocolFailure => ({ code: RPC_ERROR.invalidParams, message });
	if (request.method === "message.send") {
		if (!Value.Check(MessageSendParamsSchema, params)) return invalid("Invalid message.send params");
		return { type: "send", message: params.message, mode: params.mode, id: request.id };
	}
	const noParams = ["session.status", "session.get_message", "session.clear", "session.abort"];
	if (noParams.includes(request.method)) {
		if (params !== undefined) return invalid(`Invalid ${request.method} params`);
		const type = request.method.slice("session.".length) as "status" | "get_message" | "clear" | "abort";
		return { type, id: request.id } as RpcCommand;
	}
	if (request.method === "event.subscribe") {
		if (!Value.Check(SubscribeParamsSchema, params)) return invalid("Invalid event.subscribe params");
		return { type: "subscribe", event: "turn_end", id: request.id };
	}
	return { code: RPC_ERROR.methodNotFound, message: `Method not found: ${request.method}`, data: { code: "method-not-found" } };
}

export function parseRequest(line: string): { request?: RpcRequest; error?: ProtocolFailure } {
	let value: unknown;
	try { value = JSON.parse(line); } catch { return { error: { code: RPC_ERROR.parse, message: "Parse error" } }; }
	if (!isRpcRequest(value)) return { error: { code: RPC_ERROR.invalidRequest, message: "Invalid Request" } };
	return { request: value };
}
