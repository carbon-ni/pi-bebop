import { Type } from "@sinclair/typebox";
import { JSON_RPC_VERSION, RpcIdSchema } from "./wire-base.ts";

/** Read-only exchange used by CLI diagnostics. It never carries credentials or routing data. */
export const RuntimeCompatibilityParamsSchema = Type.Object({}, { additionalProperties: false });
export const RuntimeCompatibilityRequestSchema = Type.Object(
	{
		jsonrpc: Type.Literal(JSON_RPC_VERSION),
		id: RpcIdSchema,
		method: Type.Literal("runtime.compatibility"),
		params: RuntimeCompatibilityParamsSchema,
	},
	{ additionalProperties: false },
);
export const RuntimeCompatibilityCommandSchema = Type.Object(
	{ type: Type.Literal("runtime_compatibility"), id: Type.Optional(RpcIdSchema) },
	{ additionalProperties: false },
);
export const RuntimeCompatibilityResultSchema = Type.Object(
	{
		product: Type.Literal("pi-bebop"),
		protocol: Type.Object(
			{
				name: Type.Literal("pi-bebop"),
				major: Type.Integer({ minimum: 0 }),
				minor: Type.Integer({ minimum: 0 }),
			},
			{ additionalProperties: false },
		),
		packageVersion: Type.String({ minLength: 1, maxLength: 64 }),
		buildCommit: Type.String({ minLength: 1, maxLength: 64 }),
		capabilities: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 128 }),
	},
	{ additionalProperties: false },
);
