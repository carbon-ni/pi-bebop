import * as path from "node:path";
import { resolveIntakeContact, type CrewManifest } from "../domain/index.ts";
import {
	createCrewIntakeDropbox,
	createCrewIntakeIdempotencyKey,
	isSafeCrewIntakeFilename,
	MAX_CREW_INTAKE_FILES_PER_SCAN,
	MAX_CREW_INTAKE_SCAN_BYTES,
	CrewIntakeDropboxError,
	type CrewIntakeDropbox,
	type IntakeDropboxClaim,
	type IntakeDropboxContent,
	type IntakeDropboxReceipt,
} from "../infra/crew-intake-dropbox.ts";
import { ExternalIntakeError, submitExternalIntake, type ExternalIntakeDependencies } from "./external-intake.ts";
import { readTrustedCrewManifest } from "../infra/crew-manifest-store.ts";
import { openTrustedMemberInboxStore } from "../infra/member-inbox-store.ts";

export interface FilesystemCrewIntakeMembership {
	readonly manifestPath: string;
	readonly member: { readonly name: string; readonly role: string; readonly socketPath: string };
}

export type FilesystemCrewIntakeScanResult =
	| { readonly state: "scanned"; readonly accepted: number; readonly failed: number; readonly remaining: number }
	| { readonly state: "skipped"; readonly reason: "not-joined" | "not-contact" | "external-intake-disabled" }
	| { readonly state: "failed"; readonly code: string };

export interface FilesystemCrewIntakeDependencies {
	readonly getMembership: () => FilesystemCrewIntakeMembership | null;
	readonly isProjectTrusted: () => boolean;
	readonly loadManifest?: (manifestPath: string, projectRoot: string) => Promise<CrewManifest>;
	readonly externalIntake?: Pick<ExternalIntakeDependencies, "openStore" | "now">;
	readonly onAccepted?: () => void | Promise<void>;
	readonly onError?: (code: string) => void;
	readonly quiescenceMs?: number;
}

export interface FilesystemCrewIntakeController {
	syncMembership(): void;
	invalidate(): void;
	scan(): Promise<FilesystemCrewIntakeScanResult>;
	close(): void;
}

type Active = {
	readonly generation: number;
	readonly membership: FilesystemCrewIntakeMembership;
	readonly manifest: CrewManifest;
	readonly dropbox: CrewIntakeDropbox;
};

function projectRootOf(manifestPath: string): string {
	return path.resolve(path.dirname(manifestPath), "..", "..");
}

function errorCode(error: unknown): string {
	if (error instanceof CrewIntakeDropboxError) return error.code;
	if (error instanceof ExternalIntakeError) return error.code;
	return "scan-failed";
}

function isInvalidFileError(error: unknown): boolean {
	return (
		error instanceof CrewIntakeDropboxError &&
		["invalid-filename", "invalid-utf8", "empty-file", "nul-byte", "oversized"].includes(error.code)
	);
}

function isCurrent(active: Active, generation: number, membership: FilesystemCrewIntakeMembership): boolean {
	return (
		active.generation === generation &&
		active.membership.manifestPath === membership.manifestPath &&
		active.membership.member.name === membership.member.name &&
		active.membership.member.role === membership.member.role &&
		active.membership.member.socketPath === membership.member.socketPath
	);
}

