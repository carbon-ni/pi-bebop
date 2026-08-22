import { isMessagePayload, isSendResult, type RpcCommand, type RpcCommandResponse } from "../domain/index.ts";

type CrewMember = { name: string; role: string; socketPath: string };
type CrewMembership = { member: CrewMember; socketPath: string; manifest: { members: readonly CrewMember[] } };
export type MemberDeliveryIntent = "follow_up" | "immediate";
export type MemberWaitFor = "accepted" | "response";

export interface MemberMessageRequest {
	readonly membership: CrewMembership | null;
	readonly member: string;
	readonly message: string;
	readonly intent?: MemberDeliveryIntent;
	readonly waitFor?: MemberWaitFor;
	readonly signal?: AbortSignal;
	readonly instructions?: readonly string[];
	readonly sender?: { sessionId: string; sessionName?: string }; // callback routing only; never message origin
}
export interface MemberMessageTransport {
	send(
		endpoint: string,
		command: RpcCommand,
		options: { signal?: AbortSignal },
	): Promise<{ response: RpcCommandResponse }>;
}
export interface MemberMessageCoordinator {
	enqueue<T>(key: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
	/** Read-only diagnostic seam for deterministic lifecycle tests. */
	pendingKeyCount(): number;
}
export interface MemberMessageDependencies {
	readonly transport: MemberMessageTransport;
	readonly resolveEndpoint: (socketPath: string) => Promise<string>;
	readonly coordinator: MemberMessageCoordinator;
}
export interface MemberMessageOutcome {
	readonly target: CrewMember;
	readonly deliveryId: string;
	readonly disposition: "direct" | "queued" | "steered";
}

class EndpointQueueCoordinator implements MemberMessageCoordinator {
	private readonly tails = new Map<string, Promise<void>>();

	pendingKeyCount(): number {
		return this.tails.size;
	}

	enqueue<T>(key: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const previous = this.tails.get(key) ?? Promise.resolve();
		const run = async () => {
			if (signal?.aborted) throw Object.assign(new Error("Operation aborted"), { name: "AbortError" });
			return operation();
		};
		const current = previous.catch(() => undefined).then(run);
		const tail = current.then(
			() => undefined,
			() => undefined,
		);
		this.tails.set(key, tail);
		void tail.then(() => {
			if (this.tails.get(key) === tail) this.tails.delete(key);
		});
		return current;
	}
}

export function createMemberMessageCoordinator(): MemberMessageCoordinator {
	return new EndpointQueueCoordinator();
}

export class MemberMessageError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "MemberMessageError";
		this.code = code;
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
	dependencies: MemberMessageDependencies,
): Promise<MemberMessageOutcome> {
	if (!request.membership) throw new MemberMessageError("not-joined", "Not joined to a crew");
	const intent = request.intent ?? "follow_up";
	if (request.waitFor === "response")
		throw new MemberMessageError(
			"response-correlation-unsupported",
			"wait_for=response is unavailable: Pi turn events cannot prove delivery-level response correlation",
		);
	const target = resolveTarget(request.membership, request.member.trim());
	const endpoint = await dependencies.resolveEndpoint(target.socketPath);
	const origin = {
		kind: "crew" as const,
		name: request.membership.member.name,
		role: request.membership.member.role,
	};
	const payload = {
		content: request.message,
		...(request.instructions === undefined ? {} : { instructions: [...request.instructions] }),
		origin,
	};
	if (!isMessagePayload(payload))
		throw new MemberMessageError("invalid-payload", "Invalid structured message payload");
	const command: RpcCommand = {
		type: "send",
		message: payload.content,
		...(payload.instructions === undefined ? {} : { instructions: payload.instructions }),
		origin: payload.origin,
		mode: intent === "immediate" ? "steer" : "follow_up",
	};
	const deliver = async (): Promise<MemberMessageOutcome> => {
		const result = await dependencies.transport.send(endpoint, command, { signal: request.signal });
		if (!result.response.success)
			throw new MemberMessageError("remote-rejected", result.response.error ?? "Member rejected message");
		if (!isSendResult(result.response.data))
			throw new MemberMessageError("invalid-ack", "Member returned an invalid delivery acknowledgement");
		return { target, deliveryId: result.response.data.deliveryId, disposition: result.response.data.disposition };
	};
	if (intent === "immediate") return deliver();
	return dependencies.coordinator.enqueue(endpoint, deliver, request.signal);
}
