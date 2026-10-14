import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { TSchema } from "typebox";

/** Pi 1.1 tool fields are kept structural so the extension remains source-compatible with 0.84 hosts. */
export type CodemodeToolExposure = "direct" | "model-only" | "codemode" | "deferred" | "hidden";

type CodemodeToolDefinition<TParams extends TSchema, TDetails> = ToolDefinition<TParams, TDetails> & {
	readonly exposure?: CodemodeToolExposure;
	readonly outputSchema?: TSchema;
};

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

const memberIdentitySchema = Type.Object({ name: Type.String(), role: Type.String() }, { additionalProperties: false });
const errorSchema = Type.Optional(Type.String());
const summarySchema = Type.Object(
	{ delivered: Type.Integer(), failed: Type.Integer(), total: Type.Integer() },
	{ additionalProperties: false },
);

export const broadcastOutputSchema = Type.Object(
	{
		summary: Type.Optional(summarySchema),
		recipients: Type.Optional(
			Type.Array(
				Type.Object(
					{
						member: Type.String(),
						role: Type.String(),
						disposition: Type.String(),
						deliveryId: Type.Optional(Type.String()),
						code: Type.Optional(Type.String()),
					},
					{ additionalProperties: false },
				),
			),
		),
		error: errorSchema,
	},
	{ additionalProperties: false },
);

export const statusOutputSchema = Type.Object(
	{
		status: Type.Optional(
			Type.Object(
				{
					member: memberIdentitySchema,
					presence: Type.String(),
					activity: Type.String(),
					hasPendingMessages: Type.Union([Type.Boolean(), Type.Literal("unavailable")]),
					observedAt: Type.String(),
				},
				{ additionalProperties: false },
			),
		),
		error: errorSchema,
	},
	{ additionalProperties: false },
);

export const inboxOutputSchema = Type.Object(
	{
		itemId: Type.Optional(Type.String()),
		persisted: Type.Optional(Type.Boolean()),
		target: Type.Optional(Type.String()),
		error: errorSchema,
	},
	{ additionalProperties: false },
);

export const memberRequestOutputSchema = Type.Object(
	{
		accepted: Type.Optional(Type.Boolean()),
		requestId: Type.Optional(Type.String()),
		member: Type.Optional(memberIdentitySchema),
		error: errorSchema,
	},
	{ additionalProperties: false },
);

export const responseOutputSchema = Type.Object(
	{ requestId: Type.Optional(Type.String()), error: errorSchema },
	{ additionalProperties: false },
);

