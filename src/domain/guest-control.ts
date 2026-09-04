export type GuestControlAction = "join" | "crews" | "leave";

export type ParsedGuestControlAction =
	| { readonly action: "join"; readonly target: string; readonly guestName: string }
	| { readonly action: "crews" }
	| { readonly action: "leave"; readonly target: string };

export type GuestControlParseResult = ParsedGuestControlAction | { readonly error: string };

function tokenize(args: string): { parts?: string[]; error?: string } {
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
	if (quote) return { error: "Unclosed quote in guest command." };
	if (current) parts.push(current);
	return { parts };
}

function validValue(value: string | undefined): value is string {
	return value !== undefined && value.length > 0 && value.trim() === value && !value.includes("\0");
}

/** Parses the non-agent-turn `/guest join|crews|leave` command surface. */
export function parseGuestControlAction(args: string): GuestControlParseResult {
	const tokenized = tokenize(args);
	if (tokenized.error) return { error: tokenized.error };
	const parts = tokenized.parts ?? [];
	const action = parts.shift();
	if (!action) return { error: "Missing guest action. Use /guest join <socket> --as <guest-name>." };
	if (action === "crews") {
		return parts.length === 0 ? { action } : { error: "Guest crews accepts no arguments. Use /guest crews." };
	}
	if (action === "leave") {
		if (parts.length !== 1 || !validValue(parts[0]))
			return { error: "Guest leave requires exactly one crew selector. Use /guest leave <crew-selector>." };
		return { action, target: parts[0] };
	}
	if (action !== "join") return { error: `Unknown guest action: ${action}. Use /guest join|crews|leave.` };

	let target: string | undefined;
	let guestName: string | undefined;
	for (let index = 0; index < parts.length; index += 1) {
		const part = parts[index]!;
		if (part === "--as") {
			if (guestName !== undefined) return { error: "Guest join accepts --as exactly once." };
			guestName = parts[++index];
			if (!validValue(guestName))
				return { error: "Guest join requires a non-empty value for --as <guest-name>." };
			continue;
		}
		if (part.startsWith("--")) return { error: `Unknown guest join option: ${part}. Use --as <guest-name>.` };
		if (target !== undefined) return { error: "Guest join accepts exactly one live Member socket target." };
		target = part;
	}
	if (!validValue(target)) return { error: "Guest join requires one live Member socket target." };
	if (!validValue(guestName)) return { error: "Guest join requires --as <guest-name>." };
	return { action, target, guestName };
}
