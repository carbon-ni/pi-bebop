import { Value } from "@sinclair/typebox/value";
import { isMessagePayload, type MessagePayload } from "../message-payload.ts";
import { isPresenceHintParams, invalidCommandParams, type CommandDefinition } from "./protocol-guards.ts";
import * as schemas from "./wire-schemas.ts";
const {
	MessageSendParamsSchema,
	SubscribeParamsSchema,
	MessageSendRequestSchema,
	InterruptParamsSchema,
	InterruptResultSchema,
	InterruptRequestSchema,
	SubscribeRequestSchema,
	StatusRequestSchema,
	GetMessageRequestSchema,
	ClearRequestSchema,
	AbortRequestSchema,
	PresenceHintResultSchema,
	MemberStatusParamsSchema,
	MemberStatusResultSchema,
	PresenceHintRequestSchema,
	MemberStatusRequestSchema,
	MemberStatusTargetParamsSchema,
	MemberStatusTargetRequestSchema,
	MemberFollowUpParamsSchema,
	MemberRedirectParamsSchema,
	MemberFollowUpRequestSchema,
	MemberRedirectRequestSchema,
	MemberRequestParamsSchema,
	MemberRequestRequestSchema,
	MemberRequestResultSchema,
	MemberRequestStartParamsSchema,
	MemberRequestStartRequestSchema,
	MemberRequestListParamsSchema,
	MemberRequestListRequestSchema,
	MemberRequestWaitParamsSchema,
	MemberRequestWaitRequestSchema,
	MemberResponseParamsSchema,
	MemberResponseRequestSchema,
	MemberInterruptParamsSchema,
	MemberInterruptRequestSchema,
	MemberInterruptResultSchema,
	MemberInboxSendParamsSchema,
	CrewBroadcastParamsSchema,
	MemberInboxSendRequestSchema,
	CrewBroadcastRequestSchema,
	GuestJoinParamsSchema,
	GuestJoinRpcRequestSchema,
	GuestJoinResultSchema,
	GuestLeaveParamsSchema,
	GuestSendParamsSchema,
	GuestSendResultSchema,
	GuestSendCommandSchema,
	GuestLeaveRequestSchema,
	MemberMessageResultSchema,
	MemberInboxSendResultSchema,
	CrewBroadcastResultSchema,
	MemberIdleWaitParamsSchema,
	MemberIdleWaitSubscribeResultSchema,
	MemberIdleWaitRequestSchema,
	StatusResultSchema,
	SendResultSchema,
	GetMessageResultSchema,
	ClearResultSchema,
	SubscribeResultSchema,
	EmptyResultSchema,
	MemberRequestListResultSchema,
	MemberRequestWaitResultSchema,
} = schemas;
import type * as ProtocolTypes from "./protocol-types.ts";

