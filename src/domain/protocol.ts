// Stable protocol barrel. Keep consumers importing through domain/index.ts; the
// focused modules below own schemas, types, command mapping, and wire helpers.
export * from "./protocol/wire-base.ts";
export * from "./protocol/wire-members.ts";
export * from "./protocol/wire-guests.ts";
export * from "./protocol/wire-rpc.ts";
export * from "./protocol/command-schemas.ts";
export * from "./protocol/protocol-types.ts";
export * from "./protocol/protocol-guards.ts";
export * from "./protocol/command-registry.ts";
export * from "./protocol/protocol-helpers.ts";
