import { createMemberIdleWaitFlow, MemberIdleWaitFlowError } from "../application/member-idle-wait-flow.ts";
import {
	MEMBER_IDLE_WAIT_TIMEOUT_MAX_SECONDS,
	MEMBER_IDLE_WAIT_TIMEOUT_MIN_SECONDS,
	MEMBER_IDLE_WAIT_TIMEOUT_SECONDS,
} from "../domain/index.ts";
import { sendMemberIdleWait } from "../infra/rpc-client.ts";
import { BebopClientError, type BebopClientErrorCode } from "./errors.js";

const DEFAULT_MEMBER_IDLE_WAIT_SECONDS = MEMBER_IDLE_WAIT_TIMEOUT_SECONDS;
const MIN_MEMBER_IDLE_WAIT_SECONDS = MEMBER_IDLE_WAIT_TIMEOUT_MIN_SECONDS;
const MAX_MEMBER_IDLE_WAIT_SECONDS = MEMBER_IDLE_WAIT_TIMEOUT_MAX_SECONDS;
const systemClock: MemberIdleWaitClock = {
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) => clearTimeout(handle),
};

export interface MemberIdleWaitIdentity {
	readonly name: string;
	readonly role: string;
}

export type MemberIdleWaitResult =
	| {
			readonly member: MemberIdleWaitIdentity;
			readonly outcome: "idle";
			readonly disposition: "already-idle" | "became-idle";
			readonly observedAt: string;
	  }
	| {
			readonly member: MemberIdleWaitIdentity;
			readonly outcome: "offline" | "timeout" | "message-received";
			readonly observedAt: string;
	  };

export interface MemberIdleWaitOptions {
	readonly signal?: AbortSignal;
	/** Local bounded wait deadline. The wire operation remains one-shot and event-driven. */
	readonly timeoutSeconds?: number;
}

export interface MemberIdleWaitOperation {
	waitForMemberIdle(member: string, options?: MemberIdleWaitOptions): Promise<MemberIdleWaitResult>;
}

export interface InProcessMemberIdleWaitOperation extends MemberIdleWaitOperation {
	/** Synchronous target resolution used by the Pi edge before arming its wake gate. */
	resolveMemberIdleWait(input: { member: string; timeoutSeconds?: number }): {
		readonly kind: "ready";
		readonly target: MemberIdleWaitIdentity & { readonly socketPath: string };
		readonly timeoutSeconds: number;
	};
}

export type MemberIdleWaitTransportResult =
	| { readonly ok: true; readonly result: MemberIdleWaitResult }
	| {
			readonly ok: false;
			readonly code:
				| "timeout"
				| "offline"
				| "aborted"
				| "malformed-response"
				| "identity-mismatch"
				| "remote-rejected"
				| "capacity-exceeded"
				| "wait-in-progress"
				| "transport-error";
	  };

export interface InProcessMemberIdleWaitSurface {
	readonly getMembership: () => {
		readonly member: MemberIdleWaitIdentity & { readonly socketPath: string };
		readonly socketPath: string;
		readonly manifest: { readonly members: readonly (MemberIdleWaitIdentity & { readonly socketPath: string })[] };
	} | null;
	readonly isTrusted: () => boolean;
	readonly probeEndpoint: (socketPath: string, signal?: AbortSignal) => Promise<boolean>;
	readonly requestIdleWait: (
		endpoint: string,
		memberLabel: string,
		options: { readonly timeoutSeconds: number; readonly signal?: AbortSignal },
	) => Promise<MemberIdleWaitTransportResult>;
	readonly now: () => string;
}

export interface MemberIdleWaitClock {
	readonly setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
	readonly clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface InProcessMemberIdleWaitOperationDependencies {
	/** Trusted composition supplies the live application surface and target transport. */
	readonly surface: InProcessMemberIdleWaitSurface;
	/** Optional deterministic clock for bounded-wait tests. */
	readonly clock?: MemberIdleWaitClock;
}

type IdleBudget = {
	readonly signal: AbortSignal;
	readonly timedOut: () => boolean;
	cleanup(): void;
};

class DeadlineExceeded extends Error {
	constructor() {
		super("deadline exceeded");
		this.name = "DeadlineExceeded";
	}
}

function createIdleBudget(signal: AbortSignal | undefined, timeoutMs: number, clock: MemberIdleWaitClock): IdleBudget {
	const controller = new AbortController();
	let expired = false;
	const timer = clock.setTimeout(() => {
		expired = true;
		controller.abort(new DeadlineExceeded());
	}, timeoutMs);
	const onAbort = () => controller.abort(signal?.reason);
	signal?.addEventListener("abort", onAbort, { once: true });
	return {
		signal: controller.signal,
		timedOut: () => expired,
		cleanup() {
			clock.clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		},
	};
}

function awaitIdleBudget<T>(operation: PromiseLike<T>, budget: IdleBudget): Promise<T> {
	const pending = Promise.resolve(operation);
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const cleanup = () => budget.signal.removeEventListener("abort", onAbort);
		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(budget.timedOut() ? new DeadlineExceeded() : new BebopClientError("aborted"));
		};
		budget.signal.addEventListener("abort", onAbort, { once: true });
		pending.then(
			(value) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(value);
			},
			(error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			},
		);
		if (budget.signal.aborted) onAbort();
	});
}

function normalizeIdleError(error: unknown, budget: IdleBudget): BebopClientError {
	if (error instanceof BebopClientError) return error;
	if (budget.timedOut()) return new BebopClientError("timeout");
	if (budget.signal.aborted) return new BebopClientError("aborted");
	const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
	if (code === "ENOENT") return new BebopClientError("unknown-session");
	if (["ECONNREFUSED", "ENOTCONN", "EPIPE", "EPROTOTYPE", "ENOTSOCK"].includes(code ?? ""))
		return new BebopClientError("offline-session");
	if (error instanceof Error && /timeout|timed? ?out/i.test(error.message)) return new BebopClientError("timeout");
	return new BebopClientError("transport-error");
}

