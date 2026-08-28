import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** Transport limits are deterministic UTF-8 byte limits. Aggregate size is UTF-8 bytes of compact JSON payload (framing excluded). */
export const MAX_MESSAGE_CONTENT_BYTES = 1_000_000;
export const MAX_MESSAGE_INSTRUCTIONS = 32;
export const MAX_MESSAGE_INSTRUCTION_BYTES = 100_000;
export const MAX_MESSAGE_PAYLOAD_BYTES = 1_000_000;
export const MAX_MESSAGE_ORIGIN_FIELD_BYTES = 256;
export const MAX_MESSAGE_REPLY_FIELD_BYTES = 256;
/** Crew Return Address manifest-path bound: deterministic UTF-8 byte limit for a canonical absolute POSIX path. */
export const MAX_CREW_RETURN_ADDRESS_PATH_BYTES = 1024;

const NonEmptyText = Type.String({ minLength: 1 });
export const CrewOriginSchema = Type.Object(
	{ kind: Type.Literal("crew"), name: NonEmptyText, role: NonEmptyText },
	{ additionalProperties: false },
);
export const ExternalOriginSchema = Type.Object(
	{ kind: Type.Literal("external"), label: NonEmptyText },
	{ additionalProperties: false },
);
export const MessageOriginSchema = Type.Union([CrewOriginSchema, ExternalOriginSchema]);
export const MessageInstructionsSchema = Type.Optional(
	Type.Array(NonEmptyText, { minItems: 1, maxItems: MAX_MESSAGE_INSTRUCTIONS }),
);
export const ReplyToSchema = Type.Object(
	{ sessionId: NonEmptyText, sessionName: Type.Optional(NonEmptyText) },
	{ additionalProperties: false },
);
/**
 * TASK-0136: structured claimed Crew Return Address — the reply affordance for
 * crew-to-crew correspondence. Bounded canonical absolute manifest path plus
 * optional crew label; deliberately distinct from callback-only `replyTo`.
 */
export const CrewReturnAddressSchema = Type.Object(
	{ manifestPath: NonEmptyText, crewName: Type.Optional(NonEmptyText) },
	{ additionalProperties: false },
);
export const MessagePayloadSchema = Type.Object(
	{
		content: Type.String({ minLength: 1, maxLength: MAX_MESSAGE_CONTENT_BYTES }),
		instructions: MessageInstructionsSchema,
		origin: Type.Optional(MessageOriginSchema),
		replyTo: Type.Optional(ReplyToSchema),
		crewReturnAddress: Type.Optional(CrewReturnAddressSchema),
	},
	{ additionalProperties: false },
);

export type CrewOrigin = Static<typeof CrewOriginSchema>;
export type ExternalOrigin = Static<typeof ExternalOriginSchema>;
export type MessageOrigin = Static<typeof MessageOriginSchema>;
export type ReplyTo = Static<typeof ReplyToSchema>;
export type CrewReturnAddress = Static<typeof CrewReturnAddressSchema>;
export type MessagePayload = Static<typeof MessagePayloadSchema>;

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");
export const messagePayloadUtf8Bytes = (payload: MessagePayload): number => utf8Bytes(JSON.stringify(payload));

/**
 * TASK-0136: lexical canonicalization of an absolute POSIX manifest path —
 * pure string hygiene with no filesystem IO. Collapses duplicate separators,
 * resolves `.` and `..` segments, and trims trailing separators. Returns null
 * for relative, empty, NUL/control-character, or root-escaping values. A
 * value is canonical exactly when canonicalizeCrewManifestPath(value) === value.
 */
export function canonicalizeCrewManifestPath(value: string): string | null {
	if (!value.startsWith("/") || value.includes("\0") || /[\u0001-\u001f\u007f]/.test(value)) return null;
	const segments: string[] = [];
	for (const segment of value.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (segments.length === 0) return null;
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	return `/${segments.join("/")}`;
}
const invalidContent = (value: string): boolean =>
	value.trim().length === 0 || value.includes("\0") || utf8Bytes(value) > MAX_MESSAGE_CONTENT_BYTES;
const invalidInstruction = (value: string): boolean =>
	value.trim().length === 0 || value.includes("\0") || utf8Bytes(value) > MAX_MESSAGE_INSTRUCTION_BYTES;
const invalidIdentity = (value: string, limit: number): boolean =>
	value.trim().length === 0 || value !== value.trim() || value.includes("\0") || utf8Bytes(value) > limit;

const invalidCrewManifestPath = (value: string): boolean =>
	canonicalizeCrewManifestPath(value) !== value || utf8Bytes(value) > MAX_CREW_RETURN_ADDRESS_PATH_BYTES;
const invalidCrewReturnAddress = (address: CrewReturnAddress): boolean =>
	invalidCrewManifestPath(address.manifestPath) ||
	(address.crewName !== undefined && invalidIdentity(address.crewName, MAX_MESSAGE_ORIGIN_FIELD_BYTES));

export function isMessagePayload(value: unknown): value is MessagePayload {
	if (!Value.Check(MessagePayloadSchema, value) || typeof value !== "object" || value === null) return false;
	const payload = value as MessagePayload;
	if (invalidContent(payload.content)) return false;
	const instructions = payload.instructions ?? [];
	if (instructions.some(invalidInstruction)) return false;
	if (payload.origin) {
		const fields =
			payload.origin.kind === "crew" ? [payload.origin.name, payload.origin.role] : [payload.origin.label];
		if (fields.some((field) => invalidIdentity(field, MAX_MESSAGE_ORIGIN_FIELD_BYTES))) return false;
	}
	if (payload.replyTo) {
		const fields = [payload.replyTo.sessionId, payload.replyTo.sessionName].filter(
			(field): field is string => field !== undefined,
		);
		if (fields.some((field) => invalidIdentity(field, MAX_MESSAGE_REPLY_FIELD_BYTES))) return false;
	}
	if (payload.crewReturnAddress && invalidCrewReturnAddress(payload.crewReturnAddress)) return false;
	return messagePayloadUtf8Bytes(payload) <= MAX_MESSAGE_PAYLOAD_BYTES;
}
