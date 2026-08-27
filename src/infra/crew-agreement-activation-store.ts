import * as path from "node:path";
import {
	isAgreementProposal,
	agreementRevisionContentHash,
	isAgreementRecord,
	isAgreementRevision,
	isCurrentAgreementRevisionEligible,
	MAX_AGREEMENT_TEXT_BYTES,
	renderActivatedAgreementContent,
	type AgreementProposal,
	type AgreementRecord,
	type AgreementRevision,
} from "../domain/index.ts";
import {
	ACTIVATION_JOURNAL_FILE,
	ACTIVATION_STATE_FILE,
	AGREEMENTS_DIR,
	MAX_AGREEMENT_RECORD_FILE_BYTES,
	type ActivationJournal,
	type ActivationState,
	type Deps,
	CrewAgreementStoreError,
	recordError,
	safeId,
	contentHash,
	atomicWrite,
	isErrno,
	isInside,
	parseActivationJournal,
	parseActivationState,
	readOptionalJson,
	stableJson,
	validateRecordDirectory,
} from "./crew-agreement-store.ts";

export interface AgreementActivationResult {
	readonly revisionId: string;
	readonly priorRevisionId: string;
	readonly disposition: "activated" | "unchanged";
}

async function configuredCurrentFile(manifestPath: string, deps: Deps): Promise<string> {
	try {
		const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await deps.readFile(manifestPath)));
		const config = (parsed as Record<string, unknown>)?.crewAgreements;
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed) ||
			typeof config !== "object" ||
			config === null ||
			Array.isArray(config) ||
			typeof (config as Record<string, unknown>).file !== "string"
		)
			throw recordError("activation-not-configured", "Current Crew Agreements are not configured");
		return (config as Record<string, unknown>).file as string;
	} catch (error) {
		if (error instanceof CrewAgreementStoreError) throw error;
		throw recordError("read-failed", "failed to read trusted Crew manifest for activation", error);
	}
}

async function resolveCurrentAgreementPath(manifestPath: string, deps: Deps): Promise<string> {
	const relativeFile = await configuredCurrentFile(manifestPath, deps);
	const agreementsRoot = path.join(path.dirname(manifestPath), AGREEMENTS_DIR);
	const currentPath = path.resolve(path.dirname(manifestPath), relativeFile);
	if (!isInside(agreementsRoot, currentPath) || path.isAbsolute(relativeFile) || relativeFile.includes("\0"))
		throw recordError("path-unsafe", "Current Crew Agreements path escapes the trusted layout");
	let realAgreements: string;
	let realParent: string;
	try {
		realAgreements = await deps.realpath(agreementsRoot);
		realParent = await deps.realpath(path.dirname(currentPath));
	} catch (error) {
		throw recordError("path-unsafe", "Current Crew Agreements path cannot be resolved", error);
	}
	if (realParent !== realAgreements && !isInside(realAgreements, realParent))
		throw recordError("path-unsafe", "Current Crew Agreements path escapes the trusted layout");
	try {
		if ((await deps.lstat(currentPath)).isSymbolicLink())
			throw recordError("path-unsafe", "Current Crew Agreements must not be a symbolic link");
		const stat = await deps.stat(currentPath);
		if (!stat.isFile()) throw recordError("path-unsafe", "Current Crew Agreements must be a regular file");
	} catch (error) {
		if (error instanceof CrewAgreementStoreError) throw error;
		throw recordError("read-failed", "Current Crew Agreements file cannot be read", error);
	}
	return currentPath;
}