function validateMemberIdleWaitSeconds(timeoutSeconds: number | undefined): number {
	const value = timeoutSeconds ?? DEFAULT_MEMBER_IDLE_WAIT_SECONDS;
	if (!Number.isInteger(value) || value < MIN_MEMBER_IDLE_WAIT_SECONDS || value > MAX_MEMBER_IDLE_WAIT_SECONDS)
		throw new BebopClientError("invalid-input");
	return value;
}

function mapMemberIdleWaitFlowError(error: MemberIdleWaitFlowError): BebopClientError {
	const code: BebopClientErrorCode =
		error.code === "invalid-timeout"
			? "invalid-input"
			: error.code === "identity-mismatch"
				? "identity-mismatch"
				: error.code === "not-a-member"
					? "remote-rejected"
					: error.code === "self-wait"
						? "self-query"
						: error.code === "offline"
							? "offline-member"
							: error.code === "capacity-exceeded"
								? "capacity-exceeded"
								: (error.code as BebopClientErrorCode);
	return new BebopClientError(code, error.message);
}

function withMemberIdleWaitBudget<T>(
	options: MemberIdleWaitOptions | undefined,
	operation: (budget: IdleBudget, timeoutSeconds: number) => Promise<T>,
	clock: MemberIdleWaitClock,
): Promise<T> {
	if (options?.signal?.aborted) throw new BebopClientError("aborted");
	const timeoutSeconds = validateMemberIdleWaitSeconds(options?.timeoutSeconds);
	const budget = createIdleBudget(options?.signal, timeoutSeconds * 1000, clock);
	return operation(budget, timeoutSeconds)
		.catch((error) => {
			throw normalizeIdleError(error, budget);
		})
		.finally(() => budget.cleanup());
}

type FlowSurface = Parameters<typeof createMemberIdleWaitFlow>[0];

function flowSurface(surface: InProcessMemberIdleWaitSurface): FlowSurface {
	return surface as unknown as FlowSurface;
}

export function createInProcessMemberIdleWaitOperation(
	dependencies: InProcessMemberIdleWaitOperationDependencies,
): InProcessMemberIdleWaitOperation {
	const clock = dependencies.clock ?? systemClock;
	const createFlow = () => createMemberIdleWaitFlow(flowSurface(dependencies.surface));
	return {
		resolveMemberIdleWait(input) {
			try {
				return createFlow().resolveMemberIdleWait(input);
			} catch (error) {
				if (error instanceof MemberIdleWaitFlowError) throw mapMemberIdleWaitFlowError(error);
				throw error;
			}
		},
		waitForMemberIdle(member, options) {
			if (member.trim() !== member || member.length === 0) throw new BebopClientError("invalid-input");
			return withMemberIdleWaitBudget(
				options,
				async (budget, timeoutSeconds) => {
					try {
						const resolver = createFlow();
						const resolved = resolver.resolveMemberIdleWait({ member, timeoutSeconds });
						const flow = createMemberIdleWaitFlow({
							...flowSurface(dependencies.surface),
							requestIdleWait: async (endpoint, memberLabel, requestOptions) => {
								const outcome = await dependencies.surface.requestIdleWait(
									endpoint,
									memberLabel,
									requestOptions,
								);
								if (
									outcome.ok &&
									(outcome.result.member.name !== resolved.target.name ||
										outcome.result.member.role !== resolved.target.role)
								)
									throw new MemberIdleWaitFlowError(
										"identity-mismatch",
										"Member returned an idle wait result for a different identity",
									);
								return outcome;
							},
						});
						const signal = options?.signal
							? AbortSignal.any([budget.signal, options.signal])
							: budget.signal;
						return await awaitIdleBudget(
							flow.waitForMemberIdle({ member, timeoutSeconds, signal }),
							budget,
						);
					} catch (error) {
						if (error instanceof MemberIdleWaitFlowError) throw mapMemberIdleWaitFlowError(error);
						throw error;
					}
				},
				clock,
			);
		},
	};
}

export function createRemoteMemberIdleWaitOperation(endpoint: string): MemberIdleWaitOperation {
	return {
		waitForMemberIdle(member, options) {
			if (member.trim() !== member || member.length === 0) throw new BebopClientError("invalid-input");
			return withMemberIdleWaitBudget(
				options,
				async (budget, timeoutSeconds) => {
					const outcome = await sendMemberIdleWait(
						endpoint,
						{ type: "member_idle_wait", member },
						{ timeoutSeconds, signal: budget.signal },
					);
					if (outcome.ok === true) return outcome.result;
					switch (outcome.code) {
						case "timeout":
							throw new DeadlineExceeded();
						case "aborted":
							if (budget.timedOut()) throw new DeadlineExceeded();
							throw new BebopClientError("aborted");
						case "offline":
							throw new BebopClientError("offline-member");
						case "capacity-exceeded":
							throw new BebopClientError("capacity-exceeded");
						case "remote-rejected":
							throw new BebopClientError("remote-rejected");
						case "identity-mismatch":
							throw new BebopClientError("identity-mismatch");
						case "malformed-response":
							throw new BebopClientError("malformed-response");
						case "transport-error":
							throw new BebopClientError(
								outcome.transportCode === "ENOENT" ? "unknown-session" : "offline-session",
							);
					}
				},
				systemClock,
			);
		},
	};
}
