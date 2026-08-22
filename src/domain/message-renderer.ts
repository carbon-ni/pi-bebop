import type { MessagePayload } from "./message-payload.ts";

const bytes = (value: string): number => Buffer.byteLength(value, "utf8");

/**
 * Renders user-level message context without XML/JSON sentinels. Length labels
 * make delimiters inside arbitrary user text data rather than structure.
 */
export function renderMessagePayload(payload: MessagePayload): string {
	const hasMetadata = payload.origin !== undefined || payload.instructions !== undefined;
	if (!hasMetadata) return payload.content;
	const sections: string[] = [];
	if (payload.origin) {
		const origin =
			payload.origin.kind === "crew"
				? `from ${payload.origin.name} (${payload.origin.role})`
				: `from ${payload.origin.label}`;
		sections.push(`Claimed origin: ${origin}`);
	}
	if (payload.instructions) {
		sections.push(
			[
				`Instructions (${payload.instructions.length}):`,
				...payload.instructions.map(
					(instruction, index) => `Instruction ${index + 1} (${bytes(instruction)} bytes):\n${instruction}`,
				),
			].join("\n"),
		);
	}
	sections.push(`Content (${bytes(payload.content)} bytes):\n${payload.content}`);
	return sections.join("\n\n");
}
