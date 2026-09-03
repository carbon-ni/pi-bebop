export const MAX_MEMBER_REQUEST_OUTBOUND = 8;
export const MAX_MEMBER_REQUEST_INBOUND = 8;
export const MAX_MEMBER_REQUEST_BUFFERED = 64;
export const MAX_REQUEST_ID_BYTES = 128;
export const MAX_REQUEST_OUTCOME_TOMBSTONES = 64;
/** TASK-0080: fixed delivery/acceptance deadline for the request channel (exported). */
export const MEMBER_REQUEST_ACCEPT_DEADLINE_MS = 5000;
/** TASK-0080: post-idle Response grace, 1..600, default 120. */
export const DEFAULT_MEMBER_REQUEST_TIMEOUT_SECONDS = 120;
export const MAX_MEMBER_REQUEST_TIMEOUT_SECONDS = 600;
/** TASK-0080: absolute accepted-request safety, 60..7200 and strictly greater than grace. */
export const DEFAULT_MEMBER_REQUEST_MAX_WAIT_SECONDS = 1800;
export const MIN_MEMBER_REQUEST_MAX_WAIT_SECONDS = 60;
export const MAX_MEMBER_REQUEST_MAX_WAIT_SECONDS = 7200;

export type RequestOutcomeFailureCode =
	| "outbound-capacity"
	| "inbound-capacity"
	| "buffer-capacity"
	| "invalid-request-id"
	| "invalid-timeout"
	| "invalid-max-wait"
	| "duplicate-request"
	| "no-pending-request"
	| "ambiguous-request"
	| "unknown-request"
	| "already-terminal"
	| "response-expired";

export interface MemberRequestMember {
	readonly name: string;
	readonly role: string;
}

export interface RequestOutcomeResponse {
	readonly kind: "response";
	readonly requestId: string;
	readonly member: MemberRequestMember;
	readonly message: string;
	readonly instructions: readonly string[];
}
export interface RequestOutcomeOffline {
	readonly kind: "offline";
	readonly requestId: string;
	readonly member: MemberRequestMember;
}
export interface RequestOutcomeTimeout {
	readonly kind: "timeout";
	readonly requestId: string;
	readonly member: MemberRequestMember;
	/** TASK-0080: max-wait = hard safety from accepted; response-after-idle = post-idle grace. */
	readonly reason: "max-wait" | "response-after-idle";
}
export type RequestOutcome = RequestOutcomeResponse | RequestOutcomeOffline | RequestOutcomeTimeout;

export function formatRequestOutcome(outcome: RequestOutcome): string {
	const member = `${outcome.member.name} (${outcome.member.role})`;
	if (outcome.kind === "response") {
		const instructions = outcome.instructions.length
			? `\nInstructions:\n${outcome.instructions.map((item, index) => `${index + 1}. ${item}`).join("\n")}`
			: "";
		return `Response received from ${member} for request ${outcome.requestId}: ${outcome.message}${instructions}`;
	}
	if (outcome.kind === "offline")
		return `Member ${member} is offline for request ${outcome.requestId}. Recovery: consider reassigning or using send_to_inbox for durable delivery.`;
	if (outcome.reason === "response-after-idle")
		return `Member ${member} settled without a Response for request ${outcome.requestId}. Recovery: if an answer is still required, send a new send_member_request.`;
	return `No Response arrived before the safety deadline for request ${outcome.requestId}. Recovery: consider checking Member Status, reassigning, using send_to_inbox, or using redirect_member when urgent.`;
}

/** Mechanical terminal union (no idle-without-response since TASK-0080). */
export type RequestOutcomeMechanical = RequestOutcomeOffline | RequestOutcomeTimeout;

export interface MemberRequestOutbound {
	readonly requestId: string;
	readonly member: MemberRequestMember;
	readonly deadlineAt: number;
	readonly accepted: boolean;
	readonly idleArmed: boolean;
	readonly timeoutSeconds: number;
	readonly maxWaitSeconds: number;
	readonly idleAt?: number;
}
export interface MemberRequestInbound {
	readonly requestId: string;
	readonly requester: MemberRequestMember;
	readonly message: string;
	readonly instructions: readonly string[];
	readonly accepted: boolean;
	readonly idleArmed: boolean;
	readonly idleAt?: number;
}

