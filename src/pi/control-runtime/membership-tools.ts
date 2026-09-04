import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { getSocketPath } from "../../infra/intray-paths.ts";
import {
	createAliasSymlink,
	ensureControlDir,
	getAliasNames,
	removeAliasesForSocket,
	removeSocket,
} from "../../infra/control-store.ts";
import { getCurrentGitBranch, getGitProjectName } from "../../infra/git-branch.ts";
import {
	isMessagePayload,
	isInterruptResult,
	renderMemberRequestModelContent,
	renderFollowUpModelContent,
	createInterruptRecoveryPayload,
	resolveInterruptTarget,
	type MemberInterruptRequest,
} from "../../domain/index.ts";
import {
	AcceptedLocalMessageWakeGate,
	createMemberIdleWaitResult,
	createOnlineMemberStatus,
	MAX_MEMBER_IDLE_WAIT_SUBSCRIPTIONS,
	tryAcquireIdleWaitSubscription,
	type MemberStatus,
} from "../../domain/index.ts";
import {
	closeRpcServer,
	createRpcServer,
	writeEvent,
	writeMemberIdleWaitEvent,
	writeResponse,
	type RpcServer,
	type RpcSocket,
} from "../../infra/rpc-server.ts";
import { updateProcessSessionEnv } from "../../infra/session-env.ts";
import {
	createProjectBranchAlias,
	createSequentialProjectBranchAlias,
	getFirstEntryId,
	getLastAssistantMessage,
	isInboxHint,
	isSafeAlias,
	type RpcInboundCommand,
	type RpcCommand,
	SESSION_MESSAGE_TYPE,
} from "../../domain/index.ts";
import type { Membership, MembershipRuntime } from "../../infra/membership-runtime.ts";
import type { GuestMembershipRuntime } from "../../infra/guest-membership-runtime.ts";
import type { GuestAdmissionRuntime } from "../../infra/guest-admission-runtime.ts";
import type { PresenceObserver } from "../../application/presence-observer.ts";
import { createInterruptFlow } from "../../application/interrupt-flow.ts";
import {
	createMemberStatusFlow,
	MemberStatusFlowError,
	type MemberStatusSurface,
} from "../../application/member-status-flow.ts";
import { createMemberStatusTransport, type MemberStatusTransport } from "../../infra/member-status-transport.ts";
import {
	createMemberMessageCoordinator,
	sendMemberMessage,
	MemberMessageError,
	type MemberMessageDependencies,
} from "../../application/member-message.ts";
import { sendRpcCommand } from "../../infra/rpc-client.ts";
import { resolveMemberEndpoint } from "../../infra/socket-endpoint.ts";
import {
	enqueueMemberInboxMessage,
	MemberInboxMessageError,
	type MemberInboxMessageDependencies,
} from "../../application/member-inbox-message.ts";
import { submitCrewBroadcast, CrewBroadcastApplicationError } from "../../application/crew-broadcast.ts";
import { openTrustedMemberInboxStore } from "../../infra/member-inbox-store.ts";
import { MemberRequestFlow } from "../../application/member-request-flow.ts";
import { writeMemberUpdateEvent } from "../../infra/rpc-server.ts";

import type { SocketState, CommandHandlerContext, CommandHandlers } from "./types.ts";
export const MEMBERSHIP_TOOLS = [
	"send_follow_up",
	"redirect_member",
	"send_to_inbox",
	"broadcast_to_crew",
	"interrupt_member",
	"get_member_status",
	"wait_for_member_idle",
	"send_member_request",
	"respond_to_member_request",
	"wait_for_request_outcome",
] as const;

/**
 * Joined active set is the full post-0045 public surface: all five membership
 * tools, `interrupt_member` included (it is a shipped public tool, not a
 * hidden surface). Registered set and joined active set are identical.
 */
export function activateMembershipTool(pi: ExtensionAPI): void {
	reconcileMembershipTools(pi, true);
}

export function deactivateMembershipTool(pi: ExtensionAPI): void {
	reconcileMembershipTools(pi, false);
}

/**
 * Deterministically reconcile the active tool set against membership.
 *
 * Membership tools stay registered (getAllTools) but must not appear in the
 * provider-active schema (getActiveTools) while unjoined. Pi auto-activates
 * newly registered extension tools, so unjoined lifecycles (fresh load, new
 * unjoined session, server-only startup, restore failure) must explicitly
 * remove them, while join/restore adds them back. Unrelated tools are
 * preserved in order and membership; the call is idempotent.
 */
export function reconcileMembershipTools(pi: ExtensionAPI, active: boolean): void {
	const current = pi.getActiveTools();
	const withoutMembership = current.filter(
		(name) => !MEMBERSHIP_TOOLS.some((membershipTool) => membershipTool === name),
	);
	const next = active ? [...withoutMembership, ...MEMBERSHIP_TOOLS] : withoutMembership;
	if (next.length === current.length && next.every((name, index) => name === current[index])) return;
	pi.setActiveTools(next);
}
