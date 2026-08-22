import { promises as fs } from "node:fs";
import * as path from "node:path";
import { appendSenderMetadata, isSendResult, type RpcCommand } from "../domain/index.ts";
import { sendRpcCommand } from "../infra/rpc-client.ts";

type CrewMember = { name: string; role: string; socketPath: string };
type CrewMembership = { member: CrewMember; socketPath: string; manifest: { members: readonly CrewMember[] } };
export type MemberDeliveryIntent = "follow_up" | "immediate";
export type MemberWaitFor = "accepted" | "response";

export interface MemberMessageRequest {
	readonly membership: CrewMembership | null;
	readonly member: string;
	readonly message: string;
	readonly intent: MemberDeliveryIntent;
	readonly waitFor?: MemberWaitFor;
	readonly signal?: AbortSignal;
	readonly sender?: { sessionId: string; sessionName?: string };
}
export interface MemberMessageDependencies {
	readonly sendRpcCommand?: typeof sendRpcCommand;
	readonly resolveEndpoint?: (socketPath: string) => Promise<string>;
}
export interface MemberMessageOutcome {
	readonly target: CrewMember;
	readonly deliveryId: string;
	readonly disposition: "direct" | "queued" | "steered";
}

const followUpQueues = new Map<string, Promise<void>>();

export class MemberMessageError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "MemberMessageError";
		this.code = code;
	}
}

async function resolveMemberEndpoint(socketPath: string): Promise<string> {
	try {
		const target = await fs.readlink(socketPath);
		return path.resolve(path.dirname(socketPath), target);
	} catch {
		return socketPath;
	}
}

function resolveTarget(membership: CrewMembership, memberName: string): CrewMember {
	const byName = membership.manifest.members.find((member) => member.name === memberName);
	const byRole = membership.manifest.members.filter((member) => member.role === memberName);
	const target = byName ?? (byRole.length === 1 ? byRole[0] : undefined);
	if (!target) {
		if (byRole.length > 1) throw new MemberMessageError("ambiguous-member", `Ambiguous crew role: ${memberName}`);
		throw new MemberMessageError("unknown-member", `Unknown crew member: ${memberName}`);
	}
	if (target.name === membership.member.name || target.socketPath === membership.socketPath)
		throw new MemberMessageError("self-send", "Cannot send to yourself");
	return target;
}

export async function sendMemberMessage(
	request: MemberMessageRequest,
	dependencies: MemberMessageDependencies = {},
): Promise<MemberMessageOutcome> {
	if (!request.membership) throw new MemberMessageError("not-joined", "Not joined to a crew");
	if (request.waitFor === "response")
		throw new MemberMessageError(
			"response-correlation-unsupported",
			"wait_for=response is unavailable: Pi turn events cannot prove delivery-level response correlation",
		);
	const target = resolveTarget(request.membership, request.member.trim());
	const sendRpc = dependencies.sendRpcCommand ?? sendRpcCommand;
	const resolveEndpoint = dependencies.resolveEndpoint ?? resolveMemberEndpoint;
	const endpoint = await resolveEndpoint(target.socketPath);
	const command: RpcCommand = {
		type: "send",
		message: appendSenderMetadata(request.message, request.sender ?? null),
		mode: request.intent === "immediate" ? "steer" : "follow_up",
	};
	const deliver = async (): Promise<MemberMessageOutcome> => {
		const result = await sendRpc(endpoint, command, { signal: request.signal });
		if (!result.response.success)
			throw new MemberMessageError("remote-rejected", result.response.error ?? "Member rejected message");
		if (!isSendResult(result.response.data))
			throw new MemberMessageError("invalid-ack", "Member returned an invalid delivery acknowledgement");
		return { target, deliveryId: result.response.data.deliveryId, disposition: result.response.data.disposition };
	};
	if (request.intent === "immediate") return deliver();
	const previous = followUpQueues.get(endpoint) ?? Promise.resolve();
	const current = previous.catch(() => undefined).then(deliver);
	followUpQueues.set(
		endpoint,
		current.then(
			() => undefined,
			() => undefined,
		),
	);
	return current;
}
