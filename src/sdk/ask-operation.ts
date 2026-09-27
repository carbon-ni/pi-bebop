import type { MemberStatusIdentity } from "./index.ts";
import { BebopClientError } from "./errors.ts";
import type { MemberRequestOperation } from "./member-request-operation.ts";

type AskRequestOperation = Pick<MemberRequestOperation, "startMemberRequest" | "waitForRequestOutcome">;

const DEFAULT_RESPONSE_GRACE_SECONDS = 30;
const MAX_RESPONSE_GRACE_SECONDS = 600;
const DEFAULT_TOTAL_WAIT_SECONDS = 120;
const MIN_TOTAL_WAIT_SECONDS = 2;
const DEFAULT_MAX_TOTAL_WAIT_SECONDS = 1_800;
const MIN_REQUEST_TIMEOUT_MS = 50;

export type AskPendingPolicy = "rewait" | "timeout-after-idle";
export type AskAcceptedAbortPolicy = "outcome-unknown" | "aborted";

export interface AskOperationPolicy {
	readonly pending: AskPendingPolicy;
	readonly acceptedAbort: AskAcceptedAbortPolicy;
	readonly maxTotalWaitSeconds?: number;
	/** Bounds start/acceptance delivery separately from the end-to-end budget. */
	readonly deliveryTimeoutMs?: number;
}

export interface AskOperation {
	ask(member: string, input: AskInput, options?: AskOptions): Promise<AskResult>;
}

export interface AskInput {
	readonly question: string;
	readonly instructions?: readonly string[];
	/** Required when the selected source uses an approved Guest route. */
	readonly crew?: string;
}

export interface AskOptions {
	readonly signal?: AbortSignal;
	readonly responseGraceSeconds?: number;
	readonly totalWaitSeconds?: number;
}

export type AskResult =
	| {
			readonly status: "answered";
			readonly code: "response";
			readonly accepted: true;
			readonly answered: true;
			readonly safeRetry: false;
			readonly member: MemberStatusIdentity;
			readonly message: string;
			readonly instructions: readonly string[];
			readonly requestAgeMs?: number;
	  }
	| {
			readonly status: "offline";
			readonly code: "offline-member";
			readonly accepted: true;
			readonly answered: false;
			readonly safeRetry: false;
			readonly member: MemberStatusIdentity;
	  }
	| {
			readonly status: "timeout";
			readonly code: "timeout-after-idle" | "timeout-total";
			readonly accepted: true;
			readonly answered: false;
			readonly safeRetry: false;
			readonly member: MemberStatusIdentity;
	  };

interface AskBudget {
	readonly signal: AbortSignal;
	readonly remaining: () => number;
	readonly timedOut: () => boolean;
	cleanup(): void;
}

function invalidInput(): never {
	throw new BebopClientError("invalid-input");
}

function validateInput(member: string, input: AskInput): void {
	if (
		typeof member !== "string" ||
		member.length === 0 ||
		member.trim() !== member ||
		member.includes("\0") ||
		Buffer.byteLength(member, "utf8") > 256 ||
		!input ||
		typeof input.question !== "string" ||
		input.question.trim().length === 0 ||
		input.question.includes("\0")
	)
		return invalidInput();
	if (input.instructions !== undefined) {
		if (!Array.isArray(input.instructions) || input.instructions.length > 32) return invalidInput();
		if (
			input.instructions.some((instruction) => typeof instruction !== "string" || instruction.trim().length === 0)
		)
			return invalidInput();
	}
	if (input.crew !== undefined && (typeof input.crew !== "string" || input.crew.trim() !== input.crew))
		return invalidInput();
}

function validateOptions(options: AskOptions | undefined, policy: AskOperationPolicy) {
	const responseGraceSeconds = options?.responseGraceSeconds ?? DEFAULT_RESPONSE_GRACE_SECONDS;
	const totalWaitSeconds = options?.totalWaitSeconds ?? DEFAULT_TOTAL_WAIT_SECONDS;
	const maxTotalWaitSeconds = policy.maxTotalWaitSeconds ?? DEFAULT_MAX_TOTAL_WAIT_SECONDS;
	if (
		!Number.isInteger(responseGraceSeconds) ||
		responseGraceSeconds < 1 ||
		responseGraceSeconds > MAX_RESPONSE_GRACE_SECONDS ||
		!Number.isInteger(totalWaitSeconds) ||
		totalWaitSeconds < MIN_TOTAL_WAIT_SECONDS ||
		totalWaitSeconds > maxTotalWaitSeconds ||
		totalWaitSeconds <= responseGraceSeconds
	)
		return invalidInput();
	return { responseGraceSeconds, totalWaitSeconds };
}

