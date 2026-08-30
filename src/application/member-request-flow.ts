import {
	isMessagePayload,
	type MemberRequestCommand,
	type MemberUpdateResult,
	type MemberChannelUpdate,
} from "../domain/index.ts";
import { RpcProtocolError } from "../infra/rpc-client.ts";
import {
	RequestOutcomeRegistry,
	RequestReminderScheduler,
	DEFAULT_MEMBER_REQUEST_TIMEOUT_SECONDS,
	DEFAULT_MEMBER_REQUEST_MAX_WAIT_SECONDS,
	MEMBER_REQUEST_ACCEPT_DEADLINE_MS,
	type RequestOutcomeEvent,
	type RequestOutcomeReminder,
	type MemberRequestInbound,
	type MemberRequestMember,
} from "../domain/index.ts";
import { resolveTarget, MemberMessageError, type CrewMembership, type CrewMember } from "./member-message.ts";

export interface MemberRequestTransport {
	open(
		endpoint: string,
		command: MemberRequestCommand,
		options: { signal?: AbortSignal; timeoutMs: number; onUpdate: (update: MemberChannelUpdate) => void },
	): Promise<{ close: () => void }>;
	respond(channel: MemberRequestResponseChannel, update: MemberUpdateResult): Promise<void>;
}
export interface MemberRequestResponseChannel {
	readonly send: (update: import("../domain/index.ts").MemberChannelUpdate) => Promise<void>;
	readonly close?: () => void;
}
export interface MemberRequestFlowDependencies {
	readonly transport: MemberRequestTransport;
	readonly resolveEndpoint: (socketPath: string) => Promise<string>;
	readonly now?: () => number;
	readonly createRequestId?: () => string;
	readonly setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof globalThis.setTimeout>;
	readonly clearTimeout?: (handle: ReturnType<typeof globalThis.setTimeout>) => void;
	/** TASK-0080: queued exactly once at the target's first post-context idle. */
	readonly onFirstIdleReminder?: (requestId: string, requester: MemberRequestMember) => void;
	/** Requester-side reminder, fired once at acceptedAt + 180 seconds. */
	readonly onRequesterReminder?: (reminders: readonly RequestOutcomeReminder[], parked: boolean) => void;
}
export interface SendMemberRequestInput {
	readonly membership: CrewMembership | null;
	readonly member: string;
	readonly message: string;
	readonly instructions?: readonly string[];
	readonly timeoutSeconds?: number;
	readonly maxWaitSeconds?: number;
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
	private readonly idleNotified = new Set<string>();
	private readonly now: () => number;
	private readonly createRequestId: () => string;
	private readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof globalThis.setTimeout>;
	private readonly clearTimer: (handle: ReturnType<typeof globalThis.setTimeout>) => void;
	private readonly reminderScheduler: RequestReminderScheduler;