export function createFilesystemCrewIntakeController(
	dependencies: FilesystemCrewIntakeDependencies,
): FilesystemCrewIntakeController {
	let generation = 0;
	let active: Active | null = null;
	let watcher: { close(): void } | null = null;
	let watchRequested = false;
	let inactiveReason: "not-contact" | "external-intake-disabled" = "not-contact";
	let scanTail: Promise<unknown> = Promise.resolve();

	const report = (error: unknown): void => dependencies.onError?.(errorCode(error));
	const closeWatcher = (): void => {
		watcher?.close();
		watcher = null;
	};
	const resetActive = (): void => {
		generation += 1;
		active = null;
		closeWatcher();
	};
	const invalidate = (): void => {
		watchRequested = false;
		resetActive();
	};

	const loadManifest =
		dependencies.loadManifest ??
		((manifestPath: string, projectRoot: string) =>
			readTrustedCrewManifest(manifestPath, projectRoot, dependencies.isProjectTrusted));

	const ensureActive = async (watchForChanges = watchRequested): Promise<Active | null> => {
		const membership = dependencies.getMembership();
		if (!membership) {
			invalidate();
			return null;
		}
		const manifestPath = path.resolve(membership.manifestPath);
		const projectRoot = projectRootOf(manifestPath);
		let manifest: CrewManifest;
		try {
			manifest = await loadManifest(manifestPath, projectRoot);
		} catch (error) {
			resetActive();
			throw error;
		}
		const resolution = resolveIntakeContact(manifest);
		if (!resolution.enabled) {
			resetActive();
			inactiveReason = "external-intake-disabled";
			return null;
		}
		if (
			resolution.contact.name !== membership.member.name ||
			resolution.contact.role !== membership.member.role ||
			resolution.contact.socketPath !== membership.member.socketPath
		) {
			resetActive();
			inactiveReason = "not-contact";
			return null;
		}
		if (active && isCurrent(active, active.generation, membership)) {
			if (watchForChanges && watcher === null)
				watcher = active.dropbox.watch(() => {
					void scan();
				}, report);
			return active;
		}
		resetActive();
		const dropbox = createCrewIntakeDropbox({
			manifestPath,
			projectRoot,
			isProjectTrusted: dependencies.isProjectTrusted,
			quiescenceMs: dependencies.quiescenceMs,
		});
		await dropbox.prepare();
		const next: Active = { generation, membership, manifest, dropbox };
		if (generation !== next.generation || !isCurrent(next, generation, dependencies.getMembership() ?? membership))
			return null;
		active = next;
		if (watchForChanges) {
			closeWatcher();
			watcher = dropbox.watch(() => {
				void scan();
			}, report);
		}
		return next;
	};

	const processClaim = async (
		current: Active,
		claim: IntakeDropboxClaim,
		content: IntakeDropboxContent,
	): Promise<"accepted" | "failed" | "retry"> => {
		const key = createCrewIntakeIdempotencyKey(current.membership.manifestPath, claim.name, content.digest);
		const existing = await current.dropbox.readReceipt(key);
		let receipt: IntakeDropboxReceipt;
		if (existing) {
			if (existing.filename !== claim.name || existing.digest !== content.digest)
				throw new CrewIntakeDropboxError("receipt-conflict", "intake receipt does not match its source");
			receipt = existing;
		} else {
			const intakeDependencies: ExternalIntakeDependencies = {
				loadManifest: (manifestPath) => loadManifest(manifestPath, projectRootOf(manifestPath)),
				openStore:
					dependencies.externalIntake?.openStore ??
					(async (options) =>
						openTrustedMemberInboxStore({
							...options,
							isProjectTrusted: dependencies.isProjectTrusted,
						})),
				now: dependencies.externalIntake?.now,
			};
			const ack = await submitExternalIntake(
				{
					manifestPath: current.membership.manifestPath,
					label: claim.name,
					content: content.content,
					idempotencyKey: key,
				},
				intakeDependencies,
			);
			const membershipAfterEnqueue = dependencies.getMembership();
			if (!membershipAfterEnqueue || !isCurrent(current, current.generation, membershipAfterEnqueue))
				throw new CrewIntakeDropboxError("scan-failed", "intake ownership changed during persistence");
			receipt = {
				version: 1,
				idempotencyKey: key,
				filename: claim.name,
				digest: content.digest,
				itemId: ack.itemId,
				recordedAt: Date.now(),
			};
			await current.dropbox.writeReceipt(receipt);
		}
		const membershipBeforeMove = dependencies.getMembership();
		if (!membershipBeforeMove || !isCurrent(current, current.generation, membershipBeforeMove))
			throw new CrewIntakeDropboxError("scan-failed", "intake ownership changed before final move");
		await current.dropbox.moveProcessed(claim);
		await dependencies.onAccepted?.();
		return "accepted";
	};

	const scanUnlocked = async (): Promise<FilesystemCrewIntakeScanResult> => {
		let current: Active | null;
		try {
			current = await ensureActive();
		} catch (error) {
			report(error);
			return { state: "failed", code: errorCode(error) };
		}
		if (!current) {
			const membership = dependencies.getMembership();
			return membership
				? { state: "skipped", reason: inactiveReason }
				: { state: "skipped", reason: "not-joined" };
		}
		const generationAtStart = current.generation;
		let release: (() => Promise<void>) | undefined;
		try {
			release = await current.dropbox.lock();
		} catch (error) {
			report(error);
			return { state: "failed", code: errorCode(error) };
		}
		let accepted = 0;
		let failed = 0;
		let bytes = 0;
		try {
			const work = await current.dropbox.listWork();
			for (const candidate of work.slice(0, MAX_CREW_INTAKE_FILES_PER_SCAN)) {
				const membership = dependencies.getMembership();
				if (!membership || !isCurrent(current, generationAtStart, membership)) break;
				let claim: IntakeDropboxClaim | null = null;
				try {
					claim = await current.dropbox.claim(candidate);
					if (!claim) continue;
					if (!isSafeCrewIntakeFilename(claim.name))
						throw new CrewIntakeDropboxError("invalid-filename", `unsafe intake filename: ${claim.name}`);
					const content = await current.dropbox.read(claim);
					bytes += content.bytes;
					if (bytes > MAX_CREW_INTAKE_SCAN_BYTES)
						throw new CrewIntakeDropboxError("oversized", "intake scan byte budget exceeded");
					const result = await processClaim(current, claim, content);
					if (result === "accepted") accepted += 1;
				} catch (error) {
					if (claim && isInvalidFileError(error)) {
						await current.dropbox.moveFailed(claim, errorCode(error));
						failed += 1;
					} else if (claim) {
						await current.dropbox.release(claim).catch(() => undefined);
						report(error);
						return { state: "failed", code: errorCode(error) };
					} else {
						report(error);
					}
				}
			}
			return { state: "scanned", accepted, failed, remaining: Math.max(0, work.length - accepted - failed) };
		} catch (error) {
			report(error);
			return { state: "failed", code: errorCode(error) };
		} finally {
			await release?.();
		}
	};

	const scan = (): Promise<FilesystemCrewIntakeScanResult> => {
		const run = scanTail.then(scanUnlocked, scanUnlocked);
		scanTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};

	const syncMembership = (): void => {
		watchRequested = true;
		resetActive();
		void ensureActive().catch(report);
	};
	const close = (): void => invalidate();

	return { syncMembership, invalidate, scan, close };
}
