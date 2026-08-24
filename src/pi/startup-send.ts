import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readTrustedCrewManifest, selectCrewSocketPath } from "../infra/crew-manifest-store.ts";
import type { MembershipRuntime } from "../infra/membership-runtime.ts";
import { getSocketPath } from "../infra/intray-paths.ts";
import { isSocketAlive, resolveSessionIdFromAlias } from "../infra/control-store.ts";
import { sendRpcCommand } from "../infra/rpc-client.ts";
import { promises as fs } from "node:fs";
import { getTrustedCrewManifestPaths } from "../infra/crew-layout.ts";
import { selectCrewMemberByRole } from "../domain/index.ts";
import {
	isSafeSessionId,
	normalizeMode,
	normalizeWaitUntil,
	type RpcSendCommand,
	type WaitUntil,
} from "../domain/index.ts";

export type StartupControlSendFlags = {
	target: string;
	message: string;
	mode: string;
	wait: string;
	includeSender: string;
};

type StartupControlSendOptions = {
	target: string;
	message: string;
	mode: "steer" | "follow_up";
	waitUntil?: WaitUntil;
	includeSenderInfo: boolean;
};

function getStringFlag(pi: ExtensionAPI, name: string): string | undefined {
	const value = pi.getFlag(name);
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function parseStartupControlSendOptions(
	pi: ExtensionAPI,
	flags: StartupControlSendFlags,
): { options?: StartupControlSendOptions; error?: string } {
	const target = getStringFlag(pi, flags.target);
	const message = getStringFlag(pi, flags.message);

	if (!target && !message) {
		return {};
	}
	if (target && !message) {
		return { error: `Missing --${flags.message} (required with --${flags.target})` };
	}
	if (!target && message) {
		return { error: `Missing --${flags.target} (required with --${flags.message})` };
	}

	const rawMode = getStringFlag(pi, flags.mode) ?? "steer";
	const mode = normalizeMode(rawMode);
	if (!mode) {
		return { error: `Invalid --${flags.mode}: ${rawMode}. Use steer|follow_up.` };
	}

	const rawWait = getStringFlag(pi, flags.wait);
	let waitUntil: WaitUntil | undefined;
	if (rawWait) {
		const normalized = normalizeWaitUntil(rawWait);
		if (!normalized) {
			return {
				error: `Invalid --${flags.wait}: ${rawWait}. Use turn_end|message_processed|off.`,
			};
		}
		waitUntil = normalized;
	}

	const includeSenderInfo = pi.getFlag(flags.includeSender) === true;

	return {
		options: {
			target: target!,
			message: message!,
			mode,
			waitUntil,
			includeSenderInfo,
		},
	};
}

export interface StartupSocketSelectionFlags {
	socket: string;
}

export interface StartupRoleSelectionFlags {
	role: string;
}

export type StartupRoleSelection =
	| { readonly ok: true; readonly manifestPath: string; readonly socketPath: string }
	| {
			readonly ok: false;
			readonly code:
				| "untrusted-project"
				| "empty-role"
				| "unknown-role"
				| "ambiguous-role"
				| "missing-manifest"
				| "ambiguous-manifest";
			readonly role: string;
			readonly availableRoles?: readonly string[];
			readonly omittedRoleCount?: number;
	  };

export interface StartupRoleResolverDependencies {
	readonly manifestExists: (manifestPath: string) => Promise<boolean>;
	readonly readManifest: (
		manifestPath: string,
		projectRoot: string,
	) => Promise<import("../domain/index.ts").CrewManifest>;
}

const defaultStartupRoleResolverDependencies: StartupRoleResolverDependencies = {
	manifestExists: async (manifestPath) => {
		try {
			await fs.access(manifestPath);
			return true;
		} catch {
			return false;
		}
	},
	readManifest: (manifestPath, projectRoot) => readTrustedCrewManifest(manifestPath, projectRoot, () => true),
};

export async function resolveStartupCrewRole(
	role: string,
	cwd: string,
	isProjectTrusted: boolean,
	dependencies: StartupRoleResolverDependencies = defaultStartupRoleResolverDependencies,
): Promise<StartupRoleSelection> {
	if (!isProjectTrusted) return { ok: false, code: "untrusted-project", role: role.trim() };
	const normalizedRole = role.trim();
	if (!normalizedRole) return { ok: false, code: "empty-role", role };
	const manifestPaths = getTrustedCrewManifestPaths(cwd);
	const existing = (
		await Promise.all(
			manifestPaths.map(async (manifestPath) => ({
				manifestPath,
				exists: await dependencies.manifestExists(manifestPath),
			})),
		)
	).filter((item) => item.exists);
	if (existing.length === 0) return { ok: false, code: "missing-manifest", role: normalizedRole };
	if (existing.length > 1) return { ok: false, code: "ambiguous-manifest", role: normalizedRole };
	const manifestPath = existing[0]!.manifestPath;
	const manifest = await dependencies.readManifest(manifestPath, cwd);
	const selection = selectCrewMemberByRole(manifest, normalizedRole);
	if (selection.kind === "match") return { ok: true, manifestPath, socketPath: selection.member.socketPath };
	if (selection.kind === "ambiguous-role") return { ok: false, code: selection.kind, role: selection.role };
	if (selection.kind === "empty-role") return { ok: false, code: selection.kind, role: selection.role };
	return {
		ok: false,
		code: selection.kind,
		role: selection.role,
		availableRoles: selection.availableRoles,
		omittedRoleCount: selection.omittedRoleCount,
	};
}

export function normalizeStartupSocketPath(rawPath: string, cwd: string): string | null {
	const value = rawPath.trim();
	if (!value) return null;
	const withoutPrefix = value.startsWith("@") ? value.slice(1) : value;
	if (!withoutPrefix) return null;
	return path.resolve(cwd, withoutPrefix);
}

export function startupRoleSelectionError(selection: Extract<StartupRoleSelection, { ok: false }>): string {
	let detail = `role '${selection.role}'`;
	if (selection.code === "unknown-role") {
		const roles = selection.availableRoles ?? [];
		detail += ` is unknown; available roles: [${roles.join(", ")}] (omittedRoleCount=${selection.omittedRoleCount ?? 0})`;
	} else if (selection.code === "ambiguous-role") {
		detail += " is ambiguous; use --crew-socket to select an explicit endpoint";
	} else if (selection.code === "missing-manifest") {
		detail = "no supported crew manifest found beneath the project";
	} else if (selection.code === "ambiguous-manifest") {
		detail = "both supported crew manifests exist; remove one or use --crew-socket";
	} else if (selection.code === "empty-role") {
		detail = "role must be non-empty";
	} else if (selection.code === "untrusted-project") {
		detail = "project is not trusted";
	}
	return detail;
}

function reportStartupControlSend(
	ctx: ExtensionContext,
	message: string,
	level: "info" | "warning" | "error" = "info",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
		return;
	}
	if (level === "error") {
		console.error(message);
		return;
	}
	console.log(message);
}

