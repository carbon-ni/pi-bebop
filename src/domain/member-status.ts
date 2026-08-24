import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/**
 * Privacy-safe Member Status domain contract.
 *
 * Presence is endpoint reachability. Activity is mechanical live Pi control
 * flow. Focus is optional member-authored crew-visible text. None implies
 * availability, health, productivity, or completed work.
 */

const MEMBER_STATUS_VERSION = 1 as const;
export const MEMBER_FOCUS_ENTRY_TYPE = "bebop-member-focus";
export const MAX_MEMBER_FOCUS_BYTES = 256;
const MAX_MEMBER_STATUS_LABEL_BYTES = 256;
const MAX_MEMBER_IDENTITY_BYTES = 4096;

const ISO_TIMESTAMP_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$";
const IsoTimestampSchema = Type.String({ pattern: ISO_TIMESTAMP_PATTERN });
const PublicLabelSchema = Type.String({ minLength: 1, maxLength: MAX_MEMBER_STATUS_LABEL_BYTES });

const MemberStatusIdentitySchema = Type.Object(
	{ name: PublicLabelSchema, role: PublicLabelSchema },
	{ additionalProperties: false },
);
const ReportedMemberFocusSchema = Type.Object(
	{
		state: Type.Literal("reported"),
		text: Type.String({ minLength: 1, maxLength: MAX_MEMBER_FOCUS_BYTES }),
		updatedAt: IsoTimestampSchema,
	},
	{ additionalProperties: false },
);
const UnspecifiedMemberFocusSchema = Type.Object(
	{ state: Type.Literal("unspecified") },
	{ additionalProperties: false },
);
const UnavailableMemberFocusSchema = Type.Object(
	{ state: Type.Literal("unavailable") },
	{ additionalProperties: false },
);
const AvailableMemberFocusSchema = Type.Union([ReportedMemberFocusSchema, UnspecifiedMemberFocusSchema]);

const OnlineMemberStatusSchema = Type.Object(
	{
		member: MemberStatusIdentitySchema,
		presence: Type.Literal("online"),
		activity: Type.Union([Type.Literal("idle"), Type.Literal("busy"), Type.Literal("compacting")]),
		hasPendingMessages: Type.Boolean(),
		focus: AvailableMemberFocusSchema,
		observedAt: IsoTimestampSchema,
	},
	{ additionalProperties: false },
);
const OfflineMemberStatusSchema = Type.Object(
	{
		member: MemberStatusIdentitySchema,
		presence: Type.Literal("offline"),
		activity: Type.Literal("unavailable"),
		hasPendingMessages: Type.Literal("unavailable"),
		focus: UnavailableMemberFocusSchema,
		observedAt: IsoTimestampSchema,
	},
	{ additionalProperties: false },
);
export const MemberStatusSchema = Type.Union([OnlineMemberStatusSchema, OfflineMemberStatusSchema]);

const SetMemberFocusEntryDataSchema = Type.Object(
	{
		version: Type.Literal(MEMBER_STATUS_VERSION),
		memberIdentity: Type.String({ minLength: 1, maxLength: MAX_MEMBER_IDENTITY_BYTES }),
		action: Type.Literal("set"),
		focus: Type.String({ minLength: 1, maxLength: MAX_MEMBER_FOCUS_BYTES }),
		updatedAt: IsoTimestampSchema,
	},
	{ additionalProperties: false },
);
const ClearMemberFocusEntryDataSchema = Type.Object(
	{
		version: Type.Literal(MEMBER_STATUS_VERSION),
		memberIdentity: Type.String({ minLength: 1, maxLength: MAX_MEMBER_IDENTITY_BYTES }),
		action: Type.Literal("clear"),
		updatedAt: IsoTimestampSchema,
	},
	{ additionalProperties: false },
);
export const MemberFocusEntryDataSchema = Type.Union([SetMemberFocusEntryDataSchema, ClearMemberFocusEntryDataSchema]);

export type MemberStatusIdentity = Static<typeof MemberStatusIdentitySchema>;
export type ReportedMemberFocus = Static<typeof ReportedMemberFocusSchema>;
export type UnspecifiedMemberFocus = Static<typeof UnspecifiedMemberFocusSchema>;
export type UnavailableMemberFocus = Static<typeof UnavailableMemberFocusSchema>;
export type AvailableMemberFocus = Static<typeof AvailableMemberFocusSchema>;
export type OnlineMemberStatus = Static<typeof OnlineMemberStatusSchema>;
export type OfflineMemberStatus = Static<typeof OfflineMemberStatusSchema>;
export type MemberStatus = Static<typeof MemberStatusSchema>;
export type MemberActivity = OnlineMemberStatus["activity"];
export type MemberFocusEntryData = Static<typeof MemberFocusEntryDataSchema>;

export interface CreateMemberFocusEntryDataInput {
	readonly memberIdentity: string;
	readonly action: "set" | "clear";
	readonly focus?: string;
	readonly updatedAt: string;
}

const UTF8_ENCODER = new TextEncoder();
const utf8Bytes = (value: string): number => UTF8_ENCODER.encode(value).byteLength;
const containsUnsafeLineContent = (value: string): boolean => /[\0\r\n]/u.test(value);
const isSafeBoundedText = (value: string, limit: number): boolean =>
	value.trim().length > 0 && value === value.trim() && !containsUnsafeLineContent(value) && utf8Bytes(value) <= limit;

function isIsoTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || !new RegExp(ISO_TIMESTAMP_PATTERN, "u").test(value)) return false;
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isStatusIdentity(value: MemberStatusIdentity): boolean {
	return (
		isSafeBoundedText(value.name, MAX_MEMBER_STATUS_LABEL_BYTES) &&
		isSafeBoundedText(value.role, MAX_MEMBER_STATUS_LABEL_BYTES)
	);
}

function isMemberIdentity(value: unknown): value is string {
	return typeof value === "string" && isSafeBoundedText(value, MAX_MEMBER_IDENTITY_BYTES);
}

function isReportedFocus(value: ReportedMemberFocus): boolean {
	return isSafeBoundedText(value.text, MAX_MEMBER_FOCUS_BYTES) && isIsoTimestamp(value.updatedAt);
}

export function deriveMemberActivity(isIdle: boolean, isCompacting = false): MemberActivity {
	if (isCompacting) return "compacting";
	return isIdle ? "idle" : "busy";
}

export function isMemberFocusEntryData(value: unknown): value is MemberFocusEntryData {
	if (!Value.Check(MemberFocusEntryDataSchema, value)) return false;
	const data = value as MemberFocusEntryData;
	if (!isMemberIdentity(data.memberIdentity) || !isIsoTimestamp(data.updatedAt)) return false;
	return data.action === "clear" || isSafeBoundedText(data.focus, MAX_MEMBER_FOCUS_BYTES);
}

export function createMemberFocusEntryData(input: CreateMemberFocusEntryDataInput): MemberFocusEntryData {
	const candidate = {
		version: MEMBER_STATUS_VERSION,
		memberIdentity: input.memberIdentity,
		action: input.action,
		...(input.action === "set" || input.focus !== undefined ? { focus: input.focus } : {}),
		updatedAt: input.updatedAt,
	};
	if (!isMemberFocusEntryData(candidate)) throw new TypeError("invalid member focus entry");
	return candidate;
}

/** Restore the latest valid Focus event for the exact current canonical member identity. */
export function restoreMemberFocus(entries: readonly unknown[], memberIdentity: string): AvailableMemberFocus {
	if (!isMemberIdentity(memberIdentity)) throw new TypeError("invalid member identity");
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const value = entries[index];
		if (typeof value !== "object" || value === null) continue;
		const entry = value as { type?: unknown; customType?: unknown; data?: unknown };
		if (entry.type !== "custom" || entry.customType !== MEMBER_FOCUS_ENTRY_TYPE) continue;
		if (!isMemberFocusEntryData(entry.data) || entry.data.memberIdentity !== memberIdentity) continue;
		if (entry.data.action === "clear") return { state: "unspecified" };
		return { state: "reported", text: entry.data.focus, updatedAt: entry.data.updatedAt };
	}
	return { state: "unspecified" };
}

export function isMemberStatus(value: unknown): value is MemberStatus {
	if (!Value.Check(MemberStatusSchema, value)) return false;
	const status = value as MemberStatus;
	if (!isStatusIdentity(status.member) || !isIsoTimestamp(status.observedAt)) return false;
	if (status.presence === "offline") return status.focus.state === "unavailable";
	return status.focus.state !== "reported" || isReportedFocus(status.focus);
}

export function createOnlineMemberStatus(input: {
	readonly member: MemberStatusIdentity;
	readonly isIdle: boolean;
	readonly isCompacting?: boolean;
	readonly hasPendingMessages: boolean;
	readonly focus: AvailableMemberFocus;
	readonly observedAt: string;
}): OnlineMemberStatus {
	if (
		typeof input.isIdle !== "boolean" ||
		(input.isCompacting !== undefined && typeof input.isCompacting !== "boolean") ||
		typeof input.hasPendingMessages !== "boolean"
	) {
		throw new TypeError("invalid online member status");
	}
	const status: OnlineMemberStatus = {
		member: input.member,
		presence: "online",
		activity: deriveMemberActivity(input.isIdle, input.isCompacting ?? false),
		hasPendingMessages: input.hasPendingMessages,
		focus: input.focus,
		observedAt: input.observedAt,
	};
	if (!isMemberStatus(status)) throw new TypeError("invalid online member status");
	return status;
}

export function createOfflineMemberStatus(member: MemberStatusIdentity, observedAt: string): OfflineMemberStatus {
	const status: OfflineMemberStatus = {
		member,
		presence: "offline",
		activity: "unavailable",
		hasPendingMessages: "unavailable",
		focus: { state: "unavailable" },
		observedAt,
	};
	if (!isMemberStatus(status)) throw new TypeError("invalid offline member status");
	return status;
}

export function formatMemberStatus(status: MemberStatus): string {
	if (!isMemberStatus(status)) throw new TypeError("invalid member status");
	const member = `${status.member.name} (${status.member.role})`;
	if (status.presence === "offline") return `${member} — offline — activity unavailable — Focus: unavailable`;
	const pending = status.hasPendingMessages ? " — pending messages" : "";
	const focus =
		status.focus.state === "reported" ? `Focus (member-reported): ${status.focus.text}` : "Focus: unspecified";
	return `${member} — online — ${status.activity}${pending} — ${focus}`;
}
