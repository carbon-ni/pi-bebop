import * as path from "node:path";
import { resolveIntakeContact, type CrewManifest } from "../domain/index.ts";
import {
	createCrewIntakeDropbox,
	createCrewIntakeIdempotencyKey,
	isSafeCrewIntakeFilename,
	MAX_CREW_INTAKE_FILES_PER_SCAN,
	MAX_CREW_INTAKE_SCAN_BYTES,
	MAX_CREW_INTAKE_SCAN_DURATION_MS,
	CrewIntakeDropboxError,
	type CrewIntakeDropbox,
	type IntakeDropboxClaim,
	type IntakeDropboxContent,
	type IntakeDropboxCommitIntent,
	type IntakeDropboxReceipt,
} from "../infra/crew-intake-dropbox.ts";
import { ExternalIntakeError, submitExternalIntake, type ExternalIntakeDependencies } from "./external-intake.ts";
import { readTrustedCrewManifest } from "../infra/crew-manifest-store.ts";
import type { InboxHintTransport } from "./member-inbox-message.ts";
import { openTrustedMemberInboxStore } from "../infra/member-inbox-store.ts";

export interface FilesystemCrewIntakeMembership {
	readonly manifestPath: string;
	readonly member: { readonly name: string; readonly role: string; readonly socketPath: string };
}

export type FilesystemCrewIntakeScanResult =
	| { readonly state: "scanned"; readonly accepted: number; readonly failed: number; readonly remaining: number }
	| { readonly state: "skipped"; readonly reason: "not-joined" | "external-intake-disabled" }
	| { readonly state: "failed"; readonly code: string };

export interface FilesystemCrewIntakeDependencies {
	readonly getMembership: () => FilesystemCrewIntakeMembership | null;
	readonly isProjectTrusted: () => boolean;
	readonly loadManifest?: (manifestPath: string, projectRoot: string) => Promise<CrewManifest>;
	readonly externalIntake?: Pick<ExternalIntakeDependencies, "openStore" | "now">;
	/** Best-effort wake-up for a persisted item owned by another live member. */
	readonly hintTransport?: InboxHintTransport | null;
	readonly onAccepted?: () => void | Promise<void>;
	readonly onError?: (code: string, message?: string) => void;
	readonly quiescenceMs?: number;
}

export interface FilesystemCrewIntakeController {
	syncMembership(): void;
	invalidate(): void;
	scan(): Promise<FilesystemCrewIntakeScanResult>;
	close(): Promise<void>;
}

type Active = {
	readonly generation: number;
	readonly membership: FilesystemCrewIntakeMembership;
	readonly manifest: CrewManifest;
	readonly manifestFingerprint: string;
	readonly dropbox: CrewIntakeDropbox;
};

function manifestFingerprint(manifest: CrewManifest): string {
	return JSON.stringify(manifest);
}

function sameMember(
	left: FilesystemCrewIntakeMembership["member"],
	right: FilesystemCrewIntakeMembership["member"],
): boolean {
	return left.name === right.name && left.role === right.role && left.socketPath === right.socketPath;
}

