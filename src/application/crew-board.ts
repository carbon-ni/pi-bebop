import * as path from "node:path";
import { CrewBoardStoreError, type CrewBoardStore } from "../infra/crew-board-store.ts";
import { isTrustedCrewManifestPath } from "../infra/crew-manifest-store.ts";
import {
	validateBoardAppendInput,
	normalizeBoardKinds,
	validateBoardReadLimit,
	type BoardAppendInput,
	type BoardReadResult,
	type CrewPostKind,
} from "../domain/index.ts";
import type { Membership } from "../infra/membership-runtime.ts";

export type CrewBoardApplicationErrorCode =
	| "not-joined"
	| "untrusted-project"
	| "unsupported-layout"
	| "stale-membership"
	| "invalid-request"
	| string;

export class CrewBoardApplicationError extends Error {
	readonly code: CrewBoardApplicationErrorCode;
	constructor(code: CrewBoardApplicationErrorCode, message: string) {
		super(message);
		this.name = "CrewBoardApplicationError";
		this.code = code;
	}
}

export interface CrewBoardStoreDependencies {
	readonly isProjectTrusted: () => boolean;
	readonly openStore: (options: {
		readonly manifestPath: string;
		readonly projectRoot: string;
		readonly isProjectTrusted: () => boolean;
		readonly member: { readonly name: string; readonly role: string; readonly socketPath: string };
	}) => Promise<CrewBoardStore>;
}

export interface LeaveCrewPostRequest {
	readonly membership: Membership | null;
	readonly operationId: string;
	readonly kind?: CrewPostKind;
	readonly message: string;
	readonly references?: readonly string[];
	readonly link?: BoardAppendInput["link"];
	readonly now: number;
}

export interface ReadCrewBoardRequest {
	readonly membership: Membership | null;
	readonly kinds?: readonly CrewPostKind[];
	readonly after?: string;
	readonly limit?: number;
}

function projectRootOf(manifestPath: string): string {
	return path.resolve(path.dirname(manifestPath), "..", "..");
}

function requireMembership(membership: Membership | null, dependencies: CrewBoardStoreDependencies): Membership {
	if (!membership) throw new CrewBoardApplicationError("not-joined", "Crew Board requires joined Membership");
	if (!dependencies.isProjectTrusted())
		throw new CrewBoardApplicationError("untrusted-project", "Cannot use Crew Board in an untrusted project");
	const projectRoot = projectRootOf(membership.manifestPath);
	if (!isTrustedCrewManifestPath(membership.manifestPath, projectRoot))
		throw new CrewBoardApplicationError("unsupported-layout", "Crew Board requires a supported Crew layout");
	const active = membership.manifest.members.find(
		(member) =>
			member.name === membership.member.name &&
			member.role === membership.member.role &&
			path.resolve(member.socketPath) === path.resolve(membership.socketPath),
	);
	if (!active)
		throw new CrewBoardApplicationError(
			"stale-membership",
			"Active Membership no longer matches the Crew manifest",
		);
	return membership;
}

async function openBoardStore(
	membership: Membership | null,
	dependencies: CrewBoardStoreDependencies,
): Promise<{ readonly membership: Membership; readonly store: CrewBoardStore }> {
	const current = requireMembership(membership, dependencies);
	const store = await dependencies.openStore({
		manifestPath: current.manifestPath,
		projectRoot: projectRootOf(current.manifestPath),
		isProjectTrusted: dependencies.isProjectTrusted,
		member: {
			name: current.member.name,
			role: current.member.role,
			socketPath: current.socketPath,
		},
	});
	return { membership: current, store };
}

export async function leaveCrewPost(
	request: LeaveCrewPostRequest,
	dependencies: CrewBoardStoreDependencies,
): Promise<Awaited<ReturnType<CrewBoardStore["append"]>>> {
	const membership = requireMembership(request.membership, dependencies);
	const input: BoardAppendInput = {
		operationId: request.operationId,
		author: { name: membership.member.name, role: membership.member.role },
		...(request.kind === undefined ? {} : { kind: request.kind }),
		message: request.message,
		...(request.references === undefined ? {} : { references: request.references }),
		...(request.link === undefined ? {} : { link: request.link }),
	};
	try {
		validateBoardAppendInput(input);
		const { store } = await openBoardStore(membership, dependencies);
		return await store.append(input, request.now);
	} catch (error) {
		if (error instanceof CrewBoardApplicationError) throw error;
		if (error instanceof CrewBoardStoreError) throw new CrewBoardApplicationError(error.code, error.message);
		throw error;
	}
}

export async function readCrewBoard(
	request: ReadCrewBoardRequest,
	dependencies: CrewBoardStoreDependencies,
): Promise<BoardReadResult> {
	try {
		const kinds = normalizeBoardKinds(request.kinds);
		const limit = validateBoardReadLimit(request.limit);
		const { store } = await openBoardStore(request.membership, dependencies);
		return await store.read({ limit, kinds, ...(request.after === undefined ? {} : { after: request.after }) });
	} catch (error) {
		if (error instanceof CrewBoardApplicationError) throw error;
		if (error instanceof CrewBoardStoreError) throw new CrewBoardApplicationError(error.code, error.message);
		throw error;
	}
}
