import { Type } from "@sinclair/typebox";
import { JSON_RPC_VERSION, RpcIdSchema } from "./wire-base.ts";

const SessionCaptureCrewSchema = Type.Object(
	{
		id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
		displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
	},
	{ additionalProperties: false },
);
const SessionCaptureMemberSchema = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: 128 }),
		role: Type.String({ minLength: 1, maxLength: 128 }),
	},
	{ additionalProperties: false },
);
const SessionCaptureEvidenceSchema = Type.Object(
	{
		persisted: Type.Boolean(),
		id: Type.String({ minLength: 1, maxLength: 256 }),
		file: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
		cwd: Type.String({ minLength: 1, maxLength: 4096 }),
		root: Type.String({ minLength: 1, maxLength: 4096 }),
	},
	{ additionalProperties: false },
);
export const SessionCaptureRequestSchema = Type.Object(
	{
		jsonrpc: Type.Literal(JSON_RPC_VERSION),
		id: RpcIdSchema,
		method: Type.Literal("session.capture"),
		params: Type.Object({}, { additionalProperties: false }),
	},
	{ additionalProperties: false },
);
export const SessionCaptureCommandSchema = Type.Object(
	{ type: Type.Literal("session_capture"), id: Type.Optional(RpcIdSchema) },
	{ additionalProperties: false },
);
export const SessionCaptureResultSchema = Type.Object(
	{
		crewLocator: Type.String({ minLength: 1, maxLength: 4096 }),
		crew: SessionCaptureCrewSchema,
		member: SessionCaptureMemberSchema,
		session: SessionCaptureEvidenceSchema,
	},
	{ additionalProperties: false },
);