async function recoverActivationJournal(history: string, currentPath: string, deps: Deps): Promise<void> {
	const journalPath = path.join(history, ACTIVATION_JOURNAL_FILE);
	const raw = await readOptionalJson(journalPath, deps);
	if (raw === undefined) return;
	const journal = parseActivationJournal(raw);
	const current = await readCurrentContent(currentPath, deps);
	const statePath = path.join(history, ACTIVATION_STATE_FILE);
	const revisionDirectory = await validateRecordDirectory(history, "revision", deps);
	const revisionPath = path.join(revisionDirectory, `${journal.currentRevisionId}.json`);
	const stateRaw = await readOptionalJson(statePath, deps);
	const state = stateRaw === undefined ? undefined : parseActivationState(stateRaw);
	const currentHash = contentHash(current);
	if (currentHash !== journal.priorContentHash && currentHash !== contentHash(journal.nextContent))
		throw recordError("corrupt-record", "Agreement activation journal does not match Current Crew Agreements");
	if (
		state !== undefined &&
		state.currentRevisionId !== journal.priorRevisionId &&
		state.currentRevisionId !== journal.currentRevisionId
	)
		throw recordError("corrupt-record", "Agreement activation journal does not match activation state");
	if (currentHash === contentHash(journal.nextContent) && state?.currentRevisionId === journal.currentRevisionId) {
		await atomicWrite(revisionPath, stableJson(journal.nextRevision), deps);
		await deps.unlink(journalPath).catch((error) => {
			if (!isErrno(error, "ENOENT")) throw error;
		});
		return;
	}
	if (currentHash === journal.priorContentHash) await atomicWrite(currentPath, journal.nextContent, deps);
	await atomicWrite(revisionPath, stableJson(journal.nextRevision), deps);
	const nextState: ActivationState = {
		version: 1,
		currentRevisionId: journal.currentRevisionId,
		currentContentHash: journal.currentContentHash,
	};
	await atomicWrite(statePath, stableJson(nextState), deps);
	await deps.unlink(journalPath).catch((error) => {
		if (!isErrno(error, "ENOENT")) throw error;
	});
}

