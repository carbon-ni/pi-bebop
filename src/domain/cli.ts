export const CONTROL_FLAG = "intray";
export const CONTROL_SHORT_FLAG = "in";

export type SessionControlAction =
	| "join"
	| "leave"
	| "members"
	| "status"
	| "stop"
	| "inbox"
	| "agreements"
	| "member-idle"
	| "board"
	| "post";

export type ParsedSessionControlAction =
	| { action: Exclude<SessionControlAction, "join" | "inbox" | "board" | "post" | "member-idle"> }
	| { action: "member-idle"; target?: string }
	| { action: "board" | "post"; target: string }
	| { action: "join"; target: string }
	| { action: "inbox"; target: string }
	| { action: "agreements"; target: string };

const SESSION_CONTROL_USAGE =
	"join <socket>|leave|members|status|member-idle [name[,name...]]|board [options]|post [options] <message>|stop|agreements activate <revision-id>|inbox status|cancel <id>|pause|resume";
const INBOX_USAGE = "status|cancel <id>|pause|resume";

function tokenizeSessionControlArgs(args: string): { parts?: string[]; error?: string } {
	const parts: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	let escaped = false;
	for (const character of args.trim()) {
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
		if (/\s/.test(character)) {
			if (current) {
				parts.push(current);
				current = "";
			}
			continue;
		}
		current += character;
	}
	if (escaped) current += "\\";
	if (quote) return { error: "Unclosed quote in crew command." };
	if (current) parts.push(current);
	return { parts };
}

type SessionControlParseResult = { action?: SessionControlAction; target?: string; error?: string };

function parseJoin(parts: string[]): SessionControlParseResult {
	if (parts.length === 1) return { error: "Missing target. Use /crew join <socket>." };
	if (parts.length > 2) return { error: "Join accepts exactly one target." };
	return { action: "join", target: parts[1] };
}

function parseAgreements(parts: string[]): SessionControlParseResult {
	if (parts[1] !== "activate")
		return { error: "Unknown agreements action. Use /crew agreements activate <revision-id>." };
	if (parts.length < 3) return { error: "Missing revision id. Use /crew agreements activate <revision-id>." };
	if (parts.length > 3) return { error: "Agreement activation accepts exactly one revision id." };
	return { action: "agreements", target: `activate ${parts[2]}` };
}

function parseMemberIdleTail(args: string): SessionControlParseResult | undefined {
	const command = args.trimStart();
	const keyword = "member-idle";
	if (!command.startsWith(keyword)) return undefined;
	const tail = command.slice(keyword.length);
	if (tail.length > 0 && !/^\s/u.test(tail)) return undefined;
	const target = tail.trim();
	return { action: "member-idle", ...(target ? { target } : {}) };
}

function parseInbox(parts: string[]): SessionControlParseResult {
	const sub = parts[1];
	if (sub === "status" || sub === "pause" || sub === "resume") {
		if (parts.length > 2) return { error: `Too many arguments. Use /crew inbox ${sub}.` };
		return { action: "inbox", target: sub };
	}
	if (sub === "cancel") {
		if (parts.length < 3) return { error: "Missing target. Use /crew inbox cancel <id>." };
		if (parts.length > 3) return { error: "Too many arguments. Use /crew inbox cancel <id>." };
		return { action: "inbox", target: `cancel ${parts[2]}` };
	}
	if (!sub) return { error: `Missing inbox action. Use /crew inbox ${INBOX_USAGE}.` };
	return { error: `Unknown inbox action: ${sub}. Use /crew inbox ${INBOX_USAGE}.` };
}

export function parseSessionControlAction(args: string): SessionControlParseResult {
	const memberIdle = parseMemberIdleTail(args);
	if (memberIdle) return memberIdle;
	const tokenized = tokenizeSessionControlArgs(args);
	if (tokenized.error) return tokenized;
	const parts = tokenized.parts!;
	if (parts.length === 0) return { action: "status" };
	const action = parts[0];
	if (action === "join") return parseJoin(parts);
	if (action === "board" || action === "post") {
		return { action, target: args.trim().slice(action.length).trim() };
	}
	if (action === "agreements") return parseAgreements(parts);
	if (action === "inbox") return parseInbox(parts);
	if (action === "leave" || action === "members" || action === "status" || action === "stop") {
		if (parts.length > 1) return { error: `Too many arguments. Use /crew ${SESSION_CONTROL_USAGE}.` };
		return { action };
	}
	return { error: `Unknown crew action: ${action}. Use /crew ${SESSION_CONTROL_USAGE}.` };
}

export function normalizeMode(raw: string): "steer" | "follow_up" | null {
	const value = raw.trim().toLowerCase();
	if (value === "steer") return "steer";
	if (value === "follow_up" || value === "follow-up" || value === "followup") return "follow_up";
	return null;
}

export type WaitUntil = "turn_end" | "message_processed" | "off";

export function normalizeWaitUntil(raw: string): WaitUntil | null {
	const value = raw.trim().toLowerCase();
	if (value === "turn_end" || value === "turn-end") return "turn_end";
	if (value === "message_processed" || value === "message-processed") return "message_processed";
	if (value === "off" || value === "none") return "off";
	return null;
}

export function isSessionControlRequested(getFlag: (name: string) => unknown, argv = process.argv.slice(2)): boolean {
	return (
		getFlag(CONTROL_FLAG) === true ||
		getFlag(CONTROL_SHORT_FLAG) === true ||
		argv.includes(`--${CONTROL_FLAG}`) ||
		argv.includes(`--${CONTROL_SHORT_FLAG}`)
	);
}
