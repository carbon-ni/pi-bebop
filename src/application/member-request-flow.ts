import { isMessagePayload, type MemberRequestCommand, type MemberUpdateResult } from "../domain/index.ts";
import { RpcProtocolError } from "../infra/rpc-client.ts";
import {
	RequestOutcomeRegistry,
	DEFAULT_MEMBER_REQUEST_TIMEOUT_SECONDS,
	type RequestOutcome,
	type MemberRequestInbound,
	type MemberRequestMember,
} from "../domain/index.ts";
import { resolveTarget, MemberMessageError, type CrewMembership, type CrewMember } from "./member-message.ts";

export interface MemberRequestTransport {
	open(
		endpoint: string,
		command: MemberRequestCommand,
		options: { signal?: AbortSignal; timeoutMs: number; onUpdate: (update: MemberUpdateResult) => void },
	): Promise<{ close: () => void }>;
	respond(channel: MemberRequestResponseChannel, update: MemberUpdateResult): Promise<void>;
}
export interface MemberRequestResponseChannel {
	readonly send: (update: MemberUpdateResult) => Promise<void>;
	readonly close?: () => void;
}
export interface MemberRequestFlowDependencies {
	readonly transport: MemberRequestTransport;
	readonly resolveEndpoint: (socketPath: string) => Promise<string>;
	readonly now?: () => number;
	readonly createRequestId?: () => string;
	readonly setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof globalThis.setTimeout>;
	readonly clearTimeout?: (handle: ReturnType<typeof globalThis.setTimeout>) => void;
}
export interface SendMemberRequestInput {
	readonly membership: CrewMembership | null;
	readonly member: string;
	readonly message: string;
	readonly instructions?: readonly string[];
	readonly timeoutSeconds?: number;
	readonly signal?: AbortSignal;
}
export interface SendMemberRequestAccepted {
	readonly requestId: string;
	readonly member: CrewMember;
}