export const COMMAND_REGISTRY: Record<ProtocolTypes.RpcCommand["type"], CommandDefinition> = {
	send: {
		method: "message.send",
		requestSchema: MessageSendRequestSchema,
		resultSchema: SendResultSchema,
		toParams: (command) => {
			const send = command as ProtocolTypes.MessageSendCommand;
			return { ...send.payload, delivery: send.delivery ?? "follow_up" };
		},
		fromParams: (params, id) => {
			const rawParams = params && typeof params === "object" ? (params as Record<string, unknown>) : undefined;
			const payload = rawParams
				? {
						content: rawParams.content,
						...(rawParams.instructions === undefined ? {} : { instructions: rawParams.instructions }),
						...(rawParams.origin === undefined ? {} : { origin: rawParams.origin }),
						...(rawParams.kind === undefined ? {} : { kind: rawParams.kind }),
						...(rawParams.sentAt === undefined ? {} : { sentAt: rawParams.sentAt }),
						...(rawParams.replyTo === undefined ? {} : { replyTo: rawParams.replyTo }),
					}
				: undefined;
			if (!Value.Check(MessageSendParamsSchema, params) || !isMessagePayload(payload))
				return invalidCommandParams("Invalid message.send params");
			const validParams = params as ProtocolTypes.MessageSendParams;
			return {
				type: "send",
				payload: payload as MessagePayload,
				delivery: validParams.delivery ?? "follow_up",
				id,
			};
		},
	},
	interrupt: {
		method: "message.interrupt",
		requestSchema: InterruptRequestSchema,
		resultSchema: InterruptResultSchema,
		toParams: (command) => ({ payload: (command as ProtocolTypes.InterruptCommand).payload }),
		fromParams: (params, id) => {
			if (!Value.Check(InterruptParamsSchema, params))
				return invalidCommandParams("Invalid message.interrupt params");
			const payload = (params as ProtocolTypes.InterruptParams).payload;
			if (!isMessagePayload(payload)) return invalidCommandParams("Invalid message.interrupt payload");
			return { type: "interrupt", payload, id };
		},
	},
	member_status: {
		method: "member.status",
		requestSchema: MemberStatusRequestSchema,
		resultSchema: MemberStatusResultSchema,
		toParams: (command) => ({ member: (command as ProtocolTypes.MemberStatusCommand).member }),
		fromParams: (params, id) => {
			if (!Value.Check(MemberStatusParamsSchema, params))
				return invalidCommandParams("Invalid member.status params");
			return { type: "member_status", member: (params as ProtocolTypes.MemberStatusParams).member, id };
		},
	},
	member_status_target: {
		method: "member.status_target",
		requestSchema: MemberStatusTargetRequestSchema,
		resultSchema: MemberStatusResultSchema,
		toParams: (command) => ({ target: (command as ProtocolTypes.MemberStatusTargetCommand).target }),
		fromParams: (params, id) => {
			if (!Value.Check(MemberStatusTargetParamsSchema, params))
				return invalidCommandParams("Invalid member.status_target params");
			return {
				type: "member_status_target",
				target: (params as ProtocolTypes.MemberStatusTargetParams).target,
				id,
			};
		},
	},
	member_request: {
		method: "member.request",
		requestSchema: MemberRequestRequestSchema,
		resultSchema: MemberRequestResultSchema,
		toParams: (command) => {
			const request = command as ProtocolTypes.MemberRequestCommand;
			return { requestId: request.requestId, payload: request.payload, timeoutSeconds: request.timeoutSeconds };
		},
		fromParams: (params, id) => {
			if (!Value.Check(MemberRequestParamsSchema, params))
				return invalidCommandParams("Invalid member.request params");
			const requestParams = params as ProtocolTypes.MemberRequestParams;
			if (!isMessagePayload(requestParams.payload)) return invalidCommandParams("Invalid member.request payload");
			return { type: "member_request", ...requestParams, id };
		},
	},
	member_request_start: {
		method: "member.request_start",
		requestSchema: MemberRequestStartRequestSchema,
		resultSchema: MemberRequestResultSchema,
		toParams: (command) => {
			const request = command as ProtocolTypes.MemberRequestStartCommand;
			return {
				target: request.target,
				message: request.message,
				...(request.instructions === undefined ? {} : { instructions: request.instructions }),
				timeoutSeconds: request.timeoutSeconds,
				maxWaitSeconds: request.maxWaitSeconds,
			};
		},
		fromParams: (params, id) =>
			Value.Check(MemberRequestStartParamsSchema, params)
				? { type: "member_request_start", ...(params as ProtocolTypes.MemberRequestStartParams), id }
				: invalidCommandParams("Invalid member.request_start params"),
	},
	member_request_list: {
		method: "member.request_list",
		requestSchema: MemberRequestListRequestSchema,
		resultSchema: MemberRequestListResultSchema,
		toParams: (command) => ({ direction: (command as ProtocolTypes.MemberRequestListCommand).direction ?? "all" }),
		fromParams: (params, id) =>
			Value.Check(MemberRequestListParamsSchema, params)
				? { type: "member_request_list", ...(params as ProtocolTypes.MemberRequestListCommand), id }
				: invalidCommandParams("Invalid member.request_list params"),
	},
	member_request_wait: {
		method: "member.request_wait",
		requestSchema: MemberRequestWaitRequestSchema,
		resultSchema: MemberRequestWaitResultSchema,
		toParams: (command) => ({ requestId: (command as ProtocolTypes.MemberRequestWaitCommand).requestId }),
		fromParams: (params, id) =>
			Value.Check(MemberRequestWaitParamsSchema, params)
				? { type: "member_request_wait", ...(params as ProtocolTypes.MemberRequestWaitCommand), id }
				: invalidCommandParams("Invalid member.request_wait params"),
	},
	member_response: {
		method: "member.respond",
		requestSchema: MemberResponseRequestSchema,
		resultSchema: EmptyResultSchema,
		toParams: (command) => {
			const response = command as ProtocolTypes.MemberResponseCommand;
			return {
				requestId: response.requestId,
				message: response.message,
				...(response.instructions === undefined ? {} : { instructions: response.instructions }),
			};
		},
		fromParams: (params, id) => {
			if (!Value.Check(MemberResponseParamsSchema, params))
				return invalidCommandParams("Invalid member.respond params");
			return { type: "member_response", ...(params as ProtocolTypes.MemberResponseParams), id };
		},
	},
	member_interrupt: {
		method: "member.interrupt",
		requestSchema: MemberInterruptRequestSchema,
		resultSchema: MemberInterruptResultSchema,
		toParams: (command) => {
			const interrupt = command as ProtocolTypes.MemberInterruptCommand;
			return {
				target: interrupt.target,
				message: interrupt.message,
				...(interrupt.instructions === undefined ? {} : { instructions: interrupt.instructions }),
			};
		},
		fromParams: (params, id) => {
			if (!Value.Check(MemberInterruptParamsSchema, params))
				return invalidCommandParams("Invalid member.interrupt params");
			const interrupt = params as ProtocolTypes.MemberInterruptParams;
			return {
				type: "member_interrupt",
				target: interrupt.target,
				message: interrupt.message,
				...(interrupt.instructions === undefined ? {} : { instructions: interrupt.instructions }),
				id,
			};
		},
	},
	member_follow_up: {
		method: "member.follow_up",
		requestSchema: MemberFollowUpRequestSchema,
		resultSchema: MemberMessageResultSchema,
		toParams: (command) => {
			const followUp = command as ProtocolTypes.MemberFollowUpCommand;
			return {
				target: followUp.target,
				message: followUp.message,
				...(followUp.instructions === undefined ? {} : { instructions: followUp.instructions }),
			};
		},
		fromParams: (params, id) => {
			if (!Value.Check(MemberFollowUpParamsSchema, params))
				return invalidCommandParams("Invalid member.follow_up params");
			const delivery = params as ProtocolTypes.MemberFollowUpParams;
			return {
				type: "member_follow_up",
				target: delivery.target,
				message: delivery.message,
				...(delivery.instructions === undefined ? {} : { instructions: delivery.instructions }),
				id,
			};
		},
	},
	member_redirect: {
		method: "member.redirect",
		requestSchema: MemberRedirectRequestSchema,
		resultSchema: MemberMessageResultSchema,
		toParams: (command) => {
			const redirect = command as ProtocolTypes.MemberRedirectCommand;
			return {
				target: redirect.target,
				message: redirect.message,
				...(redirect.instructions === undefined ? {} : { instructions: redirect.instructions }),
			};
		},
		fromParams: (params, id) => {
			if (!Value.Check(MemberRedirectParamsSchema, params))
				return invalidCommandParams("Invalid member.redirect params");
			const delivery = params as ProtocolTypes.MemberRedirectParams;
			return {
				type: "member_redirect",
				target: delivery.target,
				message: delivery.message,
				...(delivery.instructions === undefined ? {} : { instructions: delivery.instructions }),
				id,
			};
		},
	},
	member_inbox_send: {
		method: "member.inbox_send",
		requestSchema: MemberInboxSendRequestSchema,
		resultSchema: MemberInboxSendResultSchema,
		toParams: (command) => {
			const delivery = command as ProtocolTypes.MemberInboxSendCommand;
			return {
				target: delivery.target,
				message: delivery.message,
				...(delivery.instructions === undefined ? {} : { instructions: delivery.instructions }),
			};
		},
		fromParams: (params, id) => {
			if (!Value.Check(MemberInboxSendParamsSchema, params))
				return invalidCommandParams("Invalid member.inbox_send params");
			const delivery = params as ProtocolTypes.MemberInboxSendParams;
			return {
				type: "member_inbox_send",
				target: delivery.target,
				message: delivery.message,
				...(delivery.instructions === undefined ? {} : { instructions: delivery.instructions }),
				id,
			};
		},
	},
	crew_broadcast: {
		method: "crew.broadcast",
		requestSchema: CrewBroadcastRequestSchema,
		resultSchema: CrewBroadcastResultSchema,
		toParams: (command) => {
			const broadcast = command as ProtocolTypes.CrewBroadcastCommand;
			return {
				message: broadcast.message,
				...(broadcast.instructions === undefined ? {} : { instructions: broadcast.instructions }),
			};
		},
		fromParams: (params, id) => {
			if (!Value.Check(CrewBroadcastParamsSchema, params))
				return invalidCommandParams("Invalid crew.broadcast params");
			const delivery = params as ProtocolTypes.CrewBroadcastParams;
			return {
				type: "crew_broadcast",
				message: delivery.message,
				...(delivery.instructions === undefined ? {} : { instructions: delivery.instructions }),
				id,
			};
		},
	},
	guest_join: {
		method: "guest.join",
		requestSchema: GuestJoinRpcRequestSchema,
		resultSchema: GuestJoinResultSchema,
		toParams: (command) => {
			const join = command as ProtocolTypes.GuestJoinCommand;
			return {
				guestIdentity: join.guestIdentity,
				guestName: join.guestName,
				callbackEndpoint: join.callbackEndpoint,
			};
		},
		fromParams: (params, id) => {
			if (!Value.Check(GuestJoinParamsSchema, params)) return invalidCommandParams("Invalid guest.join params");
			return { type: "guest_join", ...(params as ProtocolTypes.GuestJoinParams), id };
		},
	},
	guest_send: {
		method: "guest.send",
		requestSchema: GuestSendCommandSchema,
		resultSchema: GuestSendResultSchema,
		toParams: (command) => {
			const send = command as ProtocolTypes.GuestSendCommand;
			return {
				crewId: send.crewId,
				guestIdentity: send.guestIdentity,
				callbackEndpoint: send.callbackEndpoint,
				capability: send.capability,
				target: send.target,
				content: send.content,
				...(send.kind === undefined ? {} : { kind: send.kind }),
				...(send.instructions === undefined ? {} : { instructions: send.instructions }),
			};
		},
		fromParams: (params, id) => {
			if (!Value.Check(GuestSendParamsSchema, params)) return invalidCommandParams("Invalid guest.send params");
			return { type: "guest_send", ...(params as ProtocolTypes.GuestSendParams), id };
		},
	},
	guest_leave: {
		method: "guest.leave",
		requestSchema: GuestLeaveRequestSchema,
		resultSchema: EmptyResultSchema,
		toParams: (command) => {
			const leave = command as ProtocolTypes.GuestLeaveCommand;
			return {
				guestIdentity: leave.guestIdentity,
				crewId: leave.crewId,
				callbackEndpoint: leave.callbackEndpoint,
			};
		},
		fromParams: (params, id) => {
			if (!Value.Check(GuestLeaveParamsSchema, params)) return invalidCommandParams("Invalid guest.leave params");
			return { type: "guest_leave", ...(params as ProtocolTypes.GuestLeaveParams), id };
		},
	},
	member_idle_wait: {
		method: "member.idle_wait",
		requestSchema: MemberIdleWaitRequestSchema,
		resultSchema: MemberIdleWaitSubscribeResultSchema,
		toParams: (command) => {
			const wait = command as ProtocolTypes.MemberIdleWaitCommand;
			return {
				member: wait.member,
				...(wait.timeoutSeconds === undefined ? {} : { timeoutSeconds: wait.timeoutSeconds }),
			};
		},
		fromParams: (params, id) => {
			if (!Value.Check(MemberIdleWaitParamsSchema, params))
				return invalidCommandParams("Invalid member.idle_wait params");
			const waitParams = params as ProtocolTypes.MemberIdleWaitParams;
			return {
				type: "member_idle_wait",
				member: waitParams.member,
				...(waitParams.timeoutSeconds === undefined ? {} : { timeoutSeconds: waitParams.timeoutSeconds }),
				id,
			};
		},
	},
	subscribe: {
		method: "event.subscribe",
		requestSchema: SubscribeRequestSchema,
		resultSchema: SubscribeResultSchema,
		toParams: (command) => ({ event: (command as ProtocolTypes.SubscribeCommand).event }),
		fromParams: (params, id) =>
			Value.Check(SubscribeParamsSchema, params)
				? { type: "subscribe", event: "turn_end", id }
				: invalidCommandParams("Invalid event.subscribe params"),
	},
	status: {
		method: "session.status",
		requestSchema: StatusRequestSchema,
		resultSchema: StatusResultSchema,
		toParams: () => undefined,
		fromParams: (params, id) =>
			params === undefined ? { type: "status", id } : invalidCommandParams("Invalid session.status params"),
	},
	get_message: {
		method: "session.get_message",
		requestSchema: GetMessageRequestSchema,
		resultSchema: GetMessageResultSchema,
		toParams: () => undefined,
		fromParams: (params, id) =>
			params === undefined
				? { type: "get_message", id }
				: invalidCommandParams("Invalid session.get_message params"),
	},
	clear: {
		method: "session.clear",
		requestSchema: ClearRequestSchema,
		resultSchema: ClearResultSchema,
		toParams: () => undefined,
		fromParams: (params, id) =>
			params === undefined ? { type: "clear", id } : invalidCommandParams("Invalid session.clear params"),
	},
	abort: {
		method: "session.abort",
		requestSchema: AbortRequestSchema,
		resultSchema: EmptyResultSchema,
		toParams: () => undefined,
		fromParams: (params, id) =>
			params === undefined ? { type: "abort", id } : invalidCommandParams("Invalid session.abort params"),
	},
	presence_hint: {
		method: "presence.hint",
		requestSchema: PresenceHintRequestSchema,
		resultSchema: PresenceHintResultSchema,
		toParams: (command) => {
			const hint = command as ProtocolTypes.PresenceHintCommand;
			return { member: hint.member, state: hint.state, instanceId: hint.instanceId };
		},
		fromParams: (params, id) =>
			isPresenceHintParams(params)
				? ({ type: "presence_hint", ...params, id } as ProtocolTypes.RpcInboundCommand)
				: invalidCommandParams("Invalid presence.hint params"),
	},
};
