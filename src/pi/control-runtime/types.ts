import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MembershipRuntime } from "../../infra/membership-runtime.ts";
import type { GuestMembershipRuntime } from "../../infra/guest-membership-runtime.ts";
import type { GuestAdmissionRuntime } from "../../infra/guest-admission-runtime.ts";
import type { PresenceObserver } from "../../application/presence-observer.ts";
import type { MemberStatusTransport } from "../../infra/member-status-transport.ts";
import type { MemberMessageDependencies } from "../../application/member-message.ts";
import type { MemberInboxMessageDependencies } from "../../application/member-inbox-message.ts";
import type { MemberRequestFlow } from "../../application/member-request-flow.ts";
import type { RpcServer, RpcSocket } from "../../infra/rpc-server.ts";
import type { RpcInboundCommand, AcceptedLocalMessageWakeGate } from "../../domain/index.ts";
import type { sendRpcCommand } from "../../infra/rpc-client.ts";
import type { resolveMemberEndpoint } from "../../infra/socket-endpoint.ts";
export interface TurnEndSubscription {
	readonly socket: RpcSocket;
	readonly subscriptionId: string;
}
export interface IdleWaitSubscription {
	readonly socket: RpcSocket;
	readonly subscriptionId: string;
}
export interface SocketState {
	server: RpcServer | null;
	socketPath: string | null;
	context: ExtensionContext | null;
	aliases: string[];
	aliasTimer: ReturnType<typeof setInterval> | null;
	turnEndSubscriptions: TurnEndSubscription[];
	idleWaitSubscriptions: IdleWaitSubscription[];
	wakeGate: AcceptedLocalMessageWakeGate;
	membershipRuntime: MembershipRuntime | null;
	guestMembershipRuntime?: GuestMembershipRuntime;
	guestAdmissionRuntime?: GuestAdmissionRuntime;
	approvedGuestsResolver?: () => readonly { guestName: string; guestIdentity: string; callbackEndpoint: string }[];
	presenceObserver?: PresenceObserver;
	onInboxHint?: () => void;
	memberStatusTransport?: MemberStatusTransport;
	memberMessageDependencies?: MemberMessageDependencies;
	memberInboxMessageDependencies?: MemberInboxMessageDependencies;
	memberRequestFlow?: MemberRequestFlow;
	now?: () => number;
	memberInterruptSend?: typeof sendRpcCommand;
	memberInterruptResolveEndpoint?: typeof resolveMemberEndpoint;
}
export interface CommandHandlerContext {
	readonly pi: ExtensionAPI;
	readonly state: SocketState;
	readonly ctx: ExtensionContext;
	readonly socket: RpcSocket;
	readonly id: RpcInboundCommand["id"];
	readonly respond: (success: boolean, commandName: string, data?: unknown, error?: string) => void;
}
export type CommandType = RpcInboundCommand["type"];
export type CommandHandler<K extends CommandType> = (
	context: CommandHandlerContext,
	command: Extract<RpcInboundCommand, { type: K }>,
) => Promise<void>;
export type CommandHandlers = { [K in CommandType]: CommandHandler<K> };
