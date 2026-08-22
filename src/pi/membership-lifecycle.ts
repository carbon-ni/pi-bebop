import type { MembershipRuntime } from "../infra/membership-runtime.ts";
import type { PersistedMembershipState } from "./membership-context.ts";

export type MembershipServerMode = "disable" | "enable" | "ensure";

export function chooseMembershipServerMode(input: {
	readonly controlRequested: boolean;
	readonly configEnabled: boolean;
	readonly startupSocketSelected: boolean;
	readonly persistedMembershipActive: boolean;
}): MembershipServerMode {
	if (input.startupSocketSelected || input.persistedMembershipActive) return "ensure";
	if (input.controlRequested || input.configEnabled) return "enable";
	return "disable";
}

export async function prepareMembershipServer(
	mode: MembershipServerMode,
	deps: {
		readonly ensure: () => Promise<void>;
		readonly enable: () => Promise<void>;
		readonly disable: () => Promise<void>;
	},
): Promise<void> {
	if (mode === "ensure") return deps.ensure();
	if (mode === "enable") return deps.enable();
	return deps.disable();
}

export interface MembershipRestoreDeps {
	readonly runtime: Pick<MembershipRuntime, "join">;
	readonly persisted: PersistedMembershipState | null;
	readonly startupSocketSelected: boolean;
	readonly globalSocketPath: string | undefined;
	readonly manifestPathForSocket: (socketPath: string) => string;
	readonly announce: (message: string) => void;
	readonly reportFailure: (message: string) => void;
}

export async function restorePersistedMembership(deps: MembershipRestoreDeps): Promise<boolean> {
	if (deps.startupSocketSelected || !deps.persisted?.active || !deps.globalSocketPath) return false;
	const result = await deps.runtime.join({
		manifestPath: deps.persisted.manifestPath ?? deps.manifestPathForSocket(deps.persisted.socketPath),
		socketPath: deps.persisted.socketPath,
		globalSocketPath: deps.globalSocketPath,
	});
	if ("error" in result) {
		deps.reportFailure(result.error.message);
		return false;
	}
	deps.announce(
		`Crew restored ${result.membership.member.name} (${result.membership.member.role}) at ${result.membership.socketPath}`,
	);
	return true;
}

export async function releaseMembershipBeforeCleanup(deps: {
	readonly hasMembership: boolean;
	readonly leave: () => Promise<unknown>;
	readonly cleanup: () => Promise<void>;
	readonly reportFailure: (message: string) => void;
	readonly onReleased?: () => void | Promise<void>;
}): Promise<void> {
	try {
		if (deps.hasMembership) {
			const result = await deps.leave();
			if (result && typeof result === "object" && "error" in result && result.error instanceof Error)
				throw result.error;
			if (result && typeof result === "object" && "left" in result && result.left === true)
				await deps.onReleased?.();
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		deps.reportFailure(`Crew membership release failed: ${message}`);
	} finally {
		await deps.cleanup();
	}
}
