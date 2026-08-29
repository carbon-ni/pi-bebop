import {
	createCrewIdleWaitResult,
	detectCrewIdleLock,
	resolveCrewIdleSelection,
	CrewIdleWaitError,
	type CrewIdleMember,
	type CrewIdleMembership,
	type CrewIdleSelection,
	type CrewIdleWaitResult,
	type CrewIdleBlocker,
	type CrewIdleWaitInput,
	type BlockingWaitMarker,
	type MemberStatus,
	type WaitStateSnapshot,
} from "../domain/index.ts";

export type CrewIdleWaitFlowErrorCode =
	| "not-joined"
	| "untrusted"
	| "invalid-timeout"
	| "invalid-selection"
	| "empty-selection"
	| "duplicate-member"
	| "unknown-member"
	| "self-member"
	| "not-a-member"
	| "malformed-response"
	| "capacity-exceeded"
	| "transport-error"
	| "aborted"
	| "membership-lost";

export class CrewIdleWaitFlowError extends Error {
	readonly code: CrewIdleWaitFlowErrorCode;
	constructor(code: CrewIdleWaitFlowErrorCode, message: string = code) {
		super(message);
		this.name = "CrewIdleWaitFlowError";
		this.code = code;
	}
}

export type CrewIdleStatusTransportResult =
	| { readonly ok: true; readonly status: MemberStatus }
	| { readonly ok: false; readonly code: string };
export type CrewIdleMemberWaitTransportResult =
	| { readonly ok: true; readonly outcome: "became-idle" | "already-idle" | "message-received" }
	| { readonly ok: false; readonly code: string };
export type CrewIdleWaitStateTransportResult =
	| { readonly ok: true; readonly snapshot: WaitStateSnapshot }
	| { readonly ok: false; readonly code: string };

export interface CrewIdleWaitSurface {
	readonly getMembership: () => CrewIdleMembership | null;
	readonly isTrusted: () => boolean;
	readonly now: () => string;
	readonly nowMs?: () => number;
	readonly requestStatus: (member: CrewIdleMember, signal: AbortSignal) => Promise<CrewIdleStatusTransportResult>;
	readonly requestWaitState: (
		member: CrewIdleMember,
		options: { signal: AbortSignal; onTransition: (snapshot: WaitStateSnapshot) => void },
	) => Promise<CrewIdleWaitStateTransportResult>;
	readonly requestMemberIdle: (
		member: CrewIdleMember,
		options: { timeoutSeconds: number; signal: AbortSignal },
	) => Promise<CrewIdleMemberWaitTransportResult>;
}

export type CrewIdleWaitInputWithCaller = CrewIdleWaitInput & {
	readonly callerWait?: BlockingWaitMarker | null;
	readonly signal?: AbortSignal;
};

const DEFAULT_TIMEOUT = 1800;
const DEFAULT_ROUND_CAP = 3;

