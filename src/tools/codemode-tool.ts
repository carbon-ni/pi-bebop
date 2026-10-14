import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { TSchema } from "typebox";

/** Pi 1.1 tool fields are kept structural so the extension remains source-compatible with 0.84 hosts. */
export type CodemodeToolExposure = "direct" | "model-only" | "codemode" | "deferred" | "hidden";

type CodemodeToolDefinition<TParams extends TSchema, TDetails> = ToolDefinition<TParams, TDetails> & {
	readonly exposure?: CodemodeToolExposure;
	readonly outputSchema?: TSchema;
};

const structuredResultSchema = Type.Record(Type.String(), Type.Any());

export const memberDeliveryOutputSchema = Type.Object({
	member: Type.Optional(Type.Object({ name: Type.String(), role: Type.String() })),
	deliveryId: Type.Optional(Type.String()),
	disposition: Type.Optional(Type.String()),
	error: Type.Optional(Type.String()),
});

export const guestMessageOutputSchema = Type.Object({
	target: Type.Optional(Type.Object({ name: Type.String(), role: Type.String() })),
	deliveryId: Type.Optional(Type.String()),
	disposition: Type.Optional(Type.String()),
	fromGuestName: Type.Optional(Type.String()),
	error: Type.Optional(Type.String()),
});

export const guestBroadcastOutputSchema = Type.Object({
	summary: Type.Optional(Type.Object({ delivered: Type.Integer(), failed: Type.Integer(), total: Type.Integer() })),
	recipients: Type.Optional(
		Type.Array(
			Type.Object({
				member: Type.String(),
				role: Type.String(),
				disposition: Type.String(),
				deliveryId: Type.Optional(Type.String()),
				code: Type.Optional(Type.String()),
			}),
		),
	),
	error: Type.Optional(Type.String()),
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function publicMember(value: unknown): { name: string; role: string } | undefined {
	if (!isRecord(value) || typeof value.name !== "string" || typeof value.role !== "string") return undefined;
	return { name: value.name, role: value.role };
}

export function projectMemberDeliveryDetails(details: unknown): Record<string, unknown> {
	if (!isRecord(details)) return { error: "invalid-result" };
	if (typeof details.error === "string") return { error: details.error };
	const member = publicMember(details.member);
	return {
		...(member === undefined ? {} : { member }),
		...(typeof details.deliveryId === "string" ? { deliveryId: details.deliveryId } : {}),
		...(typeof details.disposition === "string" ? { disposition: details.disposition } : {}),
	};
}

export function projectGuestMessageDetails(details: unknown): Record<string, unknown> {
	if (!isRecord(details)) return { error: "invalid-result" };
	if (typeof details.error === "string") return { error: details.error };
	const target = publicMember(details.target);
	return {
		...(target === undefined ? {} : { target }),
		...(typeof details.deliveryId === "string" ? { deliveryId: details.deliveryId } : {}),
		...(typeof details.disposition === "string" ? { disposition: details.disposition } : {}),
		...(typeof details.fromGuestName === "string" ? { fromGuestName: details.fromGuestName } : {}),
	};
}

export function projectGuestBroadcastDetails(details: unknown): Record<string, unknown> {
	if (!isRecord(details)) return { error: "invalid-result" };
	if (typeof details.error === "string") return { error: details.error };
	const summary = isRecord(details.summary) ? details.summary : undefined;
	const dispositions = Array.isArray(details.dispositions) ? details.dispositions : undefined;
	return {
		...(summary &&
		typeof summary.delivered === "number" &&
		typeof summary.failed === "number" &&
		typeof summary.total === "number"
			? { summary: { delivered: summary.delivered, failed: summary.failed, total: summary.total } }
			: {}),
		...(dispositions
			? {
					recipients: dispositions.flatMap((item) => {
						if (
							!isRecord(item) ||
							typeof item.recipientName !== "string" ||
							typeof item.recipientRole !== "string"
						)
							return [];
						return [
							{
								member: item.recipientName,
								role: item.recipientRole,
								disposition: typeof item.disposition === "string" ? item.disposition : "failed",
								...(typeof item.deliveryId === "string" ? { deliveryId: item.deliveryId } : {}),
								...(typeof item.code === "string" ? { code: item.code } : {}),
							},
						];
					}),
				}
			: {}),
	};
}

/**
 * Register a tool with a structured result for codemode callers.
 *
 * Direct tools remain model-callable and are callable from codemode while active.
 * Model-only tools remain model-callable but are deliberately excluded from nested
 * codemode calls; use this for blocking waits whose termination semantics belong to
 * the host turn.
 */
export function registerBebopTool<TParams extends TSchema, TDetails>(
	pi: ExtensionAPI,
	tool: CodemodeToolDefinition<TParams, TDetails>,
	options: {
		readonly exposure?: CodemodeToolExposure;
		readonly executionMode?: "parallel" | "sequential";
		readonly outputSchema?: unknown;
		readonly projectDetails?: (details: unknown) => unknown;
	} = {},
): void {
	const originalExecute = tool.execute;
	const execute = async (...args: Parameters<typeof originalExecute>) => {
		const result = await originalExecute(...args);
		if (result === null || typeof result !== "object" || !("details" in result)) return result;
		return { ...result, structuredContent: (result as { details: unknown }).details };
	};

	pi.registerTool({
		...tool,
		...(options.exposure === undefined ? {} : { exposure: options.exposure }),
		executionMode: options.executionMode ?? "parallel",
		outputSchema: options.outputSchema ?? structuredResultSchema,
		execute: async (...args: Parameters<typeof originalExecute>) => {
			const result = await execute(...args);
			if (result === null || typeof result !== "object" || !("structuredContent" in result)) return result;
			return {
				...result,
				structuredContent: options.projectDetails
					? options.projectDetails((result as { structuredContent: unknown }).structuredContent)
					: (result as { structuredContent: unknown }).structuredContent,
			};
		},
	} as never);
}
