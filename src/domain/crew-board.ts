import { createHash } from "node:crypto";

export const CREW_BOARD_VERSION = 1 as const;
export const MAX_BOARD_MESSAGE_BYTES = 4096;
export const MAX_BOARD_RAW_MESSAGE_BYTES = 16 * 1024;
export const MAX_BOARD_AUTHOR_BYTES = 256;
export const MAX_BOARD_REFERENCE_BYTES = 256;
export const MAX_BOARD_REFERENCES = 16;
export const MAX_BOARD_POSTS = 4096;
export const MAX_BOARD_CURSOR_BYTES = 512;
export const MAX_BOARD_OPERATION_ID_BYTES = 128;
export const BOARD_DEFAULT_LIMIT = 20;
export const BOARD_MAX_LIMIT = 100;

export type CrewPostKind = "tip" | "kudos" | "feedback" | "warning" | "note";
export type CrewPostRelation = "supersedes" | "disputes";
export type CrewPostRedaction = "credential" | "secret";
export interface CrewPostAuthor {
	readonly name: string;
	readonly role: string;
}
export interface CrewPostLink {
	readonly relation: CrewPostRelation;
	readonly postId: string;
}
export interface CrewPost {
	readonly version: typeof CREW_BOARD_VERSION;
	readonly id: string;
	readonly sequence: number;
	readonly createdAt: number;
	readonly author: CrewPostAuthor;
	readonly kind: CrewPostKind;
	readonly message: string;
	readonly references: readonly string[];
	readonly link: CrewPostLink | null;
	readonly redactions: readonly CrewPostRedaction[];
	readonly semanticFingerprint: string;
}
export interface BoardAppendInput {
	readonly operationId: string;
	readonly author: CrewPostAuthor;
	readonly kind?: CrewPostKind;
	readonly message: string;
	readonly references?: readonly string[];
	readonly link?: CrewPostLink | null;
}
export interface BoardCursor {
	readonly board: string;
	readonly sequence: number;
	readonly id: string;
	readonly kinds: readonly CrewPostKind[];
}
export interface BoardReadResult {
	readonly version: typeof CREW_BOARD_VERSION;
	readonly posts: readonly CrewPost[];
	readonly nextCursor: string | null;
	readonly hasMore: boolean;
	readonly corruptCount: number;
	readonly quarantinedThisRead: number;
	readonly corruptCountTruncated: boolean;
}

const KINDS: readonly CrewPostKind[] = ["tip", "kudos", "feedback", "warning", "note"];
const REDACTIONS: readonly CrewPostRedaction[] = ["credential", "secret"];
const textBytes = (value: string) => Buffer.byteLength(value, "utf8");
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const hasUnsupportedControl = (value: string) => /[\0\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value);

