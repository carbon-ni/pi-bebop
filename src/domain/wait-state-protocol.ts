import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { WaitStateSnapshotSchema } from "./blocking-wait-state.ts";
import type { Static } from "@sinclair/typebox";

const JSON_RPC_VERSION = "2.0" as const;
const RpcIdSchema = Type.Union([Type.String({ minLength: 1 }), Type.Integer()]);
const MemberStatusTargetSchema = Type.String({ minLength: 1, maxLength: 256 });

export const WaitStateParamsSchema = Type.Object({ member: MemberStatusTargetSchema }, { additionalProperties: false });
export const WaitStateSnapshotResultSchema = Type.Object(
	{
		subscriptionId: Type.String({ minLength: 1 }),
		snapshot: WaitStateSnapshotSchema,
	},
	{ additionalProperties: false },
);
export const WaitStateRequestSchema = Type.Object(
	{
		jsonrpc: Type.Literal(JSON_RPC_VERSION),
		id: RpcIdSchema,
		method: Type.Literal("member.wait_state"),
		params: WaitStateParamsSchema,
	},
	{ additionalProperties: false },
);
export const WaitStateCommandSchema = Type.Object(
	{
		type: Type.Literal("wait_state"),
		member: MemberStatusTargetSchema,
		id: Type.Optional(RpcIdSchema),
	},
	{ additionalProperties: false },
);
export const WaitStateNotificationSchema = Type.Object(
	{
		jsonrpc: Type.Literal(JSON_RPC_VERSION),
		method: Type.Literal("member.wait_state"),
		params: Type.Object(
			{
				subscriptionId: Type.String({ minLength: 1 }),
				snapshot: WaitStateSnapshotSchema,
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);
export function isWaitStateNotification(value: unknown): value is Static<typeof WaitStateNotificationSchema> {
	return Value.Check(WaitStateNotificationSchema, value);
}
export function buildWaitStateNotification(
	subscriptionId: string,
	snapshot: Static<typeof WaitStateSnapshotSchema>,
): Static<typeof WaitStateNotificationSchema> {
	const value = {
		jsonrpc: JSON_RPC_VERSION,
		method: "member.wait_state" as const,
		params: { subscriptionId, snapshot },
	};
	if (!isWaitStateNotification(value)) throw new Error("Invalid wait-state notification");
	return value;
}