interface MutableOutbound extends MemberRequestOutbound {
	accepted: boolean;
	idleArmed: boolean;
	idleAt?: number;
}
interface MutableInbound extends MemberRequestInbound {
	accepted: boolean;
	idleArmed: boolean;
	idleAt?: number;
}

export type RequestOutcomeOperation<T> = { ok: true; value: T } | { ok: false; code: RequestOutcomeFailureCode };
export type RequestOutcomeWaitResult =
	| { ok: true; kind: "update"; update: RequestOutcome }
	| { ok: true; kind: "waiting"; cancel: () => void }
	| { ok: false; code: "already-waiting" | "no-pending-requests" };

type TerminalState = { kind: RequestOutcome["kind"]; update?: RequestOutcome };

type TimeoutReason = "max-wait" | "response-after-idle";

function validRequestId(requestId: string): boolean {
	return (
		requestId.trim() === requestId &&
		requestId.length > 0 &&
		Buffer.byteLength(requestId, "utf8") <= MAX_REQUEST_ID_BYTES
	);
}

/**
 * Pure Member request/Request outcome registry. It owns state transitions and ordering only;
 * callers own sockets, timers, Pi context visibility, and persistence.
 */
export class RequestOutcomeRegistry {
	private readonly outbound = new Map<string, MutableOutbound>();
	private readonly inbound = new Map<string, MutableInbound>();
	private readonly terminal = new Map<string, TerminalState>();
	private readonly inboundTerminal = new Map<string, "response">();
	private readonly tombstoneOrder: string[] = [];
	private readonly inboundTombstoneOrder: string[] = [];
	private readonly buffered: Array<{ readonly update: RequestOutcome; readonly sequence: number }> = [];
	private sequence = 0;
	private waiter: ((update: RequestOutcome) => void) | undefined;

	registerOutbound(input: {
		readonly requestId: string;
		readonly member: MemberRequestMember;
		readonly now: number;
		readonly timeoutSeconds?: number;
		readonly maxWaitSeconds?: number;
	}): RequestOutcomeOperation<MemberRequestOutbound> {
		if (!validRequestId(input.requestId)) return { ok: false, code: "invalid-request-id" };
		const timeoutSeconds = input.timeoutSeconds ?? DEFAULT_MEMBER_REQUEST_TIMEOUT_SECONDS;
		if (
			!Number.isInteger(timeoutSeconds) ||
			timeoutSeconds < 1 ||
			timeoutSeconds > MAX_MEMBER_REQUEST_TIMEOUT_SECONDS
		)
			return { ok: false, code: "invalid-timeout" };
		const maxWaitSeconds = input.maxWaitSeconds ?? DEFAULT_MEMBER_REQUEST_MAX_WAIT_SECONDS;
		if (
			!Number.isInteger(maxWaitSeconds) ||
			maxWaitSeconds < MIN_MEMBER_REQUEST_MAX_WAIT_SECONDS ||
			maxWaitSeconds > MAX_MEMBER_REQUEST_MAX_WAIT_SECONDS ||
			maxWaitSeconds <= timeoutSeconds
		)
			return { ok: false, code: "invalid-max-wait" };
		if (
			this.outbound.has(input.requestId) ||
			this.inbound.has(input.requestId) ||
			this.terminal.has(input.requestId)
		)
			return { ok: false, code: "duplicate-request" };
		if (this.outbound.size >= MAX_MEMBER_REQUEST_OUTBOUND) return { ok: false, code: "outbound-capacity" };
		if (this.buffered.length + this.outbound.size >= MAX_MEMBER_REQUEST_BUFFERED)
			return { ok: false, code: "buffer-capacity" };
		const request: MutableOutbound = {
			requestId: input.requestId,
			member: input.member,
			// Registration-time conservative hard bound; the flow arms the real
			// hard timer at acceptedAt + max_wait_seconds (TASK-0080).
			deadlineAt: input.now + maxWaitSeconds * 1000,
			accepted: false,
			idleArmed: false,
			timeoutSeconds,
			maxWaitSeconds,
		};
		this.outbound.set(request.requestId, request);
		return { ok: true, value: { ...request } };
	}