const requestOutcomeSchema = Type.Object(
	{
		kind: Type.String(),
		requestId: Type.String(),
		member: memberIdentitySchema,
		requestAgeMs: Type.Optional(Type.Number()),
		reason: Type.Optional(Type.String()),
		message: Type.Optional(Type.String()),
		instructions: Type.Optional(Type.Array(Type.String())),
	},
	{ additionalProperties: false },
);
const idleOutcomeSchema = Type.Object(
	{
		member: memberIdentitySchema,
		outcome: Type.String(),
		observedAt: Type.String(),
		disposition: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);
export const waitOutputSchema = Type.Object(
	{
		result: Type.Optional(requestOutcomeSchema),
		outcome: Type.Optional(idleOutcomeSchema),
		request_id: Type.Optional(Type.String()),
		error: errorSchema,
	},
	{ additionalProperties: false },
);

export const interruptOutputSchema = Type.Object(
	{
		interruptId: Type.Optional(Type.String()),
		disposition: Type.Optional(Type.String()),
		error: errorSchema,
	},
	{ additionalProperties: false },
);

export const guestBroadcastOutputSchema = Type.Object({
	summary: Type.Optional(summarySchema),
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

export function projectError(details: unknown): Record<string, unknown> {
	return isRecord(details) && typeof details.error === "string"
		? { error: details.error }
		: { error: "invalid-result" };
}

export function projectStatusDetails(details: unknown): Record<string, unknown> {
	if (!isRecord(details)) return { error: "invalid-result" };
	if (typeof details.error === "string") return { error: details.error };
	const status = isRecord(details.status) ? details.status : undefined;
	const member = publicMember(status?.member);
	if (
		status === undefined ||
		member === undefined ||
		typeof status.presence !== "string" ||
		typeof status.activity !== "string" ||
		(typeof status.hasPendingMessages !== "boolean" && status.hasPendingMessages !== "unavailable") ||
		typeof status.observedAt !== "string"
	)
		return { error: "invalid-result" };
	return {
		status: {
			member,
			presence: status.presence,
			activity: status.activity,
			hasPendingMessages: status.hasPendingMessages,
			observedAt: status.observedAt,
		},
	};
}

export function projectBroadcastDetails(details: unknown): Record<string, unknown> {
	if (!isRecord(details)) return { error: "invalid-result" };
	if (typeof details.error === "string") return { error: details.error };
	const summary = isRecord(details) && isRecord(details.summary) ? details.summary : undefined;
	const recipients = Array.isArray(details.recipients) ? details.recipients : undefined;
	return {
		...(summary && [summary.delivered, summary.failed, summary.total].every((value) => typeof value === "number")
			? { summary: { delivered: summary.delivered, failed: summary.failed, total: summary.total } }
			: {}),
		...(recipients
			? {
					recipients: recipients.flatMap((item) => {
						if (
							!isRecord(item) ||
							typeof item.member !== "string" ||
							typeof item.role !== "string" ||
							typeof item.disposition !== "string"
						)
							return [];
						return [
							{
								member: item.member,
								role: item.role,
								disposition: item.disposition,
								...(typeof item.deliveryId === "string" ? { deliveryId: item.deliveryId } : {}),
								...(typeof item.code === "string" ? { code: item.code } : {}),
							},
						];
					}),
				}
			: {}),
	};
}

export function projectInboxDetails(details: unknown): Record<string, unknown> {
	if (!isRecord(details)) return { error: "invalid-result" };
	if (typeof details.error === "string") return { error: details.error };
	return {
		...(typeof details.itemId === "string" ? { itemId: details.itemId } : {}),
		...(typeof details.persisted === "boolean" ? { persisted: details.persisted } : {}),
		...(typeof details.target === "string" ? { target: details.target } : {}),
	};
}

export function projectMemberRequestDetails(details: unknown): Record<string, unknown> {
	if (!isRecord(details)) return { error: "invalid-result" };
	if (typeof details.error === "string") return { error: details.error };
	const member = publicMember(details.member);
	return {
		...(typeof details.accepted === "boolean" ? { accepted: details.accepted } : {}),
		...(typeof details.requestId === "string" ? { requestId: details.requestId } : {}),
		...(member === undefined ? {} : { member }),
	};
}

export function projectResponseDetails(details: unknown): Record<string, unknown> {
	if (!isRecord(details)) return { error: "invalid-result" };
	if (typeof details.error === "string") return { error: details.error };
	return typeof details.requestId === "string" ? { requestId: details.requestId } : {};
}

function projectRequestOutcome(value: unknown): Record<string, unknown> | undefined {
	if (!isRecord(value) || typeof value.kind !== "string" || typeof value.requestId !== "string") return undefined;
	const member = publicMember(value.member);
	if (member === undefined) return undefined;
	return {
		kind: value.kind,
		requestId: value.requestId,
		member,
		...(typeof value.requestAgeMs === "number" ? { requestAgeMs: value.requestAgeMs } : {}),
		...(typeof value.reason === "string" ? { reason: value.reason } : {}),
		...(typeof value.message === "string" ? { message: value.message } : {}),
		...(Array.isArray(value.instructions)
			? { instructions: value.instructions.filter((item): item is string => typeof item === "string") }
			: {}),
	};
}

function projectIdleOutcome(value: unknown): Record<string, unknown> | undefined {
	if (!isRecord(value) || typeof value.outcome !== "string" || typeof value.observedAt !== "string") return undefined;
	const member = publicMember(value.member);
	if (member === undefined) return undefined;
	return {
		member,
		outcome: value.outcome,
		observedAt: value.observedAt,
		...(typeof value.disposition === "string" ? { disposition: value.disposition } : {}),
	};
}

export function projectWaitDetails(details: unknown): Record<string, unknown> {
	if (!isRecord(details)) return { error: "invalid-result" };
	if (typeof details.error === "string") return { error: details.error };
	const outcome = projectIdleOutcome(details.outcome);
	const result = projectRequestOutcome(details.result);
	return {
		...(typeof details.request_id === "string" ? { request_id: details.request_id } : {}),
		...(outcome === undefined ? {} : { outcome }),
		...(result === undefined ? {} : { result }),
	};
}

export function projectInterruptDetails(details: unknown): Record<string, unknown> {
	if (!isRecord(details)) return { error: "invalid-result" };
	if (typeof details.error === "string") return { error: details.error };
	return {
		...(typeof details.interruptId === "string" ? { interruptId: details.interruptId } : {}),
		...(typeof details.disposition === "string" ? { disposition: details.disposition } : {}),
	};
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
		readonly outputSchema: unknown;
		readonly projectDetails: (details: unknown) => unknown;
	},
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
		outputSchema: options.outputSchema,
		execute: async (...args: Parameters<typeof originalExecute>) => {
			const result = await execute(...args);
			if (result === null || typeof result !== "object" || !("structuredContent" in result)) return result;
			return {
				...result,
				structuredContent: options.projectDetails((result as { structuredContent: unknown }).structuredContent),
			};
		},
	} as never);
}