function validateCommitTarget(
	manifest: CrewManifest,
	target: IntakeDropboxCommitIntent["target"],
): IntakeDropboxCommitIntent["target"] {
	if (!manifest.members.some((member) => sameMember(member, target)))
		throw new CrewIntakeDropboxError("receipt-conflict", "intake commit target is no longer a Crew member");
	return target;
}

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
		(error instanceof CrewIntakeDropboxError &&
			["invalid-filename", "invalid-utf8", "empty-file", "nul-byte", "oversized"].includes(error.code)) ||
		(error instanceof ExternalIntakeError && error.code === "invalid-payload")
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
	let inactiveReason: "external-intake-disabled" = "external-intake-disabled";
	let scanTail: Promise<unknown> = Promise.resolve();
	let closed = false;
	const pending = new Set<Promise<unknown>>();

	const track = <T>(promise: Promise<T>): Promise<T> => {
		pending.add(promise);
		void promise.then(
			() => pending.delete(promise),
			() => pending.delete(promise),
		);
		return promise;
	};

	const waitForPending = async (): Promise<void> => {
		while (pending.size > 0) await Promise.allSettled([...pending]);
	};

	const report = (error: unknown): void =>
		dependencies.onError?.(errorCode(error), error instanceof Error ? error.message : String(error));
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
		let resolution: ReturnType<typeof resolveIntakeContact>;
		try {
			resolution = resolveIntakeContact(manifest);
		} catch (error) {
			resetActive();
			throw error;
		}
		if (!resolution.enabled) {
			resetActive();
			inactiveReason = "external-intake-disabled";
			return null;
		}
		const fingerprint = manifestFingerprint(manifest);
		if (active && isCurrent(active, active.generation, membership) && active.manifestFingerprint === fingerprint) {
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
		const next: Active = { generation, membership, manifest, manifestFingerprint: fingerprint, dropbox };
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

	const isGenerationCurrent = async (current: Active): Promise<boolean> => {
		const membership = dependencies.getMembership();
		if (generation !== current.generation || !membership || !isCurrent(current, current.generation, membership))
			return false;
		try {
			const manifest = await loadManifest(
				current.membership.manifestPath,
				projectRootOf(current.membership.manifestPath),
			);
			const latestMembership = dependencies.getMembership();
			return (
				generation === current.generation &&
				latestMembership !== null &&
				isCurrent(current, current.generation, latestMembership) &&
				manifestFingerprint(manifest) === current.manifestFingerprint
			);
		} catch {
			return false;
		}
	};

	const processClaim = async (
		current: Active,
		claim: IntakeDropboxClaim,
		content: IntakeDropboxContent,
	): Promise<"accepted" | "failed" | "retry"> => {
		const key = createCrewIntakeIdempotencyKey(current.membership.manifestPath, claim.name, content.digest);
		const existing = await current.dropbox.readReceipt(key);
		const existingIntent = await current.dropbox.readCommitIntent(key);
		if (existingIntent && (existingIntent.filename !== claim.name || existingIntent.digest !== content.digest))
			throw new CrewIntakeDropboxError("receipt-conflict", "intake commit intent does not match its source");
		let receipt: IntakeDropboxReceipt;
		let target: IntakeDropboxCommitIntent["target"];
		if (existing) {
			if (existing.filename !== claim.name || existing.digest !== content.digest)
				throw new CrewIntakeDropboxError("receipt-conflict", "intake receipt does not match its source");
			receipt = existing;
			target = existingIntent?.target ?? current.membership.member;
		} else {
			if (existingIntent) {
				target = validateCommitTarget(current.manifest, existingIntent.target);
			} else {
				const resolution = resolveIntakeContact(current.manifest);
				if (!resolution.enabled)
					throw new ExternalIntakeError(
						"external-intake-disabled",
						"external intake contact is no longer configured",
					);
				const intent: IntakeDropboxCommitIntent = {
					version: 1,
					idempotencyKey: key,
					filename: claim.name,
					digest: content.digest,
					target: resolution.contact,
					recordedAt: Date.now(),
				};
				await current.dropbox.writeCommitIntent(intent);
				target = intent.target;
			}
			const intakeDependencies: ExternalIntakeDependencies = {
				loadManifest: (manifestPath) => loadManifest(manifestPath, projectRootOf(manifestPath)),
				beforeEnqueue: () => isGenerationCurrent(current),
				openStore:
					dependencies.externalIntake?.openStore ??
					(async (options) =>
						openTrustedMemberInboxStore({
							...options,
							isProjectTrusted: dependencies.isProjectTrusted,
						})),
				now: dependencies.externalIntake?.now,
			};
			if (!(await isGenerationCurrent(current))) {
				await current.dropbox.release(claim).catch(() => undefined);
				return "retry";
			}
			let ack: Awaited<ReturnType<typeof submitExternalIntake>>;
			try {
				ack = await submitExternalIntake(
					{
						manifestPath: current.membership.manifestPath,
						label: claim.name,
						content: content.content,
						idempotencyKey: key,
						targetMember: target,
					},
					intakeDependencies,
				);
			} catch (error) {
				if (error instanceof ExternalIntakeError && error.code === "stale-generation") {
					await current.dropbox.release(claim).catch(() => undefined);
					return "retry";
				}
				throw error;
			}
			receipt = {
				version: 1,
				idempotencyKey: key,
				filename: claim.name,
				digest: content.digest,
				itemId: ack.itemId,
				recordedAt: Date.now(),
			};
		}
		await current.dropbox.writeReceipt(receipt);
		if (!(await isGenerationCurrent(current))) {
			await current.dropbox.release(claim).catch(() => undefined);
			return "retry";
		}
		await current.dropbox.moveProcessed(claim);
		if (sameMember(current.membership.member, target!)) {
			await dependencies.onAccepted?.();
		} else if (dependencies.hintTransport) {
			try {
				await dependencies.hintTransport.sendHint(target!.socketPath, { type: "inbox_hint" }, {});
			} catch {
				// Persistence and processed evidence remain authoritative when the contact is offline.
			}
		}
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
			if (!(error instanceof CrewIntakeDropboxError && error.code === "scan-locked")) report(error);
			return { state: "failed", code: errorCode(error) };
		}
		let accepted = 0;
		let failed = 0;
		let bytes = 0;
		const deadline = Date.now() + MAX_CREW_INTAKE_SCAN_DURATION_MS;
		try {
			const work = await current.dropbox.listWork();
			for (const candidate of work.slice(0, MAX_CREW_INTAKE_FILES_PER_SCAN)) {
				if (Date.now() >= deadline) break;
				const membership = dependencies.getMembership();
				if (
					generation !== generationAtStart ||
					!membership ||
					!isCurrent(current, generationAtStart, membership)
				)
					break;
				let claim: IntakeDropboxClaim | null = null;
				try {
					claim = await current.dropbox.claim(candidate);
					if (!claim) continue;
					if (!isSafeCrewIntakeFilename(claim.name))
						throw new CrewIntakeDropboxError("invalid-filename", `unsafe intake filename: ${claim.name}`);
					const content = await current.dropbox.read(claim);
					if (bytes + content.bytes > MAX_CREW_INTAKE_SCAN_BYTES) {
						await current.dropbox.release(claim);
						claim = null;
						break;
					}
					bytes += content.bytes;
					const result = await processClaim(current, claim, content);
					if (result === "accepted") accepted += 1;
					if (result === "retry") break;
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
			return {
				state: "scanned",
				accepted,
				failed,
				remaining: Math.max(0, work.length - accepted - failed) + (work.truncated ? 1 : 0),
			};
		} catch (error) {
			report(error);
			return { state: "failed", code: errorCode(error) };
		} finally {
			await release?.();
		}
	};

	const scan = (): Promise<FilesystemCrewIntakeScanResult> => {
		if (closed) return Promise.resolve({ state: "skipped", reason: "not-joined" });
		const run = scanTail.then(scanUnlocked, scanUnlocked);
		scanTail = run.then(
			() => undefined,
			() => undefined,
		);
		return track(run);
	};

	const syncMembership = (): void => {
		if (closed) return;
		watchRequested = true;
		resetActive();
		track(
			ensureActive().then((current) => {
				if (current && !closed) return scan();
			}),
		).catch(report);
	};
	const close = async (): Promise<void> => {
		if (!closed) {
			closed = true;
			invalidate();
		}
		await waitForPending();
	};

	return { syncMembership, invalidate, scan, close };
}