	registerInbound(input: {
		readonly requestId: string;
		readonly requester: MemberRequestMember;
		readonly message: string;
		readonly instructions: readonly string[];
	}): RequestOutcomeOperation<MemberRequestInbound> {
		if (!validRequestId(input.requestId)) return { ok: false, code: "invalid-request-id" };
		if (
			this.outbound.has(input.requestId) ||
			this.inbound.has(input.requestId) ||
			this.terminal.has(input.requestId)
		)
			return { ok: false, code: "duplicate-request" };
		if (this.inbound.size >= MAX_MEMBER_REQUEST_INBOUND) return { ok: false, code: "inbound-capacity" };
		const request: MutableInbound = { ...input, accepted: false, idleArmed: false };
		this.inbound.set(request.requestId, request);
		return { ok: true, value: { ...request, instructions: [...request.instructions] } };
	}

	acceptOutbound(requestId: string): RequestOutcomeOperation<MemberRequestOutbound> {
		const request = this.outbound.get(requestId);
		if (!request) return { ok: false, code: "unknown-request" };
		request.accepted = true;
		return { ok: true, value: { ...request } };
	}

	acceptInbound(requestId: string): RequestOutcomeOperation<MemberRequestInbound> {
		const request = this.inbound.get(requestId);
		if (!request) return { ok: false, code: "unknown-request" };
		request.accepted = true;
		return { ok: true, value: { ...request, instructions: [...request.instructions] } };
	}

	armOutboundIdle(requestId: string, now?: number): RequestOutcomeOperation<MemberRequestOutbound> {
		const request = this.outbound.get(requestId);
		if (!request) return { ok: false, code: "unknown-request" };
		if (!request.accepted) return { ok: false, code: "unknown-request" };
		// TASK-0080: idle is NONTERMINAL. First valid post-context idle arms the
		// grace window once (records idleAt); later settles never re-arm. The
		// request/channel/capacity slot is preserved until a real terminal.
		if (request.idleArmed) return { ok: true, value: { ...request } };
		request.idleArmed = true;
		if (now !== undefined) request.idleAt = now;
		return { ok: true, value: { ...request } };
	}

	armInboundIdle(requestId: string): RequestOutcomeOperation<MemberRequestInbound> {
		const request = this.inbound.get(requestId);
		if (!request) return { ok: false, code: "unknown-request" };
		if (!request.accepted) return { ok: false, code: "unknown-request" };
		request.idleArmed = true;
		return { ok: true, value: { ...request, instructions: [...request.instructions] } };
	}

	failBeforeAcceptance(requestId: string): RequestOutcomeOperation<null> {
		const outbound = this.outbound.get(requestId);
		if (outbound && !outbound.accepted) {
			this.outbound.delete(requestId);
			return { ok: true, value: null };
		}
		const inbound = this.inbound.get(requestId);
		if (inbound && !inbound.accepted) {
			this.inbound.delete(requestId);
			return { ok: true, value: null };
		}
		return { ok: false, code: "unknown-request" };
	}

	closeOutcomeUnknown(requestId: string): RequestOutcomeOperation<null> {
		if (!this.outbound.delete(requestId) && !this.inbound.delete(requestId))
			return { ok: false, code: "unknown-request" };
		return { ok: true, value: null };
	}