export class CrewBoardError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "CrewBoardError";
	}
}
function fail(code: string, message: string): never {
	throw new CrewBoardError(code, message);
}
function safeText(value: unknown, field: string, max: number): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.trim() !== value ||
		value.includes("\0") ||
		hasUnsupportedControl(value)
	)
		fail("invalid-" + field, `${field} is invalid`);
	try {
		encodeURIComponent(value);
	} catch {
		fail("invalid-" + field, `${field} is not valid Unicode`);
	}
	if (textBytes(value) > max) fail("oversized-" + field, `${field} exceeds ${max} UTF-8 bytes`);
	return value;
}
function safeAuthor(value: unknown): string {
	const text = safeText(value, "author", MAX_BOARD_AUTHOR_BYTES);
	if (text.includes("\r") || text.includes("\n") || text !== text.normalize("NFC"))
		fail("invalid-author", "author must be normalized single-line text");
	return text;
}
function redactMessage(raw: string): { message: string; redactions: readonly CrewPostRedaction[] } {
	safeText(raw, "message", MAX_BOARD_RAW_MESSAGE_BYTES);
	if (raw.includes("[REDACTED:credential]") || raw.includes("[REDACTED:secret]"))
		fail("sensitive-marker", "reserved redaction marker is not accepted");
	let message = raw.normalize("NFC").replace(/\r\n?/g, "\n").trim();
	const kinds = new Set<CrewPostRedaction>();
	const replace = (pattern: RegExp, replacement: string, kind: CrewPostRedaction) => {
		const next = message.replace(pattern, replacement);
		if (next !== message) kinds.add(kind);
		message = next;
	};
	replace(
		/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
		"[REDACTED:secret]",
		"secret",
	);
	replace(/(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, "$1[REDACTED:credential]@", "credential");
	replace(/(Authorization:\s*Bearer\s+)[A-Za-z0-9._~-]{6,}/gi, "$1[REDACTED:credential]", "credential");
	replace(
		/(\b(?:password|passwd|pwd|token|secret|api[_-]key|access[_-]key)\b\s*[:=]\s*)[^\s,;]+/gi,
		"$1[REDACTED:credential]",
		"credential",
	);
	replace(/\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED:credential]", "credential");
	if (!message) fail("invalid-message", "message is empty after normalization");
	if (textBytes(message) > MAX_BOARD_MESSAGE_BYTES)
		fail("oversized-message", `message exceeds ${MAX_BOARD_MESSAGE_BYTES} UTF-8 bytes`);
	return { message, redactions: REDACTIONS.filter((kind) => kinds.has(kind)) };
}
function validateReference(reference: unknown): string {
	if (
		typeof reference !== "string" ||
		textBytes(reference) > MAX_BOARD_REFERENCE_BYTES ||
		!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(reference)
	)
		fail("invalid-reference", "reference grammar is invalid");
	if (
		reference.includes("//") ||
		reference.includes("://") ||
		reference.split(/[/:]/).some((part) => part === "." || part === "..") ||
		/^(?:[~/.]|[A-Za-z]:)/.test(reference)
	)
		fail("invalid-reference", "reference path is unsafe");
	if (/password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key/i.test(reference))
		fail("sensitive-reference", "reference contains sensitive material");
	return reference;
}
function validateLink(link: CrewPostLink | null | undefined): CrewPostLink | null {
	if (link === undefined || link === null) return null;
	if (
		typeof link !== "object" ||
		Object.keys(link).some((key) => key !== "relation" && key !== "postId") ||
		(link.relation !== "supersedes" && link.relation !== "disputes") ||
		typeof link.postId !== "string" ||
		!/^post-[a-f0-9]{64}$/.test(link.postId)
	)
		fail("invalid-link", "link is invalid");
	return { relation: link.relation, postId: link.postId };
}
export function boardScopeForLayout(realLayout: string): string {
	return sha256(realLayout);
}
export function createBoardPost(
	input: BoardAppendInput,
	sequence: number,
	createdAt: number,
	boardScope: string,
): CrewPost {
	const operationId = safeText(input.operationId, "operation-id", MAX_BOARD_OPERATION_ID_BYTES);
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationId))
		fail("invalid-operation-id", "operation id grammar is invalid");
	if (!Number.isSafeInteger(sequence) || sequence < 1)
		fail("invalid-sequence", "sequence must be positive safe integer");
	if (!Number.isSafeInteger(createdAt) || createdAt < 0)
		fail("invalid-created-at", "createdAt must be non-negative safe integer");
	const name = safeAuthor(input.author.name);
	const role = safeAuthor(input.author.role);
	const kind = input.kind ?? "note";
	if (!KINDS.includes(kind)) fail("invalid-kind", "kind is invalid");
	const { message, redactions } = redactMessage(input.message);
	const references = (input.references ?? []).map(validateReference);
	if (new Set(references).size !== references.length) fail("duplicate-reference", "references must be unique");
	if (references.length > MAX_BOARD_REFERENCES) fail("too-many-references", "too many references");
	references.sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
	const link = validateLink(input.link);
	const author = { name, role };
	const semantic = { author, kind, message, references, link, redactions };
	const semanticFingerprint = sha256(JSON.stringify(semantic));
	const id = `post-${sha256(`crew-board:v1\0${boardScope}\0${operationId}`)}`;
	return {
		version: CREW_BOARD_VERSION,
		id,
		sequence,
		createdAt,
		author,
		kind,
		message,
		references,
		link,
		redactions,
		semanticFingerprint,
	};
}
export function canonicalCrewPostJson(post: CrewPost): string {
	return JSON.stringify({
		version: post.version,
		id: post.id,
		sequence: post.sequence,
		createdAt: post.createdAt,
		author: { name: post.author.name, role: post.author.role },
		kind: post.kind,
		message: post.message,
		references: [...post.references],
		link: post.link,
		redactions: [...post.redactions],
		semanticFingerprint: post.semanticFingerprint,
	});
}
export function canonicalCrewPostBytes(post: CrewPost): string {
	return `${canonicalCrewPostJson(post)}\n`;
}
const POST_FIELDS = [
	"version",
	"id",
	"sequence",
	"createdAt",
	"author",
	"kind",
	"message",
	"references",
	"link",
	"redactions",
	"semanticFingerprint",
];
function validPostShape(post: CrewPost): boolean {
	return (
		Object.keys(post).every((key) => POST_FIELDS.includes(key)) &&
		POST_FIELDS.every((key) => key in post) &&
		post.version === CREW_BOARD_VERSION &&
		/^post-[a-f0-9]{64}$/.test(post.id) &&
		Number.isSafeInteger(post.sequence) &&
		post.sequence > 0 &&
		Number.isSafeInteger(post.createdAt) &&
		post.createdAt >= 0 &&
		KINDS.includes(post.kind) &&
		Array.isArray(post.references) &&
		Array.isArray(post.redactions) &&
		/^[a-f0-9]{64}$/.test(post.semanticFingerprint)
	);
}
function validPostReferences(post: CrewPost, references: readonly string[]): boolean {
	return (
		JSON.stringify(references) ===
			JSON.stringify([...new Set(references)].sort((a, b) => Buffer.from(a).compare(Buffer.from(b)))) &&
		post.references.length <= MAX_BOARD_REFERENCES
	);
}
function validPostAuthor(author: CrewPost["author"]): boolean {
	return (
		Boolean(author) &&
		typeof author === "object" &&
		Object.keys(author).every((key) => key === "name" || key === "role") &&
		"name" in author &&
		"role" in author
	);
}
function validPostRedactions(message: string, redactions: readonly CrewPostRedaction[]): boolean {
	if (!message.includes("[REDACTED:credential]") && !message.includes("[REDACTED:secret]")) {
		const expected = redactMessage(message);
		return expected.message === message && JSON.stringify(expected.redactions) === JSON.stringify(redactions);
	}
	return (
		redactions.every((item) => REDACTIONS.includes(item)) &&
		new Set(redactions).size === redactions.length &&
		JSON.stringify(redactions) === JSON.stringify(REDACTIONS.filter((item) => redactions.includes(item))) &&
		(!message.includes("[REDACTED:credential]") || redactions.includes("credential")) &&
		(!message.includes("[REDACTED:secret]") || redactions.includes("secret"))
	);
}
function validPostSemantics(post: CrewPost): boolean {
	if (!validPostAuthor(post.author)) return false;
	const message = safeText(post.message, "message", MAX_BOARD_MESSAGE_BYTES);
	if (!validPostRedactions(message, post.redactions)) return false;
	const references = post.references.map(validateReference);
	if (!validPostReferences(post, references)) return false;
	const semantic = {
		author: { name: safeAuthor(post.author.name), role: safeAuthor(post.author.role) },
		kind: post.kind,
		message,
		references,
		link: validateLink(post.link),
		redactions: post.redactions,
	};
	return (
		post.semanticFingerprint === sha256(JSON.stringify(semantic)) &&
		canonicalCrewPostJson(post) ===
			canonicalCrewPostJson({
				...post,
				message,
				references,
				link: validateLink(post.link),
				redactions: post.redactions,
			})
	);
}
export function isCrewPost(value: unknown): value is CrewPost {
	try {
		return (
			Boolean(value) &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			validPostShape(value as CrewPost) &&
			validPostSemantics(value as CrewPost)
		);
	} catch {
		return false;
	}
}