export async function maybeHandleStartupSocketJoin(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	flags: StartupSocketSelectionFlags,
	membershipRuntime: MembershipRuntime | null,
	globalSocketPath: string | null,
): Promise<boolean> {
	const rawSocket = getStringFlag(pi, flags.socket);
	if (!rawSocket) return false;
	const selection = selectCrewSocketPath(rawSocket, ctx.cwd);
	if (!selection) {
		reportStartupControlSend(
			ctx,
			`Invalid --${flags.socket}: expected a .pi/bebop or .pi/crew sockets path.`,
			"error",
		);
		return false;
	}
	const { socketPath, manifestPath } = selection;
	if (!ctx.isProjectTrusted()) {
		reportStartupControlSend(ctx, "Crew startup join failed: project is not trusted", "error");
		return false;
	}
	if (!membershipRuntime || !globalSocketPath) {
		reportStartupControlSend(ctx, "Crew startup join failed: membership runtime is unavailable", "error");
		return false;
	}

	const result = await membershipRuntime.join({
		manifestPath,
		socketPath,
		globalSocketPath,
	});
	if ("error" in result) {
		reportStartupControlSend(ctx, `Crew startup join failed: ${result.error.message}`, "error");
		return false;
	}
	reportStartupControlSend(
		ctx,
		`Crew joined ${result.membership.member.name} (${result.membership.member.role}) at ${result.membership.socketPath}`,
	);
	return true;
}

