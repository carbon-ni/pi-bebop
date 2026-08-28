/**
 * TASK-0088 frozen v1 Actionable Error inventory.
 *
 * Normative source: docs/ACTIONABLE-ERRORS.md ("Finite v1 inventory", frozen
 * at source commit 64bd150). These named sets — not a count of string
 * literals — are the finite migration unit. Every listed boundary must end
 * the migration either constructing the shared presentation or carrying a
 * reviewed exemption entry (owner, reason, external owner) in
 * error-boundary-baseline.json.
 *
 * The runtime equality tests in actionable-error-inventory.test.ts fail when
 * a new surface is registered without an inventory decision, and
 * scripts/error-boundary-check.mjs fails when a frozen boundary adds a new
 * direct error render outside the shared presenter.
 */

/** CLI registry leaves (CLI-ROOT/CLI-LEAF groups): 11 explicit commands plus home. */
export const ACTIONABLE_ERROR_CLI_LEAVES = [
	"home",
	"send",
	"crew-init",
	"crew-roles",
	"member-status",
	"member-idle-wait",
	"session-list",
	"member-follow-up",
	"member-redirect",
	"member-inbox-send",
	"member-interrupt",
	"crew-broadcast",
] as const;

/** Registered Pi agent tools (TOOL group). */
export const ACTIONABLE_ERROR_TOOLS = [
	"send_follow_up",
	"redirect_member",
	"send_to_inbox",
	"broadcast_to_crew",
	"interrupt_member",
	"get_member_status",
	"wait_for_member_idle",
	"send_member_request",
	"respond_to_member_request",
	"wait_for_request_outcome",
	"leave_crew_post",
	"read_crew_board",
] as const;

/** `/crew` top-level action vocabulary (PI-COMMAND group). */
export const ACTIONABLE_ERROR_CREW_ACTIONS = [
	"join",
	"leave",
	"members",
	"status",
	"stop",
	"agreements",
	"inbox",
	"board",
	"post",
] as const;

/** `/crew` bounded subaction vocabulary (PI-COMMAND group). */
export const ACTIONABLE_ERROR_CREW_SUBACTIONS = {
	agreements: ["activate"],
	inbox: ["status", "cancel", "pause", "resume"],
} as const;

/** Presenter boundary modules (PI-STARTUP / PI-LIFECYCLE groups). */
export const ACTIONABLE_ERROR_BOUNDARY_MODULES = {
	cli: ["src/cli/run.ts", "src/cli/errors.ts", "src/cli/output.ts", "src/cli/main.ts"],
	piStartup: ["src/pi/session-start.ts", "src/pi/startup-send.ts"],
	piLifecycle: ["src/extension.ts"],
} as const;

/**
 * Reviewed exemption table shape. An exemption permits direct rendering only
 * for an external owner that controls the wording; entries live in
 * error-boundary-baseline.json under `exemptions` and must cite owner,
 * reason, and the external component.
 */
export interface ActionableErrorExemption {
	readonly file: string;
	readonly reason: string;
	readonly owner: string;
	readonly externalComponent: string;
}
