import { getAliasPath, getSocketPath } from "../infra/intray-paths.ts";
import { isSafeAlias, isSafeSessionId } from "../domain/index.ts";

/**
 * TASK-0061: leaf-command-local source-session resolution. Deterministic and
 * IO-free: explicit `--session <id|alias>` wins; an unsafe/oversized explicit
 * value never falls back; without the flag, a safe exact `PI_SESSION_ID` is
 * used (never an alias); without either, `session-required` with the copyable
 * `pi-bebop session list` hint.
 *
 * Id-versus-alias cannot be decided without IO, so the pure stage returns both
 * candidate paths: the session-id socket first, then the alias symlink. The
 * transport (the only place that touches the filesystem) tries id, falls back
 * to alias, and reports `unknown-session` when neither exists.
 */

export interface SourceSessionInput {
	/** Value of the leaf-command-local `--session` flag (id or alias). */
	readonly explicitSession?: string;
	/** Value of the injected `PI_SESSION_ID` environment (exact session id only). */
	readonly environmentSession?: string;
}

export type SourceResolution =
	| {
			readonly ok: true;
			/** The value is interpreted as a session id first; alias is the connect fallback. */
			readonly kind: "id";
			readonly idSocketPath: string;
			readonly aliasSocketPath: string;
	  }
	| { readonly ok: false; readonly code: "session-required" | "invalid-session"; readonly message: string };

export const SESSION_LIST_HINT = "pi-bebop session list";

export function resolveSourceSession(input: SourceSessionInput): SourceResolution {
	const explicit = input.explicitSession;
	if (explicit !== undefined && explicit !== "") {
		if (!isSafeSessionId(explicit) && !isSafeAlias(explicit))
			return {
				ok: false,
				code: "invalid-session",
				message: `Invalid --session '${explicit}'; use a safe session id or alias, or ${SESSION_LIST_HINT}`,
			};
		return { ok: true, kind: "id", idSocketPath: getSocketPath(explicit), aliasSocketPath: getAliasPath(explicit) };
	}
	const environment = input.environmentSession;
	if (environment !== undefined && environment !== "") {
		if (!isSafeSessionId(environment))
			return {
				ok: false,
				code: "invalid-session",
				message: `Invalid PI_SESSION_ID '${environment}'; the environment fallback accepts a safe exact session id only`,
			};
		return {
			ok: true,
			kind: "id",
			idSocketPath: getSocketPath(environment),
			aliasSocketPath: getAliasPath(environment),
		};
	}
	return {
		ok: false,
		code: "session-required",
		message: `No source session; pass --session <id|alias> or set PI_SESSION_ID, or run ${SESSION_LIST_HINT}`,
	};
}