export async function maybeHandleStartupRoleJoin(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	flags: StartupRoleSelectionFlags,
	membershipRuntime: MembershipRuntime | null,
	globalSocketPath: string | null,
	resolver: (role: string, cwd: string, trusted: boolean) => Promise<StartupRoleSelection> = resolveStartupCrewRole,
): Promise<boolean> {
	const rawRole = getStringFlag(pi, flags.role);
	if (!rawRole) return false;
	if (!ctx.isProjectTrusted()) {
		reportStartupControlSend(ctx, "Crew startup role join failed: project is not trusted", "error");
		return false;
	}
	if (!membershipRuntime || !globalSocketPath) {
		reportStartupControlSend(ctx, "Crew startup role join failed: membership runtime is unavailable", "error");
		return false;
	}
	let selection: StartupRoleSelection;
	try {
		selection = await resolver(rawRole, ctx.cwd, true);
	} catch (error) {
		reportStartupControlSend(
			ctx,
			`Crew startup role selection failed: ${error instanceof Error ? error.message : "manifest read failed"}`,
			"error",
		);
		return false;
	}
	if ("code" in selection) {
		reportStartupControlSend(
			ctx,
			`Crew startup role join failed: ${startupRoleSelectionError(selection)}`,
			"error",
		);
		return false;
	}
	const result = await membershipRuntime.join({
		manifestPath: selection.manifestPath,
		socketPath: selection.socketPath,
		globalSocketPath,
	});
	if ("error" in result) {
		reportStartupControlSend(ctx, `Crew startup role join failed: ${result.error.message}`, "error");
		return false;
	}
	reportStartupControlSend(
		ctx,
		`Crew joined ${result.membership.member.name} (${result.membership.member.role}) at ${result.membership.socketPath}`,
	);
	return true;
}

export async function maybeHandleStartupControlSend(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	flags: StartupControlSendFlags,
): Promise<void> {
	const parsed = parseStartupControlSendOptions(pi, flags);
	if (!parsed.options) {
		if (parsed.error) {
			reportStartupControlSend(ctx, parsed.error, "error");
		}
		return;
	}

	const { target, message, mode, waitUntil, includeSenderInfo } = parsed.options;
	let targetSessionId = await resolveSessionIdFromAlias(target);
	if (!targetSessionId && isSafeSessionId(target)) {
		targetSessionId = target;
	}

	if (!targetSessionId) {
		reportStartupControlSend(ctx, `Unknown target session: ${target}`, "error");
		return;
	}

	const socketPath = getSocketPath(targetSessionId);
	const alive = await isSocketAlive(socketPath);
	if (!alive) {
		reportStartupControlSend(ctx, `Target session not reachable: ${target}`, "error");
		return;
	}

	const senderSessionId = includeSenderInfo ? ctx.sessionManager.getSessionId() : undefined;
	const senderSessionName = includeSenderInfo ? ctx.sessionManager.getSessionName()?.trim() : undefined;
	const sendCommand: RpcSendCommand = {
		type: "send",
		payload: {
			content: message,
			...(senderSessionId === undefined
				? {}
				: {
						replyTo: {
							sessionId: senderSessionId,
							...(senderSessionName ? { sessionName: senderSessionName } : {}),
						},
					}),
		},
		delivery: mode === "steer" ? "immediate" : "follow_up",
	};

	try {
		if (waitUntil === "turn_end") {
			const result = await sendRpcCommand(socketPath, sendCommand, {
				timeout: 300000,
				waitForEvent: "turn_end",
			});
			if (!result.response.success) {
				reportStartupControlSend(ctx, `Failed to send: ${result.response.error ?? "unknown error"}`, "error");
				return;
			}
			const lastMessage = result.event?.message;
			if (!lastMessage?.content) {
				reportStartupControlSend(
					ctx,
					`Message delivered to ${target}; turn completed without assistant output.`,
				);
				return;
			}
			if (ctx.hasUI) {
				pi.sendMessage(
					{
						customType: "control-send",
						content: `Startup response from ${target}:\n\n${lastMessage.content}`,
						display: true,
					},
					{ triggerTurn: false },
				);
			} else {
				console.log(lastMessage.content);
			}
			return;
		}

		const result = await sendRpcCommand(socketPath, sendCommand, { timeout: 30000 });
		if (!result.response.success) {
			reportStartupControlSend(ctx, `Failed to send: ${result.response.error ?? "unknown error"}`, "error");
			return;
		}

		const waitLabel = waitUntil === "message_processed" ? " (message processed)" : "";
		reportStartupControlSend(ctx, `Message sent to ${target}${waitLabel}`);
	} catch (error) {
		const msg = error instanceof Error ? error.message : "unknown error";
		reportStartupControlSend(ctx, `Failed to send to ${target}: ${msg}`, "error");
	}
}