export function encodeBoardCursor(cursor: BoardCursor): string {
	if (
		!/^post-[a-f0-9]{64}$/.test(cursor.id) ||
		!Number.isSafeInteger(cursor.sequence) ||
		cursor.sequence < 1 ||
		!/^[a-f0-9]{64}$/.test(cursor.board)
	)
		fail("invalid-cursor", "cursor is invalid");
	const kinds = [...new Set(cursor.kinds)].sort((a, b) => KINDS.indexOf(a) - KINDS.indexOf(b));
	const encoded = Buffer.from(
		JSON.stringify({ v: 1, board: cursor.board, sequence: cursor.sequence, id: cursor.id, kinds }),
	).toString("base64url");
	if (encoded.length > MAX_BOARD_CURSOR_BYTES) fail("invalid-cursor", "cursor exceeds bound");
	return encoded;
}
export function decodeBoardCursor(raw: string, board: string, kinds: readonly CrewPostKind[]): BoardCursor {
	if (typeof raw !== "string" || raw.length > MAX_BOARD_CURSOR_BYTES) fail("invalid-cursor", "cursor is invalid");
	let value: unknown;
	try {
		value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
	} catch {
		fail("invalid-cursor", "cursor is malformed");
	}
	if (!value || typeof value !== "object") fail("invalid-cursor", "cursor is malformed");
	const cursor = value as Record<string, unknown>;
	const expectedKinds = [...new Set(kinds)].sort((a, b) => KINDS.indexOf(a) - KINDS.indexOf(b));
	if (
		cursor.v !== 1 ||
		cursor.board !== board ||
		cursor.kinds === undefined ||
		JSON.stringify(cursor.kinds) !== JSON.stringify(expectedKinds)
	)
		fail("cursor-filter-mismatch", "cursor does not match filter");
	if (typeof cursor.id !== "string" || typeof cursor.sequence !== "number")
		fail("invalid-cursor", "cursor boundary is invalid");
	return { board, id: cursor.id, sequence: cursor.sequence, kinds: expectedKinds };
}
export function compareCrewPostsNewest(a: CrewPost, b: CrewPost): number {
	return b.sequence - a.sequence || b.id.localeCompare(a.id);
}
export function emptyBoardRead(): BoardReadResult {
	return {
		version: CREW_BOARD_VERSION,
		posts: [],
		nextCursor: null,
		hasMore: false,
		corruptCount: 0,
		quarantinedThisRead: 0,
		corruptCountTruncated: false,
	};
}
export function postKindValues(): readonly CrewPostKind[] {
	return KINDS;
}
