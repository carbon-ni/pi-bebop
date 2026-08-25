import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/**
 * Privacy-safe Member Status domain contract.
 *
 * Presence is endpoint reachability. Activity is mechanical live Pi control
 * flow. Status contains only mechanically observed runtime facts; intent and
 * progress come from asking the member explicitly. None implies availability,
 * health, productivity, or completed work.
 */

const MEMBER_STATUS_VERSION = 1 as const;
const MAX_MEMBER_STATUS_LABEL_BYTES = 256;
const MAX_MEMBER_IDENTITY_BYTES = 4096;

const ISO_TIMESTAMP_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$";
const IsoTimestampSchema = Type.String({ pattern: ISO_TIMESTAMP_PATTERN });
const PublicLabelSchema = Type.String({ minLength: 1, maxLength: MAX_MEMBER_STATUS_LABEL_BYTES });

const MemberStatusIdentitySchema = Type.Object(
	{ name: PublicLabelSchema, role: PublicLabelSchema },
	{ additionalProperties: false },
);

const OnlineMemberStatusSchema = Type.Object(
	{
		member: MemberStatusIdentitySchema,
		presence: Type.Literal("online"),
		activity: Type.Union([Type.Literal("idle"), Type.Literal("busy"), Type.Literal("compacting")]),
		hasPendingMessages: Type.Boolean(),
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
		observedAt: IsoTimestampSchema,
	},
	{ additionalProperties: false },
);
export const MemberStatusSchema = Type.Union([OnlineMemberStatusSchema, OfflineMemberStatusSchema]);

export type MemberStatusIdentity = Static<typeof MemberStatusIdentitySchema>;
export type OnlineMemberStatus = Static<typeof OnlineMemberStatusSchema>;
export type OfflineMemberStatus = Static<typeof OfflineMemberStatusSchema>;
export type MemberStatus = Static<typeof MemberStatusSchema>;
export type MemberActivity = OnlineMemberStatus["activity"];

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

export function deriveMemberActivity(isIdle: boolean, isCompacting = false): MemberActivity {
	if (isCompacting) return "compacting";
	return isIdle ? "idle" : "busy";
}

export function isMemberStatus(value: unknown): value is MemberStatus {
	if (!Value.Check(MemberStatusSchema, value)) return false;
	const status = value as MemberStatus;
	return isStatusIdentity(status.member) && isIsoTimestamp(status.observedAt);
}

export function createOnlineMemberStatus(input: {
	readonly member: MemberStatusIdentity;
	readonly isIdle: boolean;
	readonly isCompacting?: boolean;
	readonly hasPendingMessages: boolean;
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
		observedAt,
	};
	if (!isMemberStatus(status)) throw new TypeError("invalid offline member status");
	return status;
}

export function formatMemberStatus(status: MemberStatus): string {
	if (!isMemberStatus(status)) throw new TypeError("invalid member status");
	const member = `${status.member.name} (${status.member.role})`;
	if (status.presence === "offline") return `${member} — offline — activity unavailable`;
	const pending = status.hasPendingMessages ? " — pending messages" : "";
	return `${member} — online — ${status.activity}${pending}`;
}