function timeoutSeconds(value: number | undefined): number {
	if (value === undefined) return DEFAULT_TIMEOUT;
	if (!Number.isInteger(value) || value < 60 || value > 7200) throw new CrewIdleWaitFlowError("invalid-timeout");
	return value;
}
function identity(member: CrewIdleMember): { name: string; role: string } {
	return { name: member.name, role: member.role };
}
function mapTransportError(code: string): CrewIdleWaitFlowErrorCode {
	if (code === "capacity-exceeded") return "capacity-exceeded";
	if (code === "malformed-response") return "malformed-response";
	if (code === "aborted") return "aborted";
	return "transport-error";
}
function mapSelectionError(error: unknown): never {
	if (error instanceof CrewIdleWaitError) {
		throw new CrewIdleWaitFlowError(String(error.code) as CrewIdleWaitFlowErrorCode, error.message);
	}
	throw error;
}
function blocker(member: CrewIdleMember, status: MemberStatus): CrewIdleBlocker | null {
	if (status.presence === "offline")
		return { member: identity(member), status: "offline", observedAt: status.observedAt };
	if (status.activity === "busy" || status.activity === "compacting")
		return { member: identity(member), status: status.activity, observedAt: status.observedAt };
	return null;
}
function blockersFor(targets: readonly CrewIdleMember[], statuses: readonly MemberStatus[]): CrewIdleBlocker[] {
	return statuses.flatMap((status, index) => {
		const item = blocker(targets[index], status);
		return item ? [item] : [];
	});
}
function firstOffline(targets: readonly CrewIdleMember[], statuses: readonly MemberStatus[]): CrewIdleBlocker | null {
	return blockersFor(targets, statuses).find((item) => item.status === "offline") ?? null;
}
function assertStatus(target: CrewIdleMember, outcome: CrewIdleStatusTransportResult): MemberStatus {
	if ("code" in outcome) throw new CrewIdleWaitFlowError(mapTransportError(outcome.code));
	if (outcome.status.member.name !== target.name || outcome.status.member.role !== target.role)
		throw new CrewIdleWaitFlowError("malformed-response");
	return outcome.status;
}
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(new CrewIdleWaitFlowError("aborted"));
	const aborted = new Promise<never>((_, reject) =>
		signal.addEventListener("abort", () => reject(new CrewIdleWaitFlowError("aborted")), { once: true }),
	);
	return Promise.race([work, aborted]);
}
async function collectStatuses(
	surface: CrewIdleWaitSurface,
	targets: readonly CrewIdleMember[],
	signal: AbortSignal,
): Promise<MemberStatus[]> {
	const responses = await Promise.all(
		targets.map((target) => abortable(surface.requestStatus(target, signal), signal)),
	);
	return responses.map((response, index) => assertStatus(targets[index], response));
}
function detectLock(
	selection: CrewIdleSelection,
	callerWait: BlockingWaitMarker | null | undefined,
	callerName: string,
	manifestMembers: readonly CrewIdleMember[],
	states: ReadonlyMap<string, WaitStateSnapshot>,
): boolean {
	const observations = selection.targets.map((member) => {
		const snapshot = states.get(member.name);
		return snapshot
			? { name: member.name, status: "online" as const, wait: snapshot.wait }
			: { name: member.name, status: "missing" as const };
	});
	return detectCrewIdleLock({
		callerWait: callerWait ?? null,
		callerName,
		manifestMembers: manifestMembers.map((member) => ({ name: member.name })),
		selection: selection.targets.map((member) => member.name),
		observations,
	}).locked;
}
async function observeStates(
	surface: CrewIdleWaitSurface,
	targets: readonly CrewIdleMember[],
	signal: AbortSignal,
	onTransition: (snapshot: WaitStateSnapshot) => void,
	states: Map<string, WaitStateSnapshot>,
): Promise<void> {
	await Promise.all(
		targets.map(async (target) => {
			const response = await abortable(surface.requestWaitState(target, { signal, onTransition }), signal);

			if ("code" in response) throw new CrewIdleWaitFlowError(mapTransportError(response.code));
			if (response.snapshot.member.name !== target.name || response.snapshot.member.role !== target.role)
				throw new CrewIdleWaitFlowError("malformed-response");
			states.set(target.name, response.snapshot);
		}),
	);
}
function result(
	selection: CrewIdleSelection,
	outcome: CrewIdleWaitResult["outcome"],
	now: string,
	reason?: string,
	blockers?: readonly CrewIdleBlocker[],
): CrewIdleWaitResult {
	return createCrewIdleWaitResult({ selection, outcome, observedAt: now, reason, blockers });
}

async function runRounds(input: {
	surface: CrewIdleWaitSurface;
	selection: CrewIdleSelection;
	statuses: MemberStatus[];
	roundCap: number;
	deadline: number;
	signal: AbortSignal;
	now: () => string;
	nowMs: () => number;
	isLocked: () => boolean;
}): Promise<CrewIdleWaitResult> {
	let statuses = input.statuses;
	for (let round = 1; round <= input.roundCap; round += 1) {
		if (input.isLocked()) return result(input.selection, "wait-lock", input.now(), "crew-idle-lock");
		const blockers = blockersFor(input.selection.targets, statuses);
		if (blockers.length === 0)
			return result(input.selection, "ready", input.now(), round === 1 ? "initial-round" : "after-wait");
		const offline = blockers.find((item) => item.status === "offline");
		if (offline) return result(input.selection, "offline", input.now(), "target-offline", [offline]);
		if (round === input.roundCap) return result(input.selection, "unstable", input.now(), "round-cap", blockers);
		const remaining = Math.max(1, Math.ceil((input.deadline - input.nowMs()) / 1000));
		const waits = await Promise.all(
			statuses.map((status, index) =>
				blocker(input.selection.targets[index], status)
					? abortable(
							input.surface.requestMemberIdle(input.selection.targets[index], {
								timeoutSeconds: remaining,
								signal: input.signal,
							}),
							input.signal,
						)
					: Promise.resolve({ ok: true as const, outcome: "already-idle" as const }),
			),
		);
		if (input.isLocked()) return result(input.selection, "wait-lock", input.now(), "crew-idle-lock");
		for (const waitResult of waits) {
			if (!("code" in waitResult)) continue;
			if (waitResult.code === "timeout")
				return result(input.selection, "timeout", input.now(), "deadline", blockers);
			throw new CrewIdleWaitFlowError(mapTransportError(waitResult.code));
		}
		if (input.nowMs() >= input.deadline)
			return result(input.selection, "timeout", input.now(), "deadline", blockers);
		statuses = await collectStatuses(input.surface, input.selection.targets, input.signal);
	}
	return result(
		input.selection,
		"unstable",
		input.now(),
		"round-cap",
		blockersFor(input.selection.targets, statuses),
	);
}

