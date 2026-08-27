/**
 * TASK-0058/0063: this module is reduced to types and UsageError. Tokenization
 * is owned by Commander (see commands/send.ts, commands/crew-init.ts); the
 * top-level parse dispatch lives in the parser facade (parser.ts) — keeping
 * this module import-free avoids the arguments↔parser module cycle.
 */

export type CliFormat = "toon" | "json" | "text";
export interface SendCliOptions {
	command: "send";
	socketPath?: string;
	crewPath?: string;
	message?: string;
	instructions: string[];
	origin?: { kind: "external"; label: string };
	stdin: boolean;
	mode: "steer" | "follow_up";
	wait: "turn_end" | "accepted";
	timeoutMs: number;
	format: CliFormat;
	full: boolean;
	/** Additive command-local help (TASK-0058 AC 6); only present when requested. */
	help?: boolean;
}

export class UsageError extends Error {
	readonly code = "usage";
}

export type CrewInitCliOptions = {
	readonly command: "crew-init";
	readonly project?: string;
	readonly from?: string;
	readonly ref?: string;
	readonly format: CliFormat;
	readonly help?: boolean;
};

export type CrewRolesCliOptions = {
	readonly command: "crew-roles";
	readonly format: CliFormat;
	/** Common boolean flag; accepted for parity, no command-specific formatting. */
	readonly full: boolean;
	readonly help?: boolean;
};

export type HomeCliOptions = {
	readonly command: "home";
	readonly format: CliFormat;
	readonly help?: boolean;
};

export type CliCommand = SendCliOptions | CrewInitCliOptions | CrewRolesCliOptions | HomeCliOptions;
