import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ExtractedMessageSchema, type ExtractedMessage } from "./messages.ts";
import { MessageOriginSchema, MessagePayloadSchema, isMessagePayload, type MessagePayload } from "./message-payload.ts";

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

export const MessageSendRequestSchema = Type.Object(
	{
		jsonrpc: Type.Literal(JSON_RPC_VERSION),
		id: RpcIdSchema,
		method: Type.Literal("message.send"),
		params: MessageSendParamsSchema,
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
export const KnownRequestSchema = Type.Union([
	MessageSendRequestSchema,
	SubscribeRequestSchema,
	StatusRequestSchema,
	GetMessageRequestSchema,
	ClearRequestSchema,
	AbortRequestSchema,
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
	GetMessageResultSchema,
	ClearResultSchema,
	SubscribeResultSchema,
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
export type SubscribeRequest = Static<typeof SubscribeRequestSchema>;
export type StatusRequest = Static<typeof StatusRequestSchema>;
export type GetMessageRequest = Static<typeof GetMessageRequestSchema>;
export type ClearRequest = Static<typeof ClearRequestSchema>;
export type AbortRequest = Static<typeof AbortRequestSchema>;
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
export type RpcNotification = Static<typeof TurnEndNotificationSchema>;
export type RpcCommand =
	| Static<typeof MessageSendCommandSchema>
	| Static<typeof SubscribeCommandSchema>
	| Static<typeof StatusCommandSchema>
	| Static<typeof GetMessageCommandSchema>
	| Static<typeof ClearCommandSchema>
	| Static<typeof AbortCommandSchema>;
type RequiredId<T extends { id?: RpcId }> = Omit<T, "id"> & { id: RpcId };
export type RpcInboundCommand =
	| RequiredId<Static<typeof MessageSendCommandSchema>>
	| RequiredId<Static<typeof SubscribeCommandSchema>>
	| RequiredId<Static<typeof StatusCommandSchema>>
	| RequiredId<Static<typeof GetMessageCommandSchema>>
	| RequiredId<Static<typeof ClearCommandSchema>>
	| RequiredId<Static<typeof AbortCommandSchema>>;
export type MessageSendCommand = Static<typeof MessageSendCommandSchema>;
export type SubscribeCommand = Static<typeof SubscribeCommandSchema>;
export type StatusCommand = Static<typeof StatusCommandSchema>;
export type GetMessageCommand = Static<typeof GetMessageCommandSchema>;
export type ClearCommand = Static<typeof ClearCommandSchema>;
export type AbortCommand = Static<typeof AbortCommandSchema>;
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
export function isRpcRequest(value: unknown): value is RpcRequest {
	return Value.Check(RpcRequestSchema, value);
}
export function isRpcResponse(value: unknown): value is RpcWireResponse {
	return Value.Check(RpcResponseSchema, value);
}
export function isTurnEndNotification(value: unknown): value is RpcNotification {
	return Value.Check(TurnEndNotificationSchema, value);
}
export function methodResultSchema(method: string) {
	return method === "session.status"
		? StatusResultSchema
		: method === "message.send"
			? SendResultSchema
			: method === "session.get_message"
				? GetMessageResultSchema
				: method === "session.clear"
					? ClearResultSchema
					: method === "session.abort"
						? EmptyResultSchema
						: method === "event.subscribe"
							? SubscribeResultSchema
							: undefined;
}
export function isMethodResult(method: string, value: unknown): value is RpcMethodResult {
	const schema = methodResultSchema(method);
	return schema ? Value.Check(schema, value) : false;
}
export function isSendResult(value: unknown): value is SendResult {
	return Value.Check(SendResultSchema, value);
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
	if (!Value.Check(RpcResponseSchema, value) && !Value.Check(TurnEndNotificationSchema, value))
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
	if (command.type === "subscribe")
		return { jsonrpc: JSON_RPC_VERSION, id, method: "event.subscribe", params: { event: command.event } };
	if (command.type === "status") return { jsonrpc: JSON_RPC_VERSION, id, method: "session.status" };
	if (command.type === "get_message") return { jsonrpc: JSON_RPC_VERSION, id, method: "session.get_message" };
	if (command.type === "clear") return { jsonrpc: JSON_RPC_VERSION, id, method: "session.clear" };
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
