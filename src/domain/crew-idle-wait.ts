import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const MIN_CREW_IDLE_WAIT_TIMEOUT = 60;
export const MAX_CREW_IDLE_WAIT_TIMEOUT = 7200;
export const MAX_CREW_IDLE_WAIT_MEMBERS = 64;
const MEMBER_LABEL = Type.String({ minLength: 1, maxLength: 256 });
const ISO_TIMESTAMP_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$";
const OBSERVED_AT = Type.String({ pattern: ISO_TIMESTAMP_PATTERN });
const TIMEOUT = Type.Integer({ minimum: MIN_CREW_IDLE_WAIT_TIMEOUT, maximum: MAX_CREW_IDLE_WAIT_TIMEOUT });

export const CrewIdleWaitInputSchema = Type.Object(
	{
		members: Type.Optional(Type.Array(MEMBER_LABEL, { minItems: 1, maxItems: MAX_CREW_IDLE_WAIT_MEMBERS })),
		timeout_seconds: Type.Optional(TIMEOUT),
	},
	{ additionalProperties: false },
);
export type CrewIdleWaitInput = Static<typeof CrewIdleWaitInputSchema>;

const IdentitySchema = Type.Object({ name: MEMBER_LABEL, role: MEMBER_LABEL }, { additionalProperties: false });
const BlockerSchema = Type.Object(
	{
		member: IdentitySchema,
		status: Type.Union([
			Type.Literal("busy"),
			Type.Literal("compacting"),
			Type.Literal("offline"),
			Type.Literal("unknown"),
		]),
		observedAt: OBSERVED_AT,
	},
	{ additionalProperties: false },
);
export const CrewIdleWaitResultSchema = Type.Object(
	{
		scope: Type.Union([Type.Literal("all"), Type.Literal("selected")]),
		members: Type.Array(IdentitySchema, { maxItems: MAX_CREW_IDLE_WAIT_MEMBERS }),
		coversAllOtherMembers: Type.Boolean(),
		outcome: Type.Union([
			Type.Literal("ready"),
			Type.Literal("offline"),
			Type.Literal("timeout"),
			Type.Literal("unstable"),
			Type.Literal("wait-lock"),
			Type.Literal("message-received"),
		]),
		reason: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
		blockers: Type.Optional(Type.Array(BlockerSchema, { maxItems: MAX_CREW_IDLE_WAIT_MEMBERS })),
		observedAt: OBSERVED_AT,
	},
	{ additionalProperties: false },
);
export type CrewIdleWaitResult = Static<typeof CrewIdleWaitResultSchema>;

export type CrewIdleMember = { name: string; role: string; socketPath: string };
export type CrewIdleMembership = {
	member: CrewIdleMember;
	manifest: { members: readonly CrewIdleMember[] };
};
export type CrewIdleSelection = {
	readonly scope: "all" | "selected";
	readonly targets: readonly CrewIdleMember[];
	readonly coversAllOtherMembers: boolean;
};
export type CrewIdleSelectionErrorCode =
	| "invalid-selection"
	| "empty-selection"
	| "duplicate-member"
	| "unknown-member"
	| "self-member"
	| "not-a-member";

export class CrewIdleWaitError extends Error {
	readonly code: CrewIdleSelectionErrorCode;

	constructor(code: CrewIdleSelectionErrorCode, message = code) {
		super(message);
		this.name = "CrewIdleWaitError";
		this.code = code;
	}
}

export function resolveCrewIdleSelection(
	membership: CrewIdleMembership,
	requested: readonly string[] | undefined,
): CrewIdleSelection {
	const ownName = membership.member.name;
	const others = membership.manifest.members.filter((member) => member.name !== ownName);
	if (requested === undefined) {
		return { scope: "all", targets: others, coversAllOtherMembers: true };
	}
	if (!Array.isArray(requested)) throw new CrewIdleWaitError("invalid-selection");
	if (requested.length === 0) throw new CrewIdleWaitError("empty-selection");
	if (requested.length > MAX_CREW_IDLE_WAIT_MEMBERS) throw new CrewIdleWaitError("invalid-selection");
	const names = new Set<string>();
	for (const name of requested) {
		if (typeof name !== "string" || name.length === 0 || name.trim() !== name) {
			throw new CrewIdleWaitError("invalid-selection");
		}
		if (names.has(name)) throw new CrewIdleWaitError("duplicate-member");
		names.add(name);
		if (name === ownName) throw new CrewIdleWaitError("self-member");
	}
	const targets = others.filter((member) => names.has(member.name));
	if (targets.length !== requested.length) throw new CrewIdleWaitError("unknown-member");
	return {
		scope: "selected",
		targets,
		coversAllOtherMembers: targets.length === others.length,
	};
}

export type CrewIdleBlockerStatus = "busy" | "compacting" | "offline" | "unknown";
export type CrewIdleBlocker = {
	readonly member: { readonly name: string; readonly role: string };
	readonly status: CrewIdleBlockerStatus;
	readonly observedAt: string;
};

export function isCrewIdleWaitResult(value: unknown): value is CrewIdleWaitResult {
	return Value.Check(CrewIdleWaitResultSchema, value);
}

export function createCrewIdleWaitResult(input: {
	selection: CrewIdleSelection;
	outcome: CrewIdleWaitResult["outcome"];
	reason?: string;
	blockers?: readonly CrewIdleBlocker[];
	observedAt: string;
}): CrewIdleWaitResult {
	const result: CrewIdleWaitResult = {
		scope: input.selection.scope,
		members: input.selection.targets.map(({ name, role }) => ({ name, role })),
		coversAllOtherMembers: input.selection.coversAllOtherMembers,
		outcome: input.outcome,
		...(input.reason ? { reason: input.reason } : {}),
		...(input.blockers && input.blockers.length > 0
			? { blockers: input.blockers.slice(0, MAX_CREW_IDLE_WAIT_MEMBERS) }
			: {}),
		observedAt: input.observedAt,
	};
	if (!isCrewIdleWaitResult(result)) throw new TypeError("invalid crew idle wait result");
	return result;
}
