import { isMessagePayload, isSendResult, type RpcCommand, type RpcCommandResponse } from "../domain/index.ts";

export type CrewMember = { name: string; role: string; socketPath: string };
export type CrewMembership = { member: CrewMember; socketPath: string; manifest: { members: readonly CrewMember[] } };
export type MemberDeliveryIntent = "follow_up" | "immediate";
export type MemberMessageKind = "follow-up" | "broadcast";
export type MemberWaitFor = "accepted" | "response";

export interface MemberMessageRequest {
	readonly membership: CrewMembership | null;
	readonly member: string;
	readonly message: string;
	readonly intent?: MemberDeliveryIntent;
	/** Model-visible semantic kind; delivery intent remains Follow-up for broadcasts. */
	readonly kind?: MemberMessageKind;
	readonly waitFor?: MemberWaitFor;
	readonly signal?: AbortSignal;
	readonly instructions?: readonly string[];
	readonly sender?: { sessionId: string; sessionName?: string }; // callback routing only; never message origin
	/**
	 * Approved Guests of the joined crew (crew registry read at execute time).
	 * Enables Member->Guest addressing by unique Guest name; collisions with
	 * Member names are qualification errors, never guesses.
	 */
	readonly approvedGuests?: readonly {
		readonly guestName: string;
		readonly guestIdentity: string;
		readonly callbackEndpoint: string;
	}[];
}

/** Resolved message target: a crew Member (manifest) or an approved Guest (registry). */
export type MessageTarget =
	| { readonly kind: "member"; readonly name: string; readonly role: string; readonly socketPath: string }
	| {
			readonly kind: "guest";
			readonly guestName: string;
			readonly guestIdentity: string;
			readonly callbackEndpoint: string;
	  };
