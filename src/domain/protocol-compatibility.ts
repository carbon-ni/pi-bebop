declare const __PI_BEBOP_PACKAGE_VERSION__: unknown;
declare const __PI_BEBOP_BUILD_COMMIT__: unknown;

/** Product-level protocol identity shared by the CLI and running Members. */
export const BEBOP_PROTOCOL = Object.freeze({ name: "pi-bebop", major: 1, minor: 0 });

/** Capabilities are protocol data, not a user-facing transport vocabulary. */
export const RUNTIME_CAPABILITIES = Object.freeze([
	"crew.status",
	"member.request",
	"member.request_start",
	"member.request_wait",
	"member.respond",
	"member.follow_up",
	"member.redirect",
	"member.inbox",
	"crew.broadcast",
	"member.interrupt",
	"member.last_message",
] as const);

/** Product actions that `bebop doctor` verifies on every reachable Member. */
export const REQUIRED_RUNTIME_CAPABILITIES = Object.freeze([
	"member.request_start",
	"member.request_wait",
	"member.respond",
	"member.follow_up",
	"member.redirect",
	"member.inbox",
	"crew.broadcast",
	"member.interrupt",
	"member.last_message",
] as const);

export type RuntimeProtocolVersion = { readonly major: number; readonly minor: number };
export interface RuntimeCompatibility {
	readonly product: "pi-bebop";
	readonly protocol: RuntimeProtocolVersion;
	readonly packageVersion: string;
	readonly buildCommit: string;
	readonly capabilities: readonly string[];
}

const PACKAGE_VERSION = typeof __PI_BEBOP_PACKAGE_VERSION__ === "string" ? __PI_BEBOP_PACKAGE_VERSION__ : "0.0.0-dev";
const BUILD_COMMIT =
	typeof __PI_BEBOP_BUILD_COMMIT__ === "string" && __PI_BEBOP_BUILD_COMMIT__.length > 0
		? __PI_BEBOP_BUILD_COMMIT__.toLowerCase()
		: "0".repeat(40);

export function currentRuntimeCompatibility(): RuntimeCompatibility {
	return {
		product: "pi-bebop",
		protocol: { ...BEBOP_PROTOCOL },
		packageVersion: PACKAGE_VERSION,
		buildCommit: BUILD_COMMIT,
		capabilities: [...RUNTIME_CAPABILITIES],
	};
}

export function protocolVersionRelation(version: RuntimeProtocolVersion): "older" | "current" | "newer" {
	if (version.major < BEBOP_PROTOCOL.major) return "older";
	if (version.major > BEBOP_PROTOCOL.major) return "newer";
	if (version.minor < BEBOP_PROTOCOL.minor) return "older";
	if (version.minor > BEBOP_PROTOCOL.minor) return "newer";
	return "current";
}

export function isSemver(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
	);
}

export function isFullBuildCommit(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}