function defaultRequestId(): string {
	return `request_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Application orchestration around the pure request/update registry. */
export class MemberRequestFlow {
	readonly registry = new RequestOutcomeRegistry();
	private readonly channels = new Map<string, MemberRequestResponseChannel>();
	private readonly closes = new Map<string, () => void>();
	private readonly completed = new Set<string>();
	private readonly timers = new Map<string, ReturnType<typeof globalThis.setTimeout>>();
	private readonly now: () => number;
	private readonly createRequestId: () => string;
	private readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof globalThis.setTimeout>;
	private readonly clearTimer: (handle: ReturnType<typeof globalThis.setTimeout>) => void;

	constructor(private readonly dependencies: MemberRequestFlowDependencies) {
		this.now = dependencies.now ?? Date.now;
		this.createRequestId = dependencies.createRequestId ?? defaultRequestId;
		this.setTimer = dependencies.setTimeout ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
		this.clearTimer = dependencies.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle));
	}

	async sendMemberRequest(input: SendMemberRequestInput): Promise<SendMemberRequestAccepted> {
		if (!input.membership) throw new MemberMessageError("not-joined", "Not joined to a crew");
		const target = resolveTarget(input.membership, input.member.trim());
		const origin = {
			kind: "crew" as const,
			name: input.membership.member.name,
			role: input.membership.member.role,
		};
		const payload = {
			content: input.message,
			...(input.instructions === undefined ? {} : { instructions: [...input.instructions] }),
			origin,
		};
		if (!isMessagePayload(payload))
			throw new MemberMessageError("invalid-payload", "Invalid structured message payload");
		const requestId = this.createRequestId();
		const timeoutSeconds = input.timeoutSeconds ?? DEFAULT_MEMBER_REQUEST_TIMEOUT_SECONDS;
		const registration = this.registry.registerOutbound({
			requestId,
			member: { name: target.name, role: target.role },
			now: this.now(),
			timeoutSeconds,
		});
		if (registration.ok === false) throw new Error(registration.code);
		const timer = this.setTimer(() => {
			const outcome = this.registry.resolveTimeout(requestId);
			if (outcome.ok) {
				this.completed.add(requestId);
				this.finishRequest(requestId);
			}
		}, timeoutSeconds * 1000);
		this.timers.set(requestId, timer);
		const onUpdate = (update: MemberUpdateResult) => {
			if (update.kind === "response")
				this.registry.resolveResponse({
					requestId,
					member: update.member,
					message: update.message,
					instructions: update.instructions ?? [],
				});
			else if (update.kind === "idle-without-response") this.registry.resolveIdle(requestId);
			else if (update.kind === "offline") this.registry.resolveOffline(requestId);
			else this.registry.resolveTimeout(requestId);
			this.completed.add(requestId);
			this.finishRequest(requestId);
		};
		try {
			const endpoint = await this.dependencies.resolveEndpoint(target.socketPath);
			const opened = await this.dependencies.transport.open(
				endpoint,
				{ type: "member_request", requestId, payload, timeoutSeconds },
				{ signal: input.signal, timeoutMs: timeoutSeconds * 1000, onUpdate },
			);
			this.closes.set(requestId, opened.close);
			this.channels.set(requestId, { send: async () => undefined });
			if (this.completed.delete(requestId)) this.finishRequest(requestId);
			const accepted = this.registry.acceptOutbound(requestId);
			if (accepted.ok === false) throw new Error(accepted.code);
			// TASK-0075: transport.open resolves only after the target's
			// pi.sendMessage acceptance, so idle handling is armed here — never
			// before dispatch and never from a pre-context idle. Without this the
			// target's later `idle-without-response` is dropped and the
			// wait_for_request_outcome waiter stays blocked until the deadline.
			this.registry.armOutboundIdle(requestId);
			return { requestId, member: target };
		} catch (error) {
			this.clearTimer(this.timers.get(requestId)!);
			this.timers.delete(requestId);
			if (error instanceof RpcProtocolError && error.code === "outcome-unknown") {
				this.registry.closeOutcomeUnknown(requestId);
				this.finishRequest(requestId);
			} else this.registry.failBeforeAcceptance(requestId);
			throw error;
		}
	}

	private finishRequest(requestId: string): void {
		const timer = this.timers.get(requestId);
		if (timer !== undefined) this.clearTimer(timer);
		this.timers.delete(requestId);
		const channel = this.channels.get(requestId);
		this.channels.delete(requestId);
		channel?.close?.();
		this.closes.get(requestId)?.();
		this.closes.delete(requestId);
	}

	cancelRequest(requestId: string): void {
		this.registry.resolveOffline(requestId);
		this.finishRequest(requestId);
	}

	waitForRequestOutcome(onUpdate: (update: RequestOutcome) => void) {
		return this.registry.waitForUpdate(onUpdate);
	}

	registerInboundRequest(input: {
		readonly requestId: string;
		readonly requester: MemberRequestMember;
		readonly message: string;
		readonly instructions: readonly string[];
		readonly channel: MemberRequestResponseChannel;
	}): MemberRequestInbound {
		const registered = this.registry.registerInbound(input);
		if (registered.ok === false) throw new Error(registered.code);
		this.channels.set(input.requestId, input.channel);
		return registered.value;
	}

	acceptInboundRequest(requestId: string): void {
		const accepted = this.registry.acceptInbound(requestId);
		if (accepted.ok === false) throw new Error(accepted.code);
	}

	armInboundRequest(requestId: string): void {
		const armed = this.registry.armInboundIdle(requestId);
		if (armed.ok === false) throw new Error(armed.code);
	}

	async respondToMemberRequest(input: {
		readonly message: string;
		readonly instructions?: readonly string[];
		readonly requestId?: string;
		readonly member: MemberRequestMember;
	}): Promise<void> {
		const selected = this.registry.selectInbound(input.requestId);
		if (selected.ok === false) {
			if (selected.code === "ambiguous-request") {
				const summary = this.registry
					.inboundSummaries()
					.map((item) => `${item.requestId} (${item.requester.name}/${item.requester.role})`)
					.join(", ");
				throw new Error(`ambiguous-request: ${summary}`);
			}
			throw new Error(selected.code);
		}
		const closed = this.registry.resolveInboundResponse(selected.value.requestId);
		if (closed.ok === false) throw new Error(closed.code);
		const update: MemberUpdateResult = {
			kind: "response",
			requestId: selected.value.requestId,
			member: input.member,
			message: input.message,
			...(input.instructions === undefined ? {} : { instructions: [...input.instructions] }),
		};
		await this.channels.get(selected.value.requestId)?.send(update);
		const responseChannel = this.channels.get(selected.value.requestId);
		this.channels.delete(selected.value.requestId);
		responseChannel?.close?.();
	}

	removeInboundRequest(requestId: string): void {
		this.registry.resolveInboundExpired(requestId);
		const channel = this.channels.get(requestId);
		this.channels.delete(requestId);
		channel?.close?.();
	}

	async settleInboundIdle(requestId: string): Promise<void> {
		const closed = this.registry.resolveInboundIdle(requestId);
		if (!closed.ok) return;
		await this.channels.get(requestId)?.send({
			kind: "idle-without-response",
			requestId,
			member: closed.value.requester,
		});
		const idleChannel = this.channels.get(requestId);
		this.channels.delete(requestId);
		idleChannel?.close?.();
	}

	async settleAllInboundIdle(): Promise<void> {
		// TASK-0075: settle requests independently over a snapshot; a broken or
		// already-closed channel must never leave other settled requests stuck
		// (the source's offline path covers a dead socket).
		for (const requestId of [...this.registry.inboundRequestIds()]) {
			try {
				await this.settleInboundIdle(requestId);
			} catch {
				/* ignore: isolated channel failure */
			}
		}
	}
}
