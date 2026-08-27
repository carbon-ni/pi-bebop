import { createHash } from "node:crypto";
import type { CrewRetrospectiveConfig } from "./crew-manifest.ts";

/** TASK-0108: advisory, manual-only retrospective scheduling. */
export const CREW_RETROSPECTIVE_SCHEDULE_VERSION = 1 as const;
export const RETROSPECTIVE_DAY_MS = 86_400_000;
export const MAX_SCHEDULE_TIMESTAMP = Number.MAX_SAFE_INTEGER;

export type RetrospectiveScheduleStatus = "manual-only" | "not-due" | "due" | "open";
export type FacilitatorValidity = "valid" | "unavailable";

export interface RetrospectiveDueMarker {
	readonly id: string;
	readonly anchor: number;
	readonly dueAt: number;
	readonly cadenceDays: number;
	readonly facilitator: string;
}

export interface RetrospectiveScheduleState {
	readonly version: typeof CREW_RETROSPECTIVE_SCHEDULE_VERSION;
	readonly kind: "crew-retrospective-schedule";
	/** Created once when the first cadence-enabled config is observed. */
	readonly configuredAt?: number;
	readonly latestCompletedAt?: number;
	readonly dueMarker?: RetrospectiveDueMarker;
}

export interface RetrospectiveScheduleResult {
	readonly state: RetrospectiveScheduleState;
	readonly status: RetrospectiveScheduleStatus;
	readonly facilitator: FacilitatorValidity;
	readonly dueAt?: number;
	readonly clock: "normal" | "clock-before-anchor";
	readonly markerCreated: boolean;
}

export class CrewRetrospectiveScheduleError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CrewRetrospectiveScheduleError";
	}
}

function isSafeTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function assertTimestamp(value: unknown, field: string): asserts value is number {
	if (!isSafeTimestamp(value))
		throw new CrewRetrospectiveScheduleError(`${field} must be a non-negative safe integer`);
}

function assertConfig(config: CrewRetrospectiveConfig): void {
	if (!config || typeof config !== "object") throw new CrewRetrospectiveScheduleError("invalid retrospective config");
	if (
		typeof config.facilitator !== "string" ||
		config.facilitator.trim() !== config.facilitator ||
		!config.facilitator
	)
		throw new CrewRetrospectiveScheduleError("retrospective facilitator must be an exact Member name");
	if (
		config.cadenceDays !== undefined &&
		(!Number.isSafeInteger(config.cadenceDays) || config.cadenceDays < 1 || config.cadenceDays > 365)
	)
		throw new CrewRetrospectiveScheduleError("retrospective cadenceDays must be an integer from 1 to 365");
}

function checkedDueAt(anchor: number, cadenceDays: number): number {
	const duration = cadenceDays * RETROSPECTIVE_DAY_MS;
	if (!Number.isSafeInteger(duration) || anchor > MAX_SCHEDULE_TIMESTAMP - duration)
		throw new CrewRetrospectiveScheduleError("retrospective due instant overflows safe timestamp range");
	return anchor + duration;
}

function markerId(anchor: number, dueAt: number, cadenceDays: number, facilitator: string): string {
	const digest = createHash("sha256")
		.update(`${anchor}|${dueAt}|${cadenceDays}|${facilitator}`, "utf8")
		.digest("hex");
	return `retro-due-${digest.slice(0, 32)}`;
}

function validateMarker(marker: RetrospectiveDueMarker): void {
	if (!marker || typeof marker.id !== "string" || !/^retro-due-[a-f0-9]{32}$/.test(marker.id))
		throw new CrewRetrospectiveScheduleError("invalid retrospective due marker id");
	assertTimestamp(marker.anchor, "due marker anchor");
	assertTimestamp(marker.dueAt, "due marker dueAt");
	if (!Number.isSafeInteger(marker.cadenceDays) || marker.cadenceDays < 1 || marker.cadenceDays > 365)
		throw new CrewRetrospectiveScheduleError("invalid retrospective due marker cadence");
	if (marker.dueAt !== checkedDueAt(marker.anchor, marker.cadenceDays))
		throw new CrewRetrospectiveScheduleError("due marker does not match its anchor and cadence");
	if (
		typeof marker.facilitator !== "string" ||
		!marker.facilitator ||
		marker.facilitator.trim() !== marker.facilitator
	)
		throw new CrewRetrospectiveScheduleError("invalid retrospective due marker facilitator");
	if (marker.id !== markerId(marker.anchor, marker.dueAt, marker.cadenceDays, marker.facilitator))
		throw new CrewRetrospectiveScheduleError("retrospective due marker identity mismatch");
}

function validateStateShape(input: unknown): Record<string, unknown> {
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw new CrewRetrospectiveScheduleError("invalid retrospective schedule state");
	const value = input as Record<string, unknown>;
	if (value.version !== CREW_RETROSPECTIVE_SCHEDULE_VERSION || value.kind !== "crew-retrospective-schedule")
		throw new CrewRetrospectiveScheduleError("unsupported retrospective schedule state");
	const supported = new Set(["version", "kind", "configuredAt", "latestCompletedAt", "dueMarker"]);
	if (Object.keys(value).some((key) => !supported.has(key)))
		throw new CrewRetrospectiveScheduleError("unsupported retrospective schedule field");
	return value;
}