function createBudget(options: AskOptions | undefined, totalWaitSeconds: number): AskBudget {
	if (options?.signal?.aborted) throw new BebopClientError("aborted");
	const controller = new AbortController();
	let expired = false;
	const startedAt = Date.now();
	const onAbort = () => controller.abort(options?.signal?.reason);
	options?.signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => {
		expired = true;
		controller.abort(new Error("Ask timed out"));
	}, totalWaitSeconds * 1000);
	return {
		signal: controller.signal,
		remaining: () => Math.max(MIN_REQUEST_TIMEOUT_MS, totalWaitSeconds * 1000 - (Date.now() - startedAt)),
		timedOut: () => expired,
		cleanup() {
			clearTimeout(timer);
			options?.signal?.removeEventListener("abort", onAbort);
		},
	};
}

function requestTimeout(budget: AskBudget): number {
	if (budget.signal.aborted)
		throw budget.timedOut() ? new BebopClientError("timeout") : new BebopClientError("aborted");
	return Math.ceil(budget.remaining());
}

function timeoutResult(member: MemberStatusIdentity, code: "timeout-after-idle" | "timeout-total"): AskResult {
	return { status: "timeout", code, accepted: true, answered: false, safeRetry: false, member };
}

function routeLost(error: BebopClientError): BebopClientError {
	if (
		error.code === "offline-session" ||
		error.code === "unknown-session" ||
		error.code === "transport-error" ||
		error.code === "outcome-unknown"
	)
		return new BebopClientError("route-lost", error.message);
	return error;
}

export function createAskOperation(dependencies: {
	readonly request: AskRequestOperation;
	readonly policy: AskOperationPolicy;
}): AskOperation {
	return {
		async ask(member, input, options) {
			validateInput(member, input);
			const settings = validateOptions(options, dependencies.policy);
			const budget = createBudget(options, settings.totalWaitSeconds);
			let acceptedMember: MemberStatusIdentity | undefined;
			try {
				const started = await dependencies.request.startMemberRequest(
					member,
					{
						message: input.question,
						...(input.instructions === undefined ? {} : { instructions: [...input.instructions] }),
						timeoutSeconds: settings.responseGraceSeconds,
						maxWaitSeconds: Math.max(60, settings.totalWaitSeconds),
						...(input.crew === undefined ? {} : { crew: input.crew }),
					},
					{
						signal: budget.signal,
						timeoutMs: Math.min(
							dependencies.policy.deliveryTimeoutMs ?? requestTimeout(budget),
							requestTimeout(budget),
						),
					},
				);
				acceptedMember = started.member;
				for (;;) {
					const outcome = await dependencies.request.waitForRequestOutcome(started.requestId, {
						signal: budget.signal,
						timeoutMs: requestTimeout(budget),
					});
					if (outcome.kind === "pending") {
						if (dependencies.policy.pending === "timeout-after-idle")
							return timeoutResult(acceptedMember, "timeout-after-idle");
						continue;
					}
					if (outcome.kind === "response")
						return {
							status: "answered",
							code: "response",
							accepted: true,
							answered: true,
							safeRetry: false,
							member: outcome.member,
							message: outcome.message,
							instructions: [...outcome.instructions],
							...(outcome.requestAgeMs === undefined ? {} : { requestAgeMs: outcome.requestAgeMs }),
						};
					if (outcome.kind === "offline")
						return {
							status: "offline",
							code: "offline-member",
							accepted: true,
							answered: false,
							safeRetry: false,
							member: outcome.member,
						};
					return timeoutResult(outcome.member, "timeout-total");
				}
			} catch (error) {
				const clientError = error instanceof BebopClientError ? error : new BebopClientError("transport-error");
				if (acceptedMember !== undefined) {
					if (clientError.code === "timeout" || budget.timedOut())
						return timeoutResult(acceptedMember, "timeout-total");
					if (clientError.code === "aborted") {
						if (dependencies.policy.acceptedAbort === "outcome-unknown")
							throw new BebopClientError("outcome-unknown");
						throw clientError;
					}
					throw routeLost(clientError);
				}
				if (clientError.code === "outcome-unknown" || clientError.code === "timeout")
					throw new BebopClientError("outcome-unknown");
				throw routeLost(clientError);
			} finally {
				budget.cleanup();
			}
		},
	};
}