async function readCurrentContent(currentPath: string, deps: Deps): Promise<string> {
	try {
		const bytes = await deps.readFile(currentPath);
		if (bytes.byteLength > MAX_AGREEMENT_TEXT_BYTES)
			throw recordError("record-oversized", "Current Crew Agreements are oversized");
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (error) {
		if (error instanceof CrewAgreementStoreError) throw error;
		throw recordError("read-failed", "failed to read Current Crew Agreements", error);
	}
}

export async function readRecord(filePath: string, deps: Deps): Promise<AgreementRecord> {
	try {
		if ((await deps.lstat(filePath)).isSymbolicLink())
			throw recordError("corrupt-record", "Agreement record must not be a symbolic link");
	} catch (error) {
		if (error instanceof CrewAgreementStoreError) throw error;
		if (!isErrno(error, "ENOENT")) throw recordError("read-failed", "failed to inspect Agreement record", error);
	}
	let stat;
	try {
		stat = await deps.stat(filePath);
	} catch (error) {
		if (isErrno(error, "ENOENT")) throw recordError("record-not-found", "Agreement record was not found");
		throw recordError("read-failed", "failed to inspect Agreement record", error);
	}
	if (!stat.isFile()) throw recordError("corrupt-record", "Agreement record is not a regular file");
	if (stat.size > MAX_AGREEMENT_RECORD_FILE_BYTES)
		throw recordError("record-oversized", "Agreement record is oversized");
	let bytes: Buffer;
	try {
		bytes = await deps.readFile(filePath);
	} catch (error) {
		throw recordError("read-failed", "failed to read Agreement record", error);
	}
	if (bytes.byteLength > MAX_AGREEMENT_RECORD_FILE_BYTES)
		throw recordError("record-oversized", "Agreement record is oversized");
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch (error) {
		throw recordError("corrupt-record", "Agreement record is not valid UTF-8 JSON", error);
	}
	if (!isAgreementRecord(parsed)) throw recordError("corrupt-record", "Agreement record failed schema validation");
	return parsed;
}

export async function validateRevisionReferences(
	revision: AgreementRevision,
	history: string,
	deps: Deps,
): Promise<void> {
	for (const operation of revision.operations) {
		try {
			const proposalDirectory = await validateRecordDirectory(history, "proposal", deps);
			const proposal = await readRecord(path.join(proposalDirectory, `${operation.proposalId}.json`), deps);
			if (
				proposal.kind !== "proposal" ||
				proposal.status !== "proposed" ||
				proposal.intent !== operation.intent ||
				proposal.targetAgreementId !== operation.targetAgreementId
			)
				throw recordError(
					"invalid-reference",
					`Agreement operation references an incompatible proposal: ${operation.proposalId}`,
				);
		} catch (error) {
			if (error instanceof CrewAgreementStoreError && error.code === "record-not-found")
				throw recordError(
					"invalid-reference",
					`Agreement operation references a missing proposal: ${operation.proposalId}`,
				);
			throw error;
		}
	}
}

function assertActivationCandidate(record: AgreementRecord): AgreementRevision {
	if (
		record.kind !== "revision" ||
		!isAgreementRevision(record) ||
		(record.status !== "candidate" && record.status !== "activated")
	)
		throw recordError("activation-conflict", "only an intact candidate revision can be activated");
	return record;
}

async function loadRevisionProposals(
	revision: AgreementRevision,
	history: string,
	deps: Deps,
): Promise<AgreementProposal[]> {
	const proposals: AgreementProposal[] = [];
	for (const operation of revision.operations) {
		const proposalDirectory = await validateRecordDirectory(history, "proposal", deps);
		const proposal = await readRecord(path.join(proposalDirectory, `${operation.proposalId}.json`), deps);
		if (proposal.kind !== "proposal")
			throw recordError("invalid-reference", "revision references a non-proposal record");
		proposals.push(proposal);
	}
	return proposals;
}

export async function activate(
	revisionId: string,
	history: string,
	manifestPath: string,
	deps: Deps,
): Promise<AgreementActivationResult> {
	if (!safeId(revisionId)) throw recordError("path-unsafe", "Agreement revision id is not a safe filename");
	const currentPath = await resolveCurrentAgreementPath(manifestPath, deps);
	await recoverActivationJournal(history, currentPath, deps);
	const revisionDirectory = await validateRecordDirectory(history, "revision", deps);
	const revision = assertActivationCandidate(
		await readRecord(path.join(revisionDirectory, `${revisionId}.json`), deps),
	);
	const proposals = await loadRevisionProposals(revision, history, deps);
	const statePath = path.join(history, ACTIVATION_STATE_FILE);
	const stateRaw = await readOptionalJson(statePath, deps);
	const current = await readCurrentContent(currentPath, deps);
	const state = stateRaw === undefined ? undefined : parseActivationState(stateRaw);
	if (state !== undefined && state.currentContentHash !== contentHash(current))
		throw recordError("activation-conflict", "Current Crew Agreements changed outside trusted activation");
	const priorRevisionId = state?.currentRevisionId ?? "genesis";
	if (priorRevisionId === revision.id) return { revisionId, priorRevisionId, disposition: "unchanged" };
	if (revision.status !== "candidate")
		throw recordError("activation-conflict", "only a candidate revision can be activated");
	if (!isCurrentAgreementRevisionEligible(revision, proposals))
		throw recordError("activation-conflict", "candidate revision is not eligible for trusted activation");
	if (revision.baseRevisionId !== priorRevisionId)
		throw recordError("stale-base", `Agreement revision base is not current: ${revision.baseRevisionId}`);
	let nextContent: string;
	try {
		nextContent = renderActivatedAgreementContent(current, revision, proposals);
	} catch (error) {
		throw recordError("activation-conflict", "candidate cannot be applied to Current Crew Agreements", error);
	}
	const activatedRevision = { ...revision, status: "activated" as const };
	const { contentHash: _ignoredHash, ...withoutHash } = activatedRevision;
	const nextRevision: AgreementRevision = {
		...activatedRevision,
		contentHash: agreementRevisionContentHash(withoutHash),
	};
	const nextState: ActivationState = {
		version: 1,
		currentRevisionId: revision.id,
		currentContentHash: contentHash(nextContent),
	};
	const journal: ActivationJournal = {
		...nextState,
		priorRevisionId,
		priorContentHash: contentHash(current),
		nextContent,
		nextRevision,
	};
	const journalPath = path.join(history, ACTIVATION_JOURNAL_FILE);
	await atomicWrite(journalPath, stableJson(journal), deps);
	try {
		await atomicWrite(currentPath, nextContent, deps);
		await atomicWrite(path.join(revisionDirectory, `${revision.id}.json`), stableJson(nextRevision), deps);
		await atomicWrite(statePath, stableJson(nextState), deps);
		await deps.unlink(journalPath);
	} catch (error) {
		throw recordError("write-failed", "Agreement activation did not finish durably", error);
	}
	return { revisionId, priorRevisionId, disposition: "activated" };
}
