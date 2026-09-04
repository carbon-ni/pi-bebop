export const CONTROL_FLAG = "intray";
export const CONTROL_SHORT_FLAG = "in";

export type SessionControlAction = "join" | "leave" | "members" | "status" | "stop" | "inbox" | "guests" | "guest";

export type ParsedSessionControlAction =
	| { action: Exclude<SessionControlAction, "join" | "inbox" | "guest"> }
	| { action: "join"; target: string }
	| { action: "inbox"; target: string }
	| { action: "guest"; target: "approve" | "deny" | "remove"; value: string };

const SESSION_CONTROL_USAGE =
	"join <socket>|leave|members|guests|guest approve|deny|remove|status|stop|inbox status|cancel <id>|pause|resume";
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

export function parseSessionControlAction(args: string): {
	action?: SessionControlAction;
	target?: string;
	value?: string;
	error?: string;
} {
	const tokenized = tokenizeSessionControlArgs(args);
	if (tokenized.error) return tokenized;
	const parts = tokenized.parts!;
	if (parts.length === 0) return { action: "status" };

	const action = parts[0];
	if (action === "join") {
		if (parts.length === 1) return { error: "Missing target. Use /crew join <socket>." };
		if (parts.length > 2) return { error: "Join accepts exactly one target." };
		return { action, target: parts[1] };
	}
	if (action === "leave" || action === "members" || action === "status" || action === "stop") {
		if (parts.length > 1) return { error: `Too many arguments. Use /crew ${SESSION_CONTROL_USAGE}.` };
		return { action };
	}
	if (action === "guests") {
		if (parts.length > 1) return { error: "Too many arguments. Use /crew guests." };
		return { action: "guests" };
	}
	if (action === "guest") {
		const sub = parts[1];
		if (sub !== "approve" && sub !== "deny" && sub !== "remove")
			return { error: "Unknown guest action. Use /crew guest approve|deny <request-id> or remove <guest-name>." };
		if (parts.length !== 3 || !parts[2]) return { error: `Missing target. Use /crew guest ${sub} <value>.` };
		return { action: "guest", target: sub, value: parts[2] };
	}
	if (action === "inbox") {
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