function handleFlowError(input: {
	selection: CrewIdleSelection;
	surface: CrewIdleWaitSurface;
	lastStatuses: readonly MemberStatus[];
	lockTriggered: boolean;
	callerAborted: boolean;
	operation: AbortController;
	error: unknown;
}): CrewIdleWaitResult {
	if (input.lockTriggered) return result(input.selection, "wait-lock", input.surface.now(), "crew-idle-lock");
	if (input.callerAborted) throw new CrewIdleWaitFlowError("aborted");
	if (
		input.error instanceof CrewIdleWaitFlowError &&
		input.error.code === "aborted" &&
		input.operation.signal.aborted
	)
		return result(
			input.selection,
			"timeout",
			input.surface.now(),
			"deadline",
			blockersFor(input.selection.targets, input.lastStatuses),
		);
	if (input.error instanceof CrewIdleWaitFlowError) throw input.error;
	if (!input.operation.signal.aborted) throw new CrewIdleWaitFlowError("transport-error");
	return result(
		input.selection,
		"timeout",
		input.surface.now(),
		"deadline",
		blockersFor(input.selection.targets, input.lastStatuses),
	);
}

export function createCrewIdleWaitFlow(surface: CrewIdleWaitSurface, options: { roundCap?: number } = {}) {
	const roundCap =
		Number.isInteger(options.roundCap) && (options.roundCap ?? 0) > 0 ? options.roundCap! : DEFAULT_ROUND_CAP;
	const wait = async (input: CrewIdleWaitInputWithCaller = {}): Promise<CrewIdleWaitResult> => {
		const membership = surface.getMembership();
		if (!membership) throw new CrewIdleWaitFlowError("not-joined");
		if (!surface.isTrusted()) throw new CrewIdleWaitFlowError("untrusted");
		const timeout = timeoutSeconds(input.timeout_seconds);
		let selection: CrewIdleSelection;
		try {
			selection = resolveCrewIdleSelection(membership, input.members);
		} catch (error) {
			mapSelectionError(error);
		}
		if (selection.targets.length === 0)
			return result(selection, "no-other-members", surface.now(), "no-other-members");
		const operation = new AbortController();
		const nowMs = surface.nowMs ?? Date.now;
		const deadline = nowMs() + timeout * 1000;
		const states = new Map<string, WaitStateSnapshot>();
		let lockTriggered = false;
		let lastStatuses: MemberStatus[] = [];
		const triggerLock = (snapshot: WaitStateSnapshot) => {
			states.set(snapshot.member.name, snapshot);
			if (detectLock(selection, input.callerWait, membership.member.name, membership.manifest.members, states)) {
				lockTriggered = true;
				operation.abort();
			}
		};
		if (input.signal?.aborted) throw new CrewIdleWaitFlowError("aborted");
		const timeoutHandle = setTimeout(() => operation.abort(), timeout * 1000);
		const onAbort = () => operation.abort();
		input.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const statePromise = observeStates(surface, selection.targets, operation.signal, triggerLock, states);
			lastStatuses = await collectStatuses(surface, selection.targets, operation.signal);
			await statePromise;
			if (
				lockTriggered ||
				detectLock(selection, input.callerWait, membership.member.name, membership.manifest.members, states)
			)
				return result(selection, "wait-lock", surface.now(), "crew-idle-lock");
			if (firstOffline(selection.targets, lastStatuses)) {
				const offline = firstOffline(selection.targets, lastStatuses)!;
				return result(selection, "offline", surface.now(), "target-offline", [offline]);
			}
			return await runRounds({
				surface,
				selection,
				statuses: lastStatuses,
				roundCap,
				deadline,
				signal: operation.signal,
				now: surface.now,
				nowMs,
				isLocked: () =>
					lockTriggered ||
					detectLock(
						selection,
						input.callerWait,
						membership.member.name,
						membership.manifest.members,
						states,
					),
			});
		} catch (error) {
			return handleFlowError({
				selection,
				surface,
				lastStatuses,
				lockTriggered,
				callerAborted: input.signal?.aborted === true,
				operation,
				error,
			});
		} finally {
			clearTimeout(timeoutHandle);
			input.signal?.removeEventListener("abort", onAbort);
			operation.abort();
		}
	};
	return { wait };
}
