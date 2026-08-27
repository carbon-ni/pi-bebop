import type { CrewPostKind, CrewPostRelation } from "./crew-board.ts";

export type ParsedCrewBoardCommand =
	| {
			readonly action: "board";
			readonly kinds?: readonly CrewPostKind[];
			readonly after?: string;
			readonly limit?: number;
	  }
	| {
			readonly action: "post";
			readonly kind?: CrewPostKind;
			readonly message: string;
			readonly references?: readonly string[];
			readonly relation?: CrewPostRelation;
			readonly postId?: string;
	  };

export type CrewBoardCommandParseResult = ParsedCrewBoardCommand | { readonly error: string };
const POST_TAIL_MAX_BYTES = 21_504;
const BOARD_TAIL_MAX_BYTES = 1_024;

type Token = { readonly value: string };

function tokenize(raw: string): { readonly tokens?: readonly Token[]; readonly error?: string } {
	const tokens: Token[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	let escaped = false;
	for (const character of raw.trim()) {
		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = null;
			else current += character;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (/\s/u.test(character)) {
			if (current) {
				tokens.push({ value: current });
				current = "";
			}
			continue;
		}
		current += character;
	}
	if (escaped) current += "\\";
	if (quote) return { error: "Unclosed quote in Crew Board command." };
	if (current) tokens.push({ value: current });
	return { tokens };
}

type FlagValueResult = { readonly value: string } | { readonly error: string };

function valueAfter(tokens: readonly Token[], index: number, flag: string): FlagValueResult {
	const value = tokens[index + 1]?.value;
	if (!value || value.startsWith("--")) return { error: `Missing value for ${flag}.` };
	return { value };
}

function parseKind(value: string): CrewPostKind | undefined {
	if (["tip", "kudos", "feedback", "warning", "note"].includes(value)) return value as CrewPostKind;
	return undefined;
}

type BoardState = { kinds: CrewPostKind[]; after?: string; limit?: number };
function parseBoardFlag(tokens: readonly Token[], index: number, state: BoardState): number | { error: string } {
	const token = tokens[index]!.value;
	const value = valueAfter(tokens, index, token);
	if ("error" in value) return { error: value.error };
	if (token === "--kind") {
		const kind = parseKind(value.value);
		if (!kind) return { error: `Invalid kind: ${value.value}.` };
		if (state.kinds.includes(kind)) return { error: `Duplicate kind: ${kind}.` };
		state.kinds.push(kind);
		return index + 2;
	}
	if (token === "--after") {
		if (state.after !== undefined) return { error: "Duplicate --after flag." };
		state.after = value.value;
		return index + 2;
	}
	if (token === "--limit") {
		if (state.limit !== undefined) return { error: "Duplicate --limit flag." };
		if (!/^(?:[1-9]|[1-9]\d|100)$/u.test(value.value)) return { error: `Invalid limit: ${value.value}.` };

		state.limit = Number(value.value);
		return index + 2;
	}
	return {
		error: token.startsWith("--") ? `Unknown board flag: ${token}.` : "Board does not accept a message argument.",
	};
}
function parseBoard(tokens: readonly Token[], raw: string): CrewBoardCommandParseResult {
	if (Buffer.byteLength(raw, "utf8") > BOARD_TAIL_MAX_BYTES)
		return { error: "Crew Board options exceed 1,024 UTF-8 bytes." };
	const state: BoardState = { kinds: [] };
	for (let index = 0; index < tokens.length; ) {
		const next = parseBoardFlag(tokens, index, state);
		if (typeof next !== "number") return next;
		index = next;
	}
	return {
		action: "board",
		...(state.kinds.length ? { kinds: state.kinds } : {}),
		...(state.after === undefined ? {} : { after: state.after }),
		...(state.limit === undefined ? {} : { limit: state.limit }),
	};
}

type PostState = { kind?: CrewPostKind; references: string[]; relation?: CrewPostRelation; postId?: string };
function parsePostFlag(tokens: readonly Token[], index: number, state: PostState): number | { error: string } {
	const token = tokens[index]!.value;
	const value = valueAfter(tokens, index, token);
	if ("error" in value) return { error: value.error };
	if (token === "--kind") {
		if (state.kind !== undefined) return { error: "Duplicate --kind flag." };
		state.kind = parseKind(value.value);
		if (!state.kind) return { error: `Invalid kind: ${value.value}.` };
		return index + 2;
	}
	if (token === "--ref") {
		if (state.references.length >= 16) return { error: "Too many --ref flags." };
		if (state.references.includes(value.value)) return { error: `Duplicate reference: ${value.value}.` };
		state.references.push(value.value);
		return index + 2;
	}
	if (token === "--supersedes" || token === "--disputes") {
		if (state.relation !== undefined) return { error: "Only one of --supersedes or --disputes may be used." };
		if (!/^post-[a-f0-9]{64}$/u.test(value.value)) return { error: `Invalid Post ID: ${value.value}.` };
		state.relation = token.slice(2) as CrewPostRelation;
		state.postId = value.value;
		return index + 2;
	}
	return { error: `Unknown post flag: ${token}.` };
}
function parsePost(tokens: readonly Token[], raw: string): CrewBoardCommandParseResult {
	if (Buffer.byteLength(raw, "utf8") > POST_TAIL_MAX_BYTES)
		return { error: "Crew Post command exceeds 21,504 UTF-8 bytes." };
	const state: PostState = { references: [] };
	let messageStart = 0;
	while (
		messageStart < tokens.length &&
		tokens[messageStart]!.value !== "--" &&
		tokens[messageStart]!.value.startsWith("--")
	) {
		const next = parsePostFlag(tokens, messageStart, state);
		if (typeof next !== "number") return next;
		messageStart = next;
	}
	if (messageStart < tokens.length && tokens[messageStart]!.value === "--") messageStart += 1;
	if (messageStart >= tokens.length) return { error: "Missing message. Use /crew post <message>." };

	const message = tokens
		.slice(messageStart)
		.map((token) => token.value)
		.join(" ")
		.trim();
	if (!message) return { error: "Missing message. Use /crew post <message>." };
	return {
		action: "post",
		...(state.kind === undefined ? {} : { kind: state.kind }),
		message,
		...(state.references.length ? { references: state.references } : {}),
		...(state.relation === undefined ? {} : { relation: state.relation, postId: state.postId }),
	};
}

export function parseCrewBoardCommand(action: "board" | "post", raw: string): CrewBoardCommandParseResult {
	const tokenized = tokenize(raw);
	if (tokenized.error) return { error: tokenized.error };
	return action === "board" ? parseBoard(tokenized.tokens ?? [], raw) : parsePost(tokenized.tokens ?? [], raw);
}