	constructor(private readonly dependencies: MemberRequestFlowDependencies) {
		this.now = dependencies.now ?? Date.now;
		this.createRequestId = dependencies.createRequestId ?? defaultRequestId;
		this.setTimer = dependencies.setTimeout ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
		this.clearTimer = dependencies.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle));
		this.reminderScheduler = new RequestReminderScheduler({
			setTimeout: this.setTimer,
			clearTimeout: this.clearTimer,
			now: this.now,
			onReminders: (reminders) => {
				let parked = false;
				for (const reminder of reminders) parked = this.registry.publishReminder(reminder) || parked;
				this.dependencies.onRequesterReminder?.(reminders, parked);
			},
		});
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
		const maxWaitSeconds = input.maxWaitSeconds ?? DEFAULT_MEMBER_REQUEST_MAX_WAIT_SECONDS;
		const registration = this.registry.registerOutbound({
			requestId,
			member: { name: target.name, role: target.role },
			now: this.now(),
			timeoutSeconds,
			maxWaitSeconds,
		});
		if (registration.ok === false) throw new Error(registration.code);
		// TASK-0080: the acceptance window is FIXED (5s). Failure here leaves no
		// accepted slot and starts neither Response timer.
		let accepted = false;
		const onUpdate = (update: MemberChannelUpdate) => {
			if (update.kind === "idle") {
				// Internal nonterminal idle: arm the post-idle grace ONCE. Never
				// resolves, never finishes the request, never consumes a wait.
				const armed = this.registry.armOutboundIdle(requestId, this.now());
				if (armed.ok && !this.timers.has(`grace:${requestId}`)) {
					const graceTimer = this.setTimer(() => {
						this.resolveTerminal(requestId, "response-after-idle");
					}, timeoutSeconds * 1000);
					this.timers.set(`grace:${requestId}`, graceTimer);
				}
				return;
			}
			// Terminal updates. Precedence response > offline > timeout is
			// enforced by the registry's atomic first-claim: a Response arriving
			// first in the same handler beats a later socket-close offline, and a
			// terminal already claimed rejects every later transition.
			if (update.kind === "response")
				this.registry.resolveResponse({
					requestId,
					member: update.member,
					message: update.message,
					instructions: update.instructions ?? [],
				});
			else if (update.kind === "offline") this.registry.resolveOffline(requestId);
			else this.registry.resolveTimeout(requestId, "max-wait");
			this.completed.add(requestId);
			this.finishRequest(requestId);
		};
		try {
			const endpoint = await this.dependencies.resolveEndpoint(target.socketPath);
			const opened = await this.dependencies.transport.open(
				endpoint,
				{ type: "member_request", requestId, payload, timeoutSeconds },
				{ signal: input.signal, timeoutMs: MEMBER_REQUEST_ACCEPT_DEADLINE_MS, onUpdate },
			);
			this.closes.set(requestId, opened.close);
			this.channels.set(requestId, { send: async () => undefined });
			if (this.completed.delete(requestId)) this.finishRequest(requestId);
			const acceptedOutcome = this.registry.acceptOutbound(requestId);
			if (acceptedOutcome.ok === false) throw new Error(acceptedOutcome.code);
			accepted = true;
			// TASK-0144: requester reminder starts exactly at accepted delivery,
			// independently for each opaque Request ID.
			this.reminderScheduler.register(requestId, { name: target.name, role: target.role }, this.now());
			// TASK-0080: hard safety starts exactly once at accepted delivery.
			const hardTimer = this.setTimer(() => {
				this.resolveTerminal(requestId, "max-wait");
			}, maxWaitSeconds * 1000);
			this.timers.set(`hard:${requestId}`, hardTimer);
			return { requestId, member: target };
		} catch (error) {
			if (accepted) this.finishRequest(requestId);
			else {
				this.clearTimer(this.timers.get(`grace:${requestId}`)!);
				this.timers.delete(`grace:${requestId}`);
				if (error instanceof RpcProtocolError && error.code === "outcome-unknown") {
					this.registry.closeOutcomeUnknown(requestId);
				} else this.registry.failBeforeAcceptance(requestId);
			}
			throw error;
		}
	}

	/** TASK-0080: resolve a timeout terminal with its reason and finish exactly once.
	 * Exact grace/hard tie resolves as response-after-idle (the more specific
	 * post-idle outcome); hard truncates a LATER grace deadline (max-wait). */
	private resolveTerminal(requestId: string, reason: "max-wait" | "response-after-idle"): void {
		if (reason === "max-wait") {
			const request = this.registry.getOutbound(requestId);
			if (
				request?.idleArmed &&
				request.idleAt !== undefined &&
				request.idleAt + request.timeoutSeconds * 1000 <= this.now()
			)
				reason = "response-after-idle";
		}
		const outcome = this.registry.resolveTimeout(requestId, reason);
		if (!outcome.ok) return; // already terminal / unknown: first-terminal-wins
		this.completed.add(requestId);
		this.finishRequest(requestId);
	}

	private finishRequest(requestId: string): void {
		this.reminderScheduler.cancel(requestId);
		this.registry.discardReminder(requestId);
		// TASK-0080: clear both Response timers (hard:<id>, grace:<id>) plus any
		// legacy single-key timer, exactly once; a leaked timer would otherwise
		// keep the event loop alive long after the request is terminal.
		for (const key of [...this.timers.keys()]) {
			if (key === requestId || key === `hard:${requestId}` || key === `grace:${requestId}`) {
				const timer = this.timers.get(key);
				if (timer !== undefined) this.clearTimer(timer);
				this.timers.delete(key);
			}
		}
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

	waitForRequestOutcome(onUpdate: (update: RequestOutcomeEvent) => void) {
		return this.registry.waitForUpdate(onUpdate);
	}

	/** TASK-0077: true when a Request outcome is already pending or buffered. */
	hasPendingRequestOutcome(): boolean {
		return this.registry.hasPendingOutcome();
	}

	pendingRequestCount(): number {
		return this.registry.outboundCount();
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
		// TASK-0080: first valid post-context idle is NONTERMINAL. It arms the
		// inbound idle flag once, sends the internal nonresuming member.request.idle
		// notification to the source (which arms ITS grace once), and queues
		// exactly one reminder. The request/channel/slot stay alive until a real
		// terminal (response, offline, grace, hard).
		const armed = this.registry.armInboundIdleNow(requestId, this.now());
		if (!armed.ok) return;
		if (this.idleNotified.has(requestId)) return;
		this.idleNotified.add(requestId);
		const request = armed.value;
		// Reminder first: a broken notification channel must never lose the
		// exactly-once best-effort reminder (TASK-0080).
		this.dependencies.onFirstIdleReminder?.(requestId, request.requester);
		const channel = this.channels.get(requestId);
		if (channel) {
			await channel.send({ kind: "idle", requestId, member: request.requester });
		}
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
