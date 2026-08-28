export type ActionableLocationKind =
	| "command"
	| "flag"
	| "argument"
	| "config-field"
	| "project-path"
	| "member"
	| "post-id"
	| "cursor"
	| "transport";

export interface ActionableLocation {
	kind: ActionableLocationKind;
	name: string;
	value?: string;
}

export interface ActionableError {
	code: string;
	operation: string;
	message: string;
	location?: ActionableLocation;
	recovery: string[];
	validChoices?: string[];
	validChoicesTruncated?: boolean;
	omittedChoiceCount?: number;
}

export interface ActionableErrorDescriptor {
	code: string;
	operation: string;
	reason: string;
	recovery: readonly string[];
	location?: ActionableLocation;
	validChoices?: readonly string[];
}

const CODE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const MARKER = /\[REDACTED:(?:credential|secret)\]/;
const REDACTIONS: readonly [RegExp, string][] = [
	[
		/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
		"[REDACTED:secret]",
	],
	[/(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, "$1[REDACTED:credential]@"],
	[/(Authorization:\s*Bearer\s+)[A-Za-z0-9._~-]{6,}/gi, "$1[REDACTED:credential]"],
	[/\b(?:password|passwd|pwd|token|secret|api[_-]key|access[_-]key)\b\s*[:=]\s*[^\s,;]+/gi, "[REDACTED:credential]"],
	[/\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED:credential]"],
];

function safe(value: string, max: number): string | undefined {
	if (typeof value !== "string" || MARKER.test(value)) return undefined;
	let result = value.normalize("NFC").replace(/\r\n?/g, "\n");
	for (const [pattern, replacement] of REDACTIONS) result = result.replace(pattern, replacement);
	if (result.includes("\n") || CONTROL.test(result) || result.includes("\uFFFD")) return undefined;
	return result.trim().slice(0, max);
}

function boundedCode(code: string): string {
	return CODE.test(code) ? code : "unexpected-failure";
}
function truncate(value: string, max: number): string {
	if (Buffer.byteLength(value, "utf8") <= max) return value;
	let result = "";
	for (const char of value) {
		if (Buffer.byteLength(result + char + "…", "utf8") > max) break;
		result += char;
	}
	return result + "…";
}

function buildLocation(location?: ActionableLocation): ActionableLocation | undefined {
	const name = location && safe(location.name, 96);
	if (!location || !name) return undefined;
	return { kind: location.kind, name, ...(location.value === undefined ? {} : { value: safe(location.value, 384) }) };
}

function buildChoices(source: readonly string[] = []): { choices: string[]; omitted: number } {
	const choices: string[] = [];
	let omitted = 0;
	for (const choice of source) {
		const retained = safe(choice, 256);
		const overflow = retained && Buffer.byteLength([...choices, retained].join(""), "utf8") > 1024;
		if (!retained || choices.includes(retained) || choices.length >= 32 || overflow) omitted++;
		else choices.push(retained);
	}
	return { choices, omitted };
}

export function presentActionableError(descriptor: ActionableErrorDescriptor): ActionableError {
	const code = boundedCode(descriptor.code);
	const operation = safe(descriptor.operation, 96) ?? "Pi Bebop operation";
	const reason = safe(descriptor.reason, 240) ?? "an unexpected failure occurred";
	const recovery = descriptor.recovery
		.map((item) => safe(item, 256))
		.filter((item): item is string => Boolean(item))
		.slice(0, 3);
	const boundedRecovery = recovery.length ? recovery : ["retry once; if it repeats, report the operation and code."];
	const location = buildLocation(descriptor.location);
	const { choices, omitted } = buildChoices(descriptor.validChoices);
	const locator = location?.value
		? ` Location: ${location.name}="${truncate(location.value, 192)}".`
		: location
			? ` Location: ${location.name}.`
			: "";
	const message = truncate(
		`${operation} failed: ${reason}.${locator} Next: ${boundedRecovery[0]} (code: ${code})`,
		1024,
	);
	return {
		code,
		operation,
		message,
		...(location ? { location } : {}),
		recovery: boundedRecovery,
		...(choices.length ? { validChoices: choices } : {}),
		...(omitted ? { validChoicesTruncated: true, omittedChoiceCount: omitted } : {}),
	};
}