	resolveResponse(input: {
		readonly requestId: string;
		readonly member: MemberRequestMember;
		readonly message: string;
		readonly instructions: readonly string[];
	}): RequestOutcomeOperation<RequestOutcomeResponse> {
		const request = this.outbound.get(input.requestId);
		if (!request) {
			const terminal = this.terminal.get(input.requestId);
			if (!terminal) return { ok: false, code: "unknown-request" };
			return { ok: false, code: "already-terminal" };
		}
		if (!request.accepted) return { ok: false, code: "unknown-request" };
		const update: RequestOutcomeResponse = {
			kind: "response",
			requestId: input.requestId,
			member: input.member,
			message: input.message,
			instructions: [...input.instructions],
		};
		this.outbound.delete(input.requestId);
		this.setTerminal(input.requestId, { kind: update.kind, update });
		this.publish(update);
		return { ok: true, value: update };
	}

	resolveIdle(requestId: string, now?: number): RequestOutcomeOperation<MemberRequestOutbound> {
		const request = this.outbound.get(requestId);
		if (!request) return { ok: false, code: "unknown-request" };
		if (!request.accepted) return { ok: false, code: "unknown-request" };
		if (!request.idleArmed) {
			request.idleArmed = true;
			if (now !== undefined) request.idleAt = now;
		}
		// TASK-0080: the internal nonresuming idle notification never produces a
		// terminal; it only arms the grace window. The wait stays parked.
		return { ok: true, value: { ...request } };
	}

	resolveOffline(requestId: string): RequestOutcomeOperation<RequestOutcomeOffline> {
		return this.resolveMechanical(requestId, "offline");
	}
	/** TASK-0080: timeout carries a reason; grace (response-after-idle) requires idleArmed. */
	resolveTimeout(requestId: string, reason: TimeoutReason): RequestOutcomeOperation<RequestOutcomeTimeout> {
		const request = this.outbound.get(requestId);
		if (!request)
			return this.terminal.has(requestId)
				? { ok: false, code: "already-terminal" }
				: { ok: false, code: "unknown-request" };
		if (reason === "response-after-idle" && !request.idleArmed) return { ok: false, code: "unknown-request" };
		const update: RequestOutcomeTimeout = { kind: "timeout", requestId, member: request.member, reason };
		this.outbound.delete(requestId);
		this.setTerminal(requestId, { kind: update.kind, update });
		this.publish(update);
		return { ok: true, value: update };
	}

	private setTerminal(requestId: string, state: TerminalState): void {
		this.terminal.set(requestId, state);
		this.tombstoneOrder.push(requestId);
		while (this.tombstoneOrder.length > MAX_REQUEST_OUTCOME_TOMBSTONES) {
			const evicted = this.tombstoneOrder.shift();
			if (evicted !== undefined) this.terminal.delete(evicted);
		}
	}

	private resolveMechanical(requestId: string, kind: "offline"): RequestOutcomeOperation<RequestOutcomeOffline> {
		const request = this.outbound.get(requestId);
		if (!request)
			return this.terminal.has(requestId)
				? { ok: false, code: "already-terminal" }
				: { ok: false, code: "unknown-request" };
		const update: RequestOutcomeOffline = { kind, requestId, member: request.member };
		this.outbound.delete(requestId);
		this.setTerminal(requestId, { kind, update });
		this.publish(update);
		return { ok: true, value: update };
	}

	selectInbound(requestId?: string): RequestOutcomeOperation<MemberRequestInbound> {
		if (requestId !== undefined) {
			const request = this.inbound.get(requestId);
			if (request) return { ok: true, value: { ...request, instructions: [...request.instructions] } };
			const terminal = this.inboundTerminal.get(requestId);
			return terminal === "response"
				? { ok: false, code: "already-terminal" }
				: { ok: false, code: "unknown-request" };
		}
		if (this.inbound.size === 0) return { ok: false, code: "no-pending-request" };
		if (this.inbound.size > 1) return { ok: false, code: "ambiguous-request" };
		const request = this.inbound.values().next().value as MutableInbound;
		return { ok: true, value: { ...request, instructions: [...request.instructions] } };
	}

	resolveInboundResponse(requestId: string): RequestOutcomeOperation<MemberRequestInbound> {
		const request = this.inbound.get(requestId);
		if (!request) {
			const terminal = this.inboundTerminal.get(requestId);
			return terminal === "response"
				? { ok: false, code: "already-terminal" }
				: { ok: false, code: "response-expired" };
		}
		this.inbound.delete(requestId);
		this.setInboundTerminal(requestId, "response");
		return { ok: true, value: { ...request, instructions: [...request.instructions] } };
	}

