export const MAX_MEMBER_REQUEST_OUTBOUND = 8;
export const MAX_MEMBER_REQUEST_INBOUND = 8;
export const MAX_MEMBER_REQUEST_BUFFERED = 64;
export const MAX_REQUEST_ID_BYTES = 128;
export const MAX_REQUEST_OUTCOME_TOMBSTONES = 64;
export const DEFAULT_MEMBER_REQUEST_TIMEOUT_SECONDS = 300;

export type RequestOutcomeFailureCode =
	| "outbound-capacity"
	| "inbound-capacity"
	| "buffer-capacity"
	| "invalid-request-id"
	| "invalid-timeout"
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
export interface RequestOutcomeMechanical {
	readonly kind: "idle-without-response" | "offline" | "timeout";
	readonly requestId: string;
	readonly member: MemberRequestMember;
}
export type RequestOutcome = RequestOutcomeResponse | RequestOutcomeMechanical;

export interface MemberRequestOutbound {
	readonly requestId: string;
	readonly member: MemberRequestMember;
	readonly deadlineAt: number;
	readonly accepted: boolean;
	readonly idleArmed: boolean;
}
export interface MemberRequestInbound {
	readonly requestId: string;
	readonly requester: MemberRequestMember;
	readonly message: string;
	readonly instructions: readonly string[];
	readonly accepted: boolean;
	readonly idleArmed: boolean;
}

interface MutableOutbound extends MemberRequestOutbound {
	accepted: boolean;
	idleArmed: boolean;
}
interface MutableInbound extends MemberRequestInbound {
	accepted: boolean;
	idleArmed: boolean;
}

export type RequestOutcomeOperation<T> = { ok: true; value: T } | { ok: false; code: RequestOutcomeFailureCode };
export type RequestOutcomeWaitResult =
	| { ok: true; kind: "update"; update: RequestOutcome }
	| { ok: true; kind: "waiting"; cancel: () => void }
	| { ok: false; code: "already-waiting" | "no-pending-requests" };

type TerminalState = { kind: RequestOutcome["kind"]; update?: RequestOutcome };

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
	private readonly inboundTerminal = new Map<string, "response" | "idle-without-response">();
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
	}): RequestOutcomeOperation<MemberRequestOutbound> {
		if (!validRequestId(input.requestId)) return { ok: false, code: "invalid-request-id" };
		const timeoutSeconds = input.timeoutSeconds ?? DEFAULT_MEMBER_REQUEST_TIMEOUT_SECONDS;
		if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600)
			return { ok: false, code: "invalid-timeout" };
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
			deadlineAt: input.now + timeoutSeconds * 1000,
			accepted: false,
			idleArmed: false,
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

	armOutboundIdle(requestId: string): RequestOutcomeOperation<MemberRequestOutbound> {
		const request = this.outbound.get(requestId);
		if (!request) return { ok: false, code: "unknown-request" };
		if (!request.accepted) return { ok: false, code: "unknown-request" };
		request.idleArmed = true;
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
			return terminal.kind === "idle-without-response"
				? { ok: false, code: "response-expired" }
				: { ok: false, code: "already-terminal" };
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

	resolveIdle(requestId: string): RequestOutcomeOperation<RequestOutcomeMechanical> {
		const request = this.outbound.get(requestId);
		if (!request)
			return this.terminal.has(requestId)
				? { ok: false, code: "already-terminal" }
				: { ok: false, code: "unknown-request" };
		if (!request.accepted || !request.idleArmed) return { ok: false, code: "unknown-request" };
		const update: RequestOutcomeMechanical = { kind: "idle-without-response", requestId, member: request.member };
		this.outbound.delete(requestId);
		this.setTerminal(requestId, { kind: update.kind, update });
		this.publish(update);
		return { ok: true, value: update };
	}

	resolveOffline(requestId: string): RequestOutcomeOperation<RequestOutcomeMechanical> {
		return this.resolveMechanical(requestId, "offline");
	}
	resolveTimeout(requestId: string): RequestOutcomeOperation<RequestOutcomeMechanical> {
		return this.resolveMechanical(requestId, "timeout");
	}

	private setTerminal(requestId: string, state: TerminalState): void {
		this.terminal.set(requestId, state);
		this.tombstoneOrder.push(requestId);
		while (this.tombstoneOrder.length > MAX_REQUEST_OUTCOME_TOMBSTONES) {
			const evicted = this.tombstoneOrder.shift();
			if (evicted !== undefined) this.terminal.delete(evicted);
		}
	}

	private resolveMechanical(
		requestId: string,
		kind: "offline" | "timeout",
	): RequestOutcomeOperation<RequestOutcomeMechanical> {
		const request = this.outbound.get(requestId);
		if (!request) return { ok: false, code: "unknown-request" };
		const update: RequestOutcomeMechanical = { kind, requestId, member: request.member };
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
			return terminal === "idle-without-response"
				? { ok: false, code: "response-expired" }
				: terminal === "response"
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
			return terminal === "idle-without-response"
				? { ok: false, code: "response-expired" }
				: terminal === "response"
					? { ok: false, code: "already-terminal" }
					: { ok: false, code: "response-expired" };
		}
		this.inbound.delete(requestId);
		this.setInboundTerminal(requestId, "response");
		return { ok: true, value: { ...request, instructions: [...request.instructions] } };
	}

	resolveInboundIdle(requestId: string): RequestOutcomeOperation<MemberRequestInbound> {
		const request = this.inbound.get(requestId);
		if (!request || !request.accepted || !request.idleArmed) return { ok: false, code: "unknown-request" };
		this.inbound.delete(requestId);
		this.setInboundTerminal(requestId, "idle-without-response");
		return { ok: true, value: { ...request, instructions: [...request.instructions] } };
	}

	resolveInboundExpired(requestId: string): RequestOutcomeOperation<null> {
		if (!this.inbound.delete(requestId)) return { ok: false, code: "unknown-request" };
		return { ok: true, value: null };
	}

	private setInboundTerminal(requestId: string, kind: "response" | "idle-without-response"): void {
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