function validateStateTimes(value: Record<string, unknown>): { configuredAt?: number; latestCompletedAt?: number } {
	const configuredAt = value.configuredAt as number | undefined;
	const latestCompletedAt = value.latestCompletedAt as number | undefined;
	if (configuredAt !== undefined) assertTimestamp(configuredAt, "configuredAt");
	if (latestCompletedAt !== undefined) assertTimestamp(latestCompletedAt, "latestCompletedAt");
	if (configuredAt !== undefined && latestCompletedAt !== undefined && latestCompletedAt < configuredAt)
		throw new CrewRetrospectiveScheduleError("latest completion precedes configuredAt");
	return {
		...(configuredAt === undefined ? {} : { configuredAt }),
		...(latestCompletedAt === undefined ? {} : { latestCompletedAt }),
	};
}

export function validateRetrospectiveScheduleState(input: unknown): RetrospectiveScheduleState {
	const value = validateStateShape(input);
	const times = validateStateTimes(value);
	const dueMarker = value.dueMarker as RetrospectiveDueMarker | undefined;
	if (dueMarker !== undefined) validateMarker(dueMarker);
	return {
		version: CREW_RETROSPECTIVE_SCHEDULE_VERSION,
		kind: "crew-retrospective-schedule",
		...times,
		...(dueMarker === undefined ? {} : { dueMarker }),
	};
}

export function emptyRetrospectiveSchedule(): RetrospectiveScheduleState {
	return { version: CREW_RETROSPECTIVE_SCHEDULE_VERSION, kind: "crew-retrospective-schedule" };
}

function result(
	state: RetrospectiveScheduleState,
	status: RetrospectiveScheduleStatus,
	input: { readonly facilitatorExists: boolean },
	options: {
		readonly dueAt?: number;
		readonly clock?: "normal" | "clock-before-anchor";
		readonly markerCreated?: boolean;
	} = {},
): RetrospectiveScheduleResult {
	return {
		state,
		status,
		facilitator: input.facilitatorExists ? "valid" : "unavailable",
		...(options.dueAt === undefined ? {} : { dueAt: options.dueAt }),
		clock: options.clock ?? "normal",
		markerCreated: options.markerCreated ?? false,
	};
}

function hasCadence(
	config: CrewRetrospectiveConfig | undefined,
): config is CrewRetrospectiveConfig & { readonly cadenceDays: number } {
	return config !== undefined && config.cadenceDays !== undefined;
}

/** Pure due derivation. An open round wins and never creates a marker. */
export function deriveRetrospectiveSchedule(input: {
	readonly config?: CrewRetrospectiveConfig;
	readonly state: RetrospectiveScheduleState;
	readonly now: number;
	readonly openRound: boolean;
	readonly facilitatorExists: boolean;
}): RetrospectiveScheduleResult {
	const state = validateRetrospectiveScheduleState(input.state);
	assertTimestamp(input.now, "now");
	if (input.config !== undefined) assertConfig(input.config);
	if (!hasCadence(input.config)) return result(state, input.openRound ? "open" : "manual-only", input);
	const configuredAt = state.configuredAt ?? input.now;
	const effectiveState: RetrospectiveScheduleState =
		state.configuredAt === undefined ? { ...state, configuredAt } : state;
	const anchor = effectiveState.latestCompletedAt ?? configuredAt;
	const dueAt = effectiveState.dueMarker?.dueAt ?? checkedDueAt(anchor, input.config.cadenceDays);
	const clock = input.now < anchor ? "clock-before-anchor" : "normal";
	if (input.openRound) return result(effectiveState, "open", input, { dueAt, clock });
	if (effectiveState.dueMarker) return result(effectiveState, "due", input, { dueAt, clock });
	if (input.now < dueAt) return result(effectiveState, "not-due", input, { dueAt, clock });
	const dueMarker: RetrospectiveDueMarker = {
		id: markerId(anchor, dueAt, input.config.cadenceDays, input.config.facilitator),
		anchor,
		dueAt,
		cadenceDays: input.config.cadenceDays,
		facilitator: input.config.facilitator,
	};
	return result({ ...effectiveState, dueMarker }, "due", input, { dueAt, clock, markerCreated: true });
}

/** Advance the schedule only after an explicit round completion. */
export function recordRetrospectiveCompletion(
	state: RetrospectiveScheduleState,
	completedAt: number,
): RetrospectiveScheduleState {
	const validated = validateRetrospectiveScheduleState(state);
	assertTimestamp(completedAt, "completedAt");
	if (validated.latestCompletedAt !== undefined && completedAt < validated.latestCompletedAt)
		throw new CrewRetrospectiveScheduleError("completion moves backward");
	return {
		version: validated.version,
		kind: validated.kind,
		...(validated.configuredAt === undefined ? {} : { configuredAt: validated.configuredAt }),
		latestCompletedAt: completedAt,
	};
}

export function retrospectiveReminderId(marker: RetrospectiveDueMarker): string {
	return marker.id;
}

export function buildRetrospectiveDueReminder(marker: RetrospectiveDueMarker): {
	readonly message: string;
	readonly instructions: readonly string[];
} {
	const utc = (value: number) => new Date(value).toISOString();
	return {
		message: [
			"Crew Retrospective is due.",
			`Anchor: ${utc(marker.anchor)}`,
			`Due at: ${utc(marker.dueAt)}`,
			`Cadence: ${marker.cadenceDays} days of 24 hours`,
			`Facilitator: ${marker.facilitator}`,
			"No round was started by this reminder.",
			"Inspect Retrospective status, then explicitly start the round when ready.",
			"If this facilitator is unavailable, a trusted project operator must perform exact takeover.",
			"A candidate revision, if any, still requires separate trusted Agreement activation.",
		].join("\n"),
		instructions: ["This reminder is informational only; it does not start a round or activate Agreements."],
	};
}