export interface MemberMessageTransport {
	send(
		endpoint: string,
		command: RpcCommand,
		options: { signal?: AbortSignal; classifyLostAck?: boolean },
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
	/** Source-owned send instant; callers cannot provide message timestamps. */
	readonly now?: () => number;
	/** Fresh crew-registry reader for approved-Guest recipient sets; optional. */
	readonly approvedGuests?: () => readonly { guestName: string; guestIdentity: string; callbackEndpoint: string }[];
}
export interface MemberMessageOutcome {
	readonly target: MessageTarget;
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

export type MemberMessageErrorCode =
	| "unknown-member"
	| "ambiguous-member"
	| "self-send"
	| "not-joined"
	| "response-wait-requires-member-request"
	| "invalid-payload"
	| "remote-rejected"
	| "invalid-ack"
	| "outcome-unknown";

export class MemberMessageError extends Error {
	readonly code: MemberMessageErrorCode;
	constructor(code: MemberMessageErrorCode, message: string) {
		super(message);
		this.name = "MemberMessageError";
		this.code = code;
	}
}

/** Shared exact-name/unique-role resolver used by accepted delivery and requests. */
export function resolveTarget(
	membership: CrewMembership,
	memberName: string,
	approvedGuests?: MemberMessageRequest["approvedGuests"],
): MessageTarget {
	const byName = membership.manifest.members.find((member) => member.name === memberName);
	const byRole = membership.manifest.members.filter((member) => member.role === memberName);
	const guest = approvedGuests?.find((candidate) => candidate.guestName === memberName);
	if (byName && guest)
		throw new MemberMessageError(
			"ambiguous-member",
			`"${memberName}" matches both a crew Member and an approved Guest; qualify the target`,
		);
	if (guest)
		return {
			kind: "guest",
			guestName: guest.guestName,
			guestIdentity: guest.guestIdentity,
			callbackEndpoint: guest.callbackEndpoint,
		};
	const target = byName ?? (byRole.length === 1 ? byRole[0] : undefined);
	if (!target) {
		if (byRole.length > 1) throw new MemberMessageError("ambiguous-member", `Ambiguous crew role: ${memberName}`);
		throw new MemberMessageError("unknown-member", `Unknown crew member: ${memberName}`);
	}
	if (target.name === membership.member.name || target.socketPath === membership.socketPath)
		throw new MemberMessageError("self-send", "Cannot send to yourself");
	return { kind: "member", name: target.name, role: target.role, socketPath: target.socketPath };
}

interface PreparedMemberDelivery {
	readonly target: MessageTarget;
	readonly endpoint: string;
	readonly intent: MemberDeliveryIntent;
	readonly signal?: AbortSignal;
	readonly command: RpcCommand;
}

function prepareMemberDelivery(request: MemberMessageRequest, now: () => number): PreparedMemberDelivery {
	if (!request.membership) throw new MemberMessageError("not-joined", "Not joined to a crew");
	const intent = request.intent ?? "follow_up";
	if (request.waitFor === "response")
		throw new MemberMessageError(
			"response-wait-requires-member-request",
			"wait_for=response is unavailable on ordinary member messages; use send_member_request for a correlated Response",
		);
	const target = resolveTarget(request.membership, request.member.trim(), request.approvedGuests);
	const endpoint = target.kind === "member" ? target.socketPath : target.callbackEndpoint;
	const origin = {
		kind: "crew" as const,
		name: request.membership.member.name,
		role: request.membership.member.role,
	};
	const payload = {
		content: request.message,
		...(request.instructions === undefined ? {} : { instructions: [...request.instructions] }),
		origin,
		kind: intent === "immediate" ? ("redirect" as const) : (request.kind ?? ("follow-up" as const)),
		sentAt: now(),
		...(request.sender === undefined ? {} : { replyTo: request.sender }),
	};
	if (!isMessagePayload(payload))
		throw new MemberMessageError("invalid-payload", "Invalid structured message payload");
	return {
		target,
		endpoint,
		intent,
		signal: request.signal,
		command: { type: "send", payload, delivery: intent },
	};
}

async function deliverMemberMessage(
	prepared: PreparedMemberDelivery,
	endpoint: string,
	transport: MemberMessageTransport,
): Promise<MemberMessageOutcome> {
	let result: { response: RpcCommandResponse };
	try {
		result = await transport.send(endpoint, prepared.command, {
			signal: prepared.signal,
			classifyLostAck: true,
		});
	} catch (error) {
		const code = error instanceof Error && "code" in error ? (error as Error & { code?: unknown }).code : undefined;
		if (code === "outcome-unknown")
			throw new MemberMessageError(
				"outcome-unknown",
				"Delivery outcome unknown: the target may have accepted the message but the acknowledgement was lost",
			);
		throw error;
	}
	if (!result.response.success)
		throw new MemberMessageError("remote-rejected", result.response.error ?? "Member rejected message");
	if (!isSendResult(result.response.data))
		throw new MemberMessageError("invalid-ack", "Member returned an invalid delivery acknowledgement");
	return {
		target: prepared.target,
		deliveryId: result.response.data.deliveryId,
		disposition: result.response.data.disposition,
	};
}

async function orderMemberDelivery(
	prepared: PreparedMemberDelivery,
	endpoint: string,
	dependencies: MemberMessageDependencies,
): Promise<MemberMessageOutcome> {
	const deliver = () => deliverMemberMessage(prepared, endpoint, dependencies.transport);
	if (prepared.intent === "immediate") return deliver();
	return dependencies.coordinator.enqueue(endpoint, deliver, prepared.signal);
}

export async function sendMemberMessage(
	request: MemberMessageRequest,
	dependencies: MemberMessageDependencies,
): Promise<MemberMessageOutcome> {
	const prepared = prepareMemberDelivery(request, dependencies.now ?? Date.now);
	const endpoint = await dependencies.resolveEndpoint(prepared.endpoint);
	return orderMemberDelivery(prepared, endpoint, dependencies);
}
