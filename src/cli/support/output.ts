import { encode } from "@toon-format/toon";
import type { CliFormat } from "./arguments.ts";

export interface CliResult {
	readonly ok: boolean;
	readonly target: string;
	readonly status: string;
	readonly response?: string;
	readonly data?: unknown;
	readonly error?: { code: string; message: string };
	readonly turnIndex?: number;
}

/**
 * TASK-0063: renderable outcome produced by every command handler. Help is
 * raw deterministic bytes (zero IO); results carry their own format/full
 * flags so the single renderer boundary never needs command knowledge.
 */
export type CliOutcome =
	| { readonly kind: "result"; readonly result: CliResult; readonly format: CliFormat; readonly full: boolean }
	| { readonly kind: "help"; readonly text: string };

/**
 * The single renderer boundary: one output write per invocation. Exit codes
 * are derived here: usage 2, help 0, success 0, operational failure 1.
 */
export function writeOutcome(output: NodeJS.WritableStream, outcome: CliOutcome): number {
	if (outcome.kind === "help") {
		output.write(outcome.text);
		return 0;
	}
	output.write(`${renderCliResult(outcome.result, outcome.format, outcome.full)}\n`);
	if (outcome.result.status === "usage") return 2;
	return outcome.result.ok ? 0 : 1;
}

const MAX_RESPONSE = 2000;
type ViewModel = Record<string, unknown>;

function asViewModel(value: unknown): ViewModel | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as ViewModel) : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function renderTextResult(result: CliResult): string {
	if (!result.ok) return result.error?.message ?? "Operation failed";
	const data = asViewModel(result.data);
	if (stringValue(data?.manifestPath) !== undefined) return renderCrewInitText(result, data!);
	// Existing command-specific responses remain authoritative; structured
	// presenters fill only the data-only result gap.
	if (result.response !== undefined) return result.response;
	const crews = data?.crews;
	if (Array.isArray(crews)) return renderCrewsText(data, crews);
	const sessions = data?.sessions;
	if (Array.isArray(sessions)) return renderSessionsText(data, sessions);
	if (Array.isArray(data?.commands) && data?.scaffold !== undefined) return renderHomeText(data);
	const roles = data?.roles;
	if (Array.isArray(roles)) return renderRolesText(data, roles);
	const summary = asViewModel(data?.summary);
	if (summary && typeof summary.delivered === "number" && typeof summary.failed === "number")
		return renderBroadcastText(summary);
	if (data && stringValue(data.itemId) !== undefined && asViewModel(data.member) !== undefined)
		return renderPersistedText(data);
	if (data && (data.status === "pending" || data.status === "approved")) return renderGuestAdmissionText(data);
	if (data && Array.isArray(data.requests)) return renderRequestListText(data);
	if (data && (stringValue(data.requestId) !== undefined || typeof data.kind === "string"))
		return renderRequestText(result, data);
	if (data && stringValue(data.deliveryId) !== undefined) return renderDeliveryText(data);
	if (result.status === "left" && stringValue(data?.crew) !== undefined) return `Left crew ${data.crew}`;
	if (result.status === "empty") return `No ${result.target || "results"} found`;
	if (result.status === "persisted") return result.response ?? "Message persisted";
	return result.response ?? (result.status === "accepted" ? "Message accepted" : "Operation succeeded");
}

function renderHomeText(data: ViewModel): string {
	const project = stringValue(data.project) ?? "current project";
	const scaffold = stringValue(data.scaffold) ?? "unknown";
	const lines = [`Project: ${project}`, `Crew scaffold: ${scaffold}`];
	if (Array.isArray(data.commands) && data.commands.length > 0)
		lines.push(`Commands: ${data.commands.length} available`);
	if (stringValue(data.next)) lines.push(`Next: ${data.next}`);
	return lines.join("\n");
}

function renderCrewsText(data: ViewModel, crews: unknown[]): string {
	const total = typeof data.total === "number" ? data.total : crews.length;
	if (crews.length === 0) {
		const discovery = stringValue(data.discovery);
		return `No Crews found (total: ${total}).${discovery ? ` Discovery: ${discovery}.` : ""} ${stringValue(data.next) ?? "Initialize or join a trusted Crew, then retry."}`;
	}
	const lines = [`Crews (${total}):`];
	for (const item of crews) {
		const crew = asViewModel(item);
		if (!crew) continue;
		const selector = stringValue(crew.selector) ?? "unaddressable";
		const displayName = stringValue(crew.displayName);
		const availability = stringValue(crew.availability) ?? "unknown";
		const count = typeof crew.memberCount === "number" ? `${crew.onlineMembers ?? 0}/${crew.memberCount}` : "?";
		const locator = stringValue(crew.locator);
		lines.push(
			`- ${selector}${displayName ? ` (${displayName})` : ""} — ${availability} — ${count} Members${locator ? ` — --crew ${locator}` : ""}`,
		);
	}
	if (typeof data.omitted === "number" && data.omitted > 0) lines.push(`Omitted: ${data.omitted}`);
	if (data.partial === true) lines.push(`Discovery: ${stringValue(data.discovery) ?? "partial"}`);
	return lines.join("\n");
}

