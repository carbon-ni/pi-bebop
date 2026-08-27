import { createHash } from "node:crypto";
import { createAgreementActivationNotice, type CrewManifest, type CrewMember } from "../domain/index.ts";
import { type AgreementActivationResult, type CrewAgreementStore } from "../infra/crew-agreement-store.ts";
import type { MemberInboxStore } from "../infra/member-inbox-store.ts";

export type AgreementNoticeDisposition =
	| { readonly member: string; readonly status: "persisted" | "already-persisted" }
	| { readonly member: string; readonly status: "failed"; readonly code: string; readonly message: string };

export interface AgreementActivationApplicationResult {
	readonly activation: AgreementActivationResult;
	readonly notices: readonly AgreementNoticeDisposition[];
}

export interface AgreementActivationMembership {
	readonly manifestPath: string;
	readonly manifest: CrewManifest;
}

export interface AgreementActivationDependencies {
	readonly isProjectTrusted: () => boolean;
	readonly openAgreementStore: (options: {
		readonly manifestPath: string;
		readonly projectRoot: string;
		readonly isProjectTrusted: () => boolean;
	}) => Promise<CrewAgreementStore>;
	readonly openInboxStore: (options: {
		readonly manifestPath: string;
		readonly projectRoot: string;
		readonly isProjectTrusted: () => boolean;
		readonly member: Pick<CrewMember, "name" | "role" | "socketPath">;
	}) => Promise<MemberInboxStore>;
	readonly now: () => number;
}

function projectRootOf(manifestPath: string): string {
	const normalized = manifestPath.split(/[\\/]/);
	return normalized.slice(0, -3).join("/") || "/";
}

function noticeId(revisionId: string, member: CrewMember): string {
	return `agreement-activation-${createHash("sha256")
		.update(`${revisionId}:${member.socketPath}`, "utf8")
		.digest("hex")
		.slice(0, 32)}`;
}

/** Activates first, then retries each deterministic per-member notice independently. */
export async function activateAgreementRevision(
	membership: AgreementActivationMembership,
	revisionId: string,
	dependencies: AgreementActivationDependencies,
): Promise<AgreementActivationApplicationResult> {
	if (!dependencies.isProjectTrusted()) throw new Error("cannot activate Agreements in an untrusted project");
	const projectRoot = projectRootOf(membership.manifestPath);
	const store = await dependencies.openAgreementStore({
		manifestPath: membership.manifestPath,
		projectRoot,
		isProjectTrusted: dependencies.isProjectTrusted,
	});
	const activation = await store.activateRevision(revisionId);
	const payload = createAgreementActivationNotice(activation.revisionId, activation.priorRevisionId);
	const notices: AgreementNoticeDisposition[] = [];
	for (const member of membership.manifest.members) {
		try {
			const inbox = await dependencies.openInboxStore({
				manifestPath: membership.manifestPath,
				projectRoot,
				isProjectTrusted: dependencies.isProjectTrusted,
				member: { name: member.name, role: member.role, socketPath: member.socketPath },
			});
			const result = await inbox.enqueueWithId(
				payload,
				dependencies.now(),
				noticeId(activation.revisionId, member),
			);
			if ("alreadyPersisted" in result) notices.push({ member: member.name, status: "already-persisted" });
			else notices.push({ member: member.name, status: "persisted" });
		} catch (error) {
			notices.push({
				member: member.name,
				status: "failed",
				code: error instanceof Error && "code" in error ? String(error.code) : "storage-failed",
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { activation, notices };
}
