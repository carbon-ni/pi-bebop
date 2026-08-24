import { isMessagePayload, type MessagePayload, type RpcCommand } from "../domain/index.ts";
import {
	MemberInboxStoreError,
	openTrustedMemberInboxStore,
	type MemberInboxStore,
} from "../infra/member-inbox-store.ts";

/**
 * Durable member-inbox enqueue (application operation behind send_to_inbox).
 *
 * Transport-only: resolve a configured peer, build one ordinary structured
 * payload with crew origin derived at execute time, persist it through the
 * trusted member-inbox store, then fire one best-effort hint. "Persisted" means
 * durably stored — never delivered, started, completed, or answered — and the
 * acknowledgement returns the stable item id. Recipient liveness or turn state
 * is never required. The hint carries no authoritative item data and its
 * failure never rolls back the persisted item.
 */

type CrewMember = { name: string; role: string; socket: string; socketPath: string };
type CrewMembership = {
	member: CrewMember;
	socketPath: string;
	manifestPath: string;
	manifest: { members: readonly CrewMember[] };
};

export type MemberInboxMessageErrorCode =
	| "unknown-member"
	| "ambiguous-role"
	| "self-send"
	| "not-joined"
	| "invalid-payload"
	| "untrusted-project"
	| "inbox-full"
	| "inbox-untrusted-path"
	| "storage-unavailable"
	| "storage-failed";

export class MemberInboxMessageError extends Error {
	readonly code: MemberInboxMessageErrorCode;

	constructor(code: MemberInboxMessageErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "MemberInboxMessageError";
		this.code = code;
	}
}

export interface MemberInboxMessageRequest {
	readonly membership: CrewMembership | null;
	readonly member: string;
	readonly message: string;
	readonly instructions?: readonly string[];
	readonly now: number;
	readonly signal?: AbortSignal;
}

export interface InboxHintTransport {
	sendHint(endpoint: string, command: RpcCommand, options: { signal?: AbortSignal }): Promise<unknown>;
}

export interface MemberInboxMessageDependencies {
	readonly isProjectTrusted: () => boolean;
	readonly openStore: (options: {
		readonly manifestPath: string;
		readonly projectRoot: string;
		readonly isProjectTrusted: () => boolean;
		readonly member: CrewMember;
	}) => Promise<MemberInboxStore>;
	readonly hintTransport: InboxHintTransport | null;
	readonly hintTimeoutMs?: number;
	readonly resolveEndpoint?: (socketPath: string) => Promise<string>;
}

export interface MemberInboxMessageOutcome {
	readonly target: CrewMember;
	readonly itemId: string;
	readonly persisted: true;
	readonly hint: "sent" | "skipped";
}

function resolveTarget(membership: CrewMembership, memberName: string): CrewMember {
	const byName = membership.manifest.members.find((member) => member.name === memberName);
	const byRole = membership.manifest.members.filter((member) => member.role === memberName);
	const target = byName ?? (byRole.length === 1 ? byRole[0] : undefined);
	if (!target) {
		if (byRole.length > 1)
			throw new MemberInboxMessageError("ambiguous-role", `Ambiguous crew role: ${memberName}`);
		throw new MemberInboxMessageError("unknown-member", `Unknown crew member: ${memberName}`);
	}
	if (target.name === membership.member.name || target.socketPath === membership.socketPath)
		throw new MemberInboxMessageError("self-send", "Cannot enqueue inbox messages for yourself");
	return target;
}

const storeErrorCodeMap: Record<string, MemberInboxMessageErrorCode> = {
	"capacity-exceeded": "inbox-full",
	"untrusted-path": "inbox-untrusted-path",
	"untrusted-project": "untrusted-project",
};

const storageUnavailableCodes = new Set(["lock-conflict", "write-failed", "read-failed", "quarantine-failed"]);

function mapStoreError(error: unknown): MemberInboxMessageError {
	if (!(error instanceof MemberInboxStoreError))
		return new MemberInboxMessageError("storage-failed", "Inbox storage failed", { cause: error });
	const mapped =
		storeErrorCodeMap[error.code] ??
		(storageUnavailableCodes.has(error.code) ? "storage-unavailable" : "storage-failed");
	return new MemberInboxMessageError(mapped, error.message, { cause: error });
}

const hintCommand = (targetName: string, origin: MessagePayload["origin"]): RpcCommand => ({
	type: "send",
	payload: {
		content: `[inbox] You have a new durable inbox item from ${origin?.kind === "crew" ? origin.name : "a crew member"}. Check your inbox when available.`,
		origin,
		instructions: ["Check your crew inbox for pending items"],
	},
	delivery: "follow_up",
});

export async function enqueueMemberInboxMessage(
	request: MemberInboxMessageRequest,
	dependencies: MemberInboxMessageDependencies,
): Promise<MemberInboxMessageOutcome> {
	if (!request.membership) throw new MemberInboxMessageError("not-joined", "Not joined to a crew");
	const target = resolveTarget(request.membership, request.member.trim());
	const origin = {
		kind: "crew" as const,
		name: request.membership.member.name,
		role: request.membership.member.role,
	};
	const payload: MessagePayload = {
		content: request.message,
		...(request.instructions === undefined ? {} : { instructions: [...request.instructions] }),
		origin,
	};
	if (!isMessagePayload(payload))
		throw new MemberInboxMessageError("invalid-payload", "Invalid structured message payload");

	if (!dependencies.isProjectTrusted())
		throw new MemberInboxMessageError("untrusted-project", "Cannot use inbox storage in an untrusted project");
	if (request.signal?.aborted) throw Object.assign(new Error("Operation aborted"), { name: "AbortError" });

	let store: MemberInboxStore;
	try {
		store = await dependencies.openStore({
			manifestPath: request.membership.manifestPath,
			projectRoot: projectRootOf(request.membership.manifestPath),
			isProjectTrusted: dependencies.isProjectTrusted,
			member: target,
		});
	} catch (error) {
		throw mapStoreError(error);
	}

	let item;
	try {
		({ item } = await store.enqueue(payload, request.now));
	} catch (error) {
		throw mapStoreError(error);
	}

	let hint: "sent" | "skipped" = "skipped";
	if (dependencies.hintTransport) {
		try {
			const endpoint = await resolveHintEndpoint(target, dependencies);
			await withHintTimeout(
				dependencies.hintTransport.sendHint(endpoint, hintCommand(target.name, payload.origin), {
					signal: request.signal,
				}),
				dependencies.hintTimeoutMs ?? 1000,
			);
			hint = "sent";
		} catch {
			hint = "skipped";
		}
	}
	return { target, itemId: item.id, persisted: true, hint };
}

function projectRootOf(manifestPath: string): string {
	const normalized = manifestPath.split(/[\\/]/);
	return normalized.slice(0, -3).join("/") || "/";
}

async function resolveHintEndpoint(target: CrewMember, dependencies: MemberInboxMessageDependencies): Promise<string> {
	if (dependencies.resolveEndpoint) return await dependencies.resolveEndpoint(target.socketPath);
	return target.socketPath;
}

async function withHintTimeout(hintPromise: Promise<unknown>, timeoutMs: number): Promise<void> {
	await Promise.race([
		hintPromise,
		new Promise<never>((_resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("hint timeout")), timeoutMs);
			timer.unref?.();
		}),
	]);
}