	/** TASK-0080: first valid post-context idle on the responder is NONTERMINAL
	 * (internal member.request.idle + reminder). It arms the idle flag once and
	 * preserves the inbound slot; the channel stays open until a real terminal. */
	armInboundIdleNow(requestId: string, now?: number): RequestOutcomeOperation<MemberRequestInbound> {
		const request = this.inbound.get(requestId);
		if (!request) return { ok: false, code: "unknown-request" };
		if (!request.accepted) return { ok: false, code: "unknown-request" };
		if (!request.idleArmed) {
			request.idleArmed = true;
			if (now !== undefined) (request as MutableInbound).idleAt = now;
		}
		return { ok: true, value: { ...request, instructions: [...request.instructions] } };
	}

	resolveInboundIdle(requestId: string, now?: number): RequestOutcomeOperation<MemberRequestInbound> {
		return this.armInboundIdleNow(requestId, now);
	}

	resolveInboundExpired(requestId: string): RequestOutcomeOperation<null> {
		if (!this.inbound.delete(requestId)) return { ok: false, code: "unknown-request" };
		return { ok: true, value: null };
	}

	private setInboundTerminal(requestId: string, kind: "response"): void {
		this.inboundTerminal.set(requestId, kind);
		this.inboundTombstoneOrder.push(requestId);
		while (this.inboundTombstoneOrder.length > MAX_REQUEST_OUTCOME_TOMBSTONES) {
			const evicted = this.inboundTombstoneOrder.shift();
			if (evicted !== undefined) this.inboundTerminal.delete(evicted);
		}
	}

	waitForUpdate(onUpdate: (update: RequestOutcome) => void): RequestOutcomeWaitResult {
		const next = this.buffered.shift();
		if (next) return { ok: true, kind: "update", update: next.update };
		if (this.outbound.size === 0) return { ok: false, code: "no-pending-requests" };
		if (this.waiter) return { ok: false, code: "already-waiting" };
		let active = true;
		const callback = (update: RequestOutcome) => {
			if (!active) return;
			active = false;
			this.waiter = undefined;
			onUpdate(update);
		};
		this.waiter = callback;
		return {
			ok: true,
			kind: "waiting",
			cancel: () => {
				if (!active) return;
				active = false;
				if (this.waiter === callback) this.waiter = undefined;
			},
		};
	}

	private publish(update: RequestOutcome): void {
		if (this.waiter) {
			const waiter = this.waiter;
			this.waiter = undefined;
			waiter(update);
			return;
		}
		if (this.buffered.length >= MAX_MEMBER_REQUEST_BUFFERED) return;
		this.buffered.push({ update, sequence: this.sequence++ });
		this.buffered.sort(
			(left, right) =>
				left.sequence - right.sequence || left.update.requestId.localeCompare(right.update.requestId),
		);
	}

	bufferedCount(): number {
		return this.buffered.length;
	}
	outboundCount(): number {
		return this.outbound.size;
	}
	/** Read-only peek for deadline/tie decisions (TASK-0080). */
	getOutbound(requestId: string): MemberRequestOutbound | undefined {
		const request = this.outbound.get(requestId);
		return request ? { ...request } : undefined;
	}
	/** TASK-0077: true when a Request outcome is already waiting (pending outbound or buffered terminal). */
	hasPendingOutcome(): boolean {
		return this.buffered.length > 0 || this.outbound.size > 0;
	}
	inboundCount(): number {
		return this.inbound.size;
	}
	inboundRequestIds(): readonly string[] {
		return [...this.inbound.keys()];
	}
	inboundSummaries(): ReadonlyArray<{ readonly requestId: string; readonly requester: MemberRequestMember }> {
		return [...this.inbound.values()].map((request) => ({
			requestId: request.requestId,
			requester: request.requester,
		}));
	}
}
