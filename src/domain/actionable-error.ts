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
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
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

function hasUnpairedSurrogate(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return true;
			index++;
		} else if (code >= 0xdc00 && code <= 0xdfff) return true;
	}
	return false;
}

function safe(value: string, max: number): string | undefined {
	if (typeof value !== "string" || MARKER.test(value) || hasUnpairedSurrogate(value)) return undefined;
	let result = value.normalize("NFC").replace(/\r\n?/g, "\n");
	for (const [pattern, replacement] of REDACTIONS) result = result.replace(pattern, replacement);
	if (result.includes("\n") || CONTROL.test(result) || result.includes("\uFFFD")) return undefined;
	return truncate(result.trim(), max);
}

function safeStructured(value: string, max: number): string | undefined {
	const normalized = safe(value, max);
	return normalized === value.normalize("NFC").trim() ? normalized : undefined;
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
	const name = location && safeStructured(location.name, 96);
	if (!location || !name) return undefined;
	const value = location.value === undefined ? undefined : safeStructured(location.value, 384);
	return { kind: location.kind, name, ...(value === undefined ? {} : { value }) };
}

function buildChoices(source: readonly string[] = []): { choices: string[]; omitted: number } {
	const choices: string[] = [];
	let omitted = 0;
	for (const choice of source) {
		const retained = safeStructured(choice, 256);
		const bytes = retained ? Buffer.byteLength([...choices, retained].join(""), "utf8") : 0;
		if (!retained || choices.includes(retained) || choices.length >= 32 || bytes > 1024) omitted++;
		else choices.push(retained);
	}
	return { choices, omitted };
}

function messageFor(
	result: Pick<ActionableError, "operation" | "code" | "recovery" | "location">,
	reason: string,
): string {
	const locator = result.location?.value
		? ` Location: ${result.location.name}="${truncate(result.location.value, 192)}".`
		: result.location
			? ` Location: ${result.location.name}.`
			: "";
	return truncate(
		`${result.operation} failed: ${reason}.${locator} Next: ${result.recovery[0]} (code: ${result.code})`,
		1024,
	);
}

export function actionableErrorUtf8Bytes(error: ActionableError): number {
	return Buffer.byteLength(JSON.stringify(error), "utf8");
}

function fitResult(result: ActionableError, reason: string): ActionableError {
	const refresh = (): void => {
		result.message = messageFor(result, reason);
	};
	refresh();
	while (actionableErrorUtf8Bytes(result) > 4096 && result.validChoices?.length) {
		result.validChoices.pop();
		result.omittedChoiceCount = (result.omittedChoiceCount ?? 0) + 1;
		result.validChoicesTruncated = true;
	}
	if (actionableErrorUtf8Bytes(result) > 4096 && result.location?.value) {
		delete result.location.value;
		refresh();
	}
	if (actionableErrorUtf8Bytes(result) > 4096 && result.recovery.length > 1) {
		result.recovery = [result.recovery[0]];
		refresh();
	}
	if (actionableErrorUtf8Bytes(result) > 4096) {
		delete result.location;
		delete result.validChoices;
		delete result.validChoicesTruncated;
		delete result.omittedChoiceCount;
		refresh();
	}
	if (actionableErrorUtf8Bytes(result) > 4096) {
		result.message = messageFor({ ...result, operation: "Pi Bebop operation" }, "an unexpected failure occurred");
	}
	return result;
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
	return fitResult(
		{
			code,
			operation,
			message: "",
			...(location ? { location } : {}),
			recovery: boundedRecovery,
			...(choices.length ? { validChoices: choices } : {}),
			...(omitted ? { validChoicesTruncated: true, omittedChoiceCount: omitted } : {}),
		},
		reason,
	);
}
