/**
 * Shared CLI value types and the usage-error class. Command grammar is owned
 * by Commander builders (see commands/*.ts); this module stays import-free to
 * avoid support-module cycles.
 */

export type CliFormat = "toon" | "json" | "text";

export class UsageError extends Error {
	readonly code = "usage";
}

export type CrewInitCliOptions = {
	readonly command: "crew-init";
	readonly project?: string;
	readonly format: CliFormat;
};

export type CrewRolesCliOptions = {
	readonly command: "crew-roles";
	readonly format: CliFormat;
	/** Common boolean flag; accepted for parity, no command-specific formatting. */
	readonly full: boolean;
};