function renderSessionsText(data: ViewModel, sessions: unknown[]): string {
	const total = typeof data.total === "number" ? data.total : sessions.length;
	if (sessions.length === 0)
		return `No sessions found (total: ${total}). ${stringValue(data.next) ?? "Start a session and retry."}`;
	const lines = [`Sessions (${total}):`];
	for (const item of sessions) {
		const session = asViewModel(item);
		if (!session) continue;
		const id = stringValue(session.sessionId) ?? stringValue(session.id) ?? "unknown";
		const aliases = Array.isArray(session.aliases)
			? session.aliases.filter((value): value is string => typeof value === "string")
			: [];
		const membership = stringValue(session.membership) ?? "unknown";
		lines.push(`- ${id}${aliases.length > 0 ? ` (${aliases.join(", ")})` : ""} — ${membership}`);
	}
	if (typeof data.omitted === "number" && data.omitted > 0) lines.push(`Omitted: ${data.omitted}`);
	return lines.join("\n");
}

function renderRolesText(data: ViewModel, roles: unknown[]): string {
	const names = roles.map((role) => {
		if (typeof role === "string") return role;
		const value = asViewModel(role);
		return stringValue(value?.role) ?? "unknown";
	});
	const count = typeof data.roleCount === "number" ? data.roleCount : names.length;
	return `${count} configured role${count === 1 ? "" : "s"}: ${names.join(", ")}`;
}

function renderCrewInitText(result: CliResult, data: ViewModel): string {
	const state = stringValue(data.status) ?? result.status;
	const lines = [`Crew scaffold ${state}: ${stringValue(data.project) ?? result.target}`];
	if (stringValue(data.manifestPath)) lines.push(`Manifest: ${data.manifestPath}`);
	if (Array.isArray(data.createdPaths) && data.createdPaths.length > 0)
		lines.push(`Created: ${data.createdPaths.length} path(s)`);
	if (Array.isArray(data.verifiedPaths) && data.verifiedPaths.length > 0)
		lines.push(`Verified: ${data.verifiedPaths.length} path(s)`);
	if (Array.isArray(data.nextCommands) && data.nextCommands.length > 0) lines.push(`Next: ${data.nextCommands[0]}`);
	return lines.join("\n");
}

function renderBroadcastText(summary: ViewModel): string {
	return `Broadcast: ${summary.delivered as number} delivered, ${summary.failed as number} failed`;
}

function renderPersistedText(data: ViewModel): string {
	const member = asViewModel(data.member);
	const name = stringValue(member?.name) ?? "member";
	const role = stringValue(member?.role);
	return `${name}${role ? ` (${role})` : ""} — persisted ${data.itemId}`;
}

function renderRequestListText(data: ViewModel): string {
	const requests = data.requests as unknown[];
	if (requests.length === 0) return "No pending requests";
	const omitted = typeof data.omitted === "number" && data.omitted > 0 ? `; omitted: ${data.omitted}` : "";
	return `${requests.length} request(s) listed${omitted}`;
}

function renderRequestText(result: CliResult, data: ViewModel): string {
	const id = stringValue(data.requestId) ?? result.target;
	if (typeof data.kind === "string") return `Request ${id}: ${data.kind}`;
	if (result.status === "response-accepted") return `Response submitted for request ${id}`;
	if (result.status === "accepted") return `Request accepted: ${id}`;
	return `Request ${id}: ${result.status}`;
}

function renderDeliveryText(data: ViewModel): string {
	const member = asViewModel(data.target) ?? asViewModel(data.member);
	const target = stringValue(member?.name) ?? stringValue(data.target) ?? "target";
	const role = stringValue(member?.role);
	const disposition = stringValue(data.disposition) ?? "accepted";
	return `Delivery to ${target}${role ? ` (${role})` : ""}: ${disposition} (${data.deliveryId})`;
}

function renderGuestAdmissionText(data: ViewModel): string {
	const status = data.status as string;
	const crew = asViewModel(data.crew);
	const label = stringValue(crew?.displayName) ?? stringValue(crew?.id) ?? "crew";
	return `Guest admission ${status} for ${label}${stringValue(data.requestId) ? ` (request ${data.requestId})` : ""}`;
}

export function renderCliResult(result: CliResult, format: CliFormat, full: boolean): string {
	if (format === "text") return renderTextResult(result);
	const output: Record<string, unknown> = { ...result };
	if (result.response !== undefined) {
		const response = full ? result.response : result.response.slice(0, MAX_RESPONSE);
		output.response = response;
		output.truncation = {
			truncated: response.length < result.response.length,
			originalChars: result.response.length,
			shownChars: response.length,
		};
	}
	return format === "json" ? JSON.stringify(output) : encode(output);
}
