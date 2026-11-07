import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type, type Models } from "@earendil-works/pi-ai";
import { AssistantEntry, createRegistry, defineDoc, defineExtension, defineTool, Harness, type SubmissionId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels, type Provider } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

const MAX_READ_BYTES = 64 * 1024;
const MemberIdentityDoc = defineDoc<{
	memberId: string;
	providerId?: string;
	role: string;
	modelId: string;
	workspacePath: string;
	instructionsHash: string;
	trustedProjectRoot: string;
	inboxManifestPath: string;
	requestHashes: Record<string, string>;
}>({
	kind: "bebop.durable.member-identity",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ memberId: "", providerId: "", role: "", modelId: "", workspacePath: "", instructionsHash: "", trustedProjectRoot: "", inboxManifestPath: "", requestHashes: {} }),
	checkpointWhen: () => false,
});

export async function readWorkspaceFile(workspace: string, filePath: string): Promise<string> {
	const root = await realpath(workspace);
	const candidate = await realpath(path.resolve(root, filePath));
	const relative = path.relative(root, candidate);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
		throw new Error("path must stay inside the configured workspace");
	const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const metadata = await handle.stat();
		if (!metadata.isFile()) throw new Error("path is not a regular file");
		if (metadata.size > MAX_READ_BYTES) throw new Error(`file exceeds the ${MAX_READ_BYTES}-byte read limit`);
		const [currentPath, currentMetadata] = await Promise.all([realpath(candidate), stat(candidate)]);
		if (currentPath !== candidate || currentMetadata.dev !== metadata.dev || currentMetadata.ino !== metadata.ino)
			throw new Error("file changed while it was being opened");
		return await handle.readFile("utf8");
	} finally {
		await handle.close();
	}
}

export async function prepareStoragePath(storagePath: string): Promise<string> {
	const filePath = path.resolve(storagePath);
	const parentPath = path.dirname(filePath);
	await mkdir(parentPath, { recursive: true, mode: 0o700 });
	const parentMetadata = await lstat(parentPath);
	if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink())
		throw new Error("storage directory must be a real directory, not a symlink");
	if (parentMetadata.uid !== process.getuid?.() || (parentMetadata.mode & 0o077) !== 0)
		throw new Error("storage directory must be owned by this user and have owner-only permissions (0700)");
	const canonicalParent = await realpath(parentPath);
	const canonicalMetadata = await lstat(canonicalParent);
	if (!canonicalMetadata.isDirectory() || canonicalMetadata.isSymbolicLink())
		throw new Error("storage directory must resolve to a real directory");
	const canonicalFilePath = path.join(canonicalParent, path.basename(filePath));
	try {
		const fileMetadata = await lstat(canonicalFilePath);
		if (fileMetadata.isSymbolicLink() || !fileMetadata.isFile())
			throw new Error("storage file must be a regular file, not a symlink");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return canonicalFilePath;
		throw error;
	}
	return canonicalFilePath;
}

export function requestContentHash(requestHashes: Readonly<Record<string, string>>, requestId: string, payloadHash: string): string {
	if (!/^bebop:[a-f0-9]{64}$/.test(requestId)) throw new Error("requestId is not a valid Bebop delivery key");
	if (!/^[a-f0-9]{64}$/.test(payloadHash)) throw new Error("payloadHash must be a SHA-256 hex digest");
	const existing = Object.hasOwn(requestHashes, requestId) ? requestHashes[requestId] : undefined;
	if (existing && existing !== payloadHash) throw new Error("requestId was already used with different message content");
	return payloadHash;
}

export interface DurableMemberOptions {
	readonly storagePath: string;
	readonly memberId: string;
	readonly modelId: string;
	readonly providerId?: string;
	readonly models?: Models;
	readonly workspacePath: string;
	readonly role?: string;
	readonly instructions?: string;
	readonly provider?: Provider;
	readonly autoResume?: boolean;
	readonly trustedProjectRoot?: string;
	readonly inboxManifestPath?: string;
	readonly onSubmissionSettled?: () => void | Promise<void>;
	readonly readFile?: (workspace: string, filePath: string) => Promise<string>;
}

interface StorageLock {
	release: () => Promise<void>;
}

async function acquireStorageLock(storagePath: string): Promise<StorageLock> {
	const lockPath = `${storagePath}.lock`;
	let handle;
	try {
		handle = await open(lockPath, "wx", 0o600);
	} catch (error) {
		if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
		const lockMetadata = await lstat(lockPath).catch(() => null);
		if (!lockMetadata?.isFile() || lockMetadata.isSymbolicLink() || lockMetadata.uid !== process.getuid?.())
			throw new Error(`refusing unsafe member storage lock: ${lockPath}`);
		const existing = await readFile(lockPath, "utf8").then((value) => JSON.parse(value) as { pid?: unknown; hostname?: unknown }).catch(() => null);
		if (
			existing === null ||
			typeof existing.pid !== "number" ||
			existing.hostname !== hostname()
		)
			throw new Error(`member storage is locked or has an invalid lock file: ${lockPath}`);
		try {
			process.kill(existing.pid, 0);
			throw new Error(`member storage is already open by process ${existing.pid}`);
		} catch (probeError) {
			if (!(typeof probeError === "object" && probeError !== null && "code" in probeError && probeError.code === "ESRCH"))
				throw probeError;
		}
		const currentLock = await lstat(lockPath).catch(() => null);
		if (!currentLock) return acquireStorageLock(storagePath);
		if (currentLock.dev !== lockMetadata.dev || currentLock.ino !== lockMetadata.ino)
			return acquireStorageLock(storagePath);
		await unlink(lockPath);
		return acquireStorageLock(storagePath);
	}
	const metadata = await handle.stat();
	await handle.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname() }));
	return {
		release: async () => {
			await handle.close();
			try {
				const current = await lstat(lockPath);
				if (current.dev === metadata.dev && current.ino === metadata.ino) await unlink(lockPath);
			} catch (error) {
				if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"))
					throw error;
			}
		},
	};
}

export async function durableSocketPath(storagePath: string): Promise<string> {
	const canonicalStoragePath = await prepareStoragePath(storagePath);
	const socketDirectory = `/tmp/pi-bebop-${process.getuid?.() ?? "user"}`;
	await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
	const directoryMetadata = await lstat(socketDirectory);
	if (
		!directoryMetadata.isDirectory() ||
		directoryMetadata.isSymbolicLink() ||
		directoryMetadata.uid !== process.getuid?.() ||
		(directoryMetadata.mode & 0o077) !== 0
	)
		throw new Error("local socket directory must be a real owner-only directory");
	const digest = createHash("sha256").update(canonicalStoragePath).digest("hex").slice(0, 20);
	return path.join(await realpath(socketDirectory), `bebop-${digest}.sock`);
}

export interface DurableMember {
	readonly conversationId: number;
	readonly providerId?: string;
	resume: () => void;
	submit: (message: string, requestId: string) => Promise<{ readonly status: string; readonly answer?: string; readonly reason?: string; readonly detail?: unknown }>;
	admit: (message: string, requestId: string, payloadHash?: string) => Promise<{ readonly submissionId: string }>;
	admitInbox: (itemId: string, message: string, payloadHash: string) => Promise<{ readonly submissionId: string; readonly requestId: string }>;
	awaitSubmission: (submissionId: string) => Promise<{ readonly status: string; readonly answer?: string; readonly reason?: string; readonly detail?: unknown }>;
	close: () => Promise<void>;
}

/** Opens one independent member conversation; callers must ensure one process per storage file. */
export async function openDurableMember(options: DurableMemberOptions): Promise<DurableMember> {
	if (!options.memberId.trim() || options.memberId.length > 128) throw new Error("memberId must contain 1 to 128 characters");
	if (!options.modelId.trim()) throw new Error("modelId must not be empty");

	const context = BACKGROUND_CONTEXT;
	const workspace = await realpath(options.workspacePath);
	const role = options.role ?? "member";
	const instructions = options.instructions ?? "";
	if (!role.trim() || role.length > 128) throw new Error("role must contain 1 to 128 characters");
	const instructionsHash = createHash("sha256").update(instructions).digest("hex");
	const trustedProjectRoot = options.trustedProjectRoot ? await realpath(options.trustedProjectRoot) : "";
	const inboxManifestPath = options.inboxManifestPath ? await realpath(options.inboxManifestPath) : "";
	const storagePath = await prepareStoragePath(options.storagePath);
	const storageLock = await acquireStorageLock(storagePath);
	let harness: Awaited<ReturnType<typeof Harness.open>> | undefined;
	try {
		const provider = options.provider ?? (!options.models ? openaiProvider() : undefined);
		let models: Models;
		if (options.models) {
			models = options.models;
		} else {
			const defaultModels = createModels();
			defaultModels.setProvider(provider!);
			models = defaultModels;
		}
		const providerId = options.providerId ?? provider?.id ?? "openai";
		const registry = createRegistry();
		registry.install(
			defineExtension({
				name: "bebop-read-only",
				tools: [
					defineTool({
						name: "read_file",
						description: "Read a UTF-8 text file under the configured workspace. This tool never writes files.",
						parameters: Type.Object({ path: Type.String() }),
						replay: "safe",
						execute: async ({ path: filePath }) => ({
							output: [{ type: "text", text: await (options.readFile ?? readWorkspaceFile)(workspace, filePath) }],
						}),
					}),
				],
			}),
		);
		harness = await Harness.open(
			await openNodeSqliteStorage(storagePath),
			{ models, registry },
			context,
		);
		const conversation = await harness.root(context, {
			agent: {
				model: { provider: providerId, modelId: options.modelId },
				instructions: [
					`You are independent Bebop crew member ${options.memberId}, serving as ${role}.`,
					"You can only inspect files using read_file under the configured workspace. Do not claim to have changed files or performed work you could not do.",
					instructions,
				].filter(Boolean).join("\n\n"),
			},
		});
		await conversation.commit(async (tx) => {
			const identity = await tx.doc(MemberIdentityDoc, conversation.id);
			if (
				identity.memberId &&
				(identity.memberId !== options.memberId ||
					(identity.providerId ?? "openai") !== providerId ||
					identity.role !== role ||
					identity.modelId !== options.modelId ||
					identity.workspacePath !== workspace ||
					identity.instructionsHash !== instructionsHash ||
					(identity.trustedProjectRoot ?? "") !== trustedProjectRoot ||
					(identity.inboxManifestPath ?? "") !== inboxManifestPath)
			)
				throw new Error("database is bound to a different member configuration");
			Object.assign(identity, {
				memberId: options.memberId,
				providerId,
				role,
				modelId: options.modelId,
				workspacePath: workspace,
				instructionsHash,
				trustedProjectRoot,
				inboxManifestPath,
			});
		}, context);
		let submissionTail: Promise<unknown> = Promise.resolve();
		let closePromise: Promise<void> | undefined;
		const resultForSubmission = async (submission: Awaited<ReturnType<typeof conversation.submit>>) => {
			const settled = await submission.wait(context);
			await options.onSubmissionSettled?.();
			if (settled.status !== "done" || settled.type !== "input")
				return {
					status: settled.status,
					...(settled.status === "unanswered" ? { reason: settled.reason, detail: settled.detail } : {}),
				};
			const answer = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
			const content = answer?.model?.flatMap((modelMessage) =>
				typeof modelMessage.content === "string"
					? [modelMessage.content]
					: modelMessage.content.flatMap((part) => part.type === "text" ? [part.text] : []),
			).join("");
			return { status: settled.status, ...(content ? { answer: content } : {}) };
		};
		const admit = (message: string, requestId: string, payloadHash: string) => {
			if (message.length === 0 || message.length > 8_000)
				return Promise.reject(new Error("message must contain 1 to 8000 characters"));
			const run = submissionTail.then(async () => {
				await conversation.commit(async (tx) => {
					const identity = await tx.doc(MemberIdentityDoc, conversation.id);
					identity.requestHashes[requestId] = requestContentHash(identity.requestHashes, requestId, payloadHash);
				}, context);
				const submission = await conversation.submit({ type: "input", content: message, requestId }, context);
				return { submission, submissionId: String(submission.id) };
			});
			submissionTail = run.then(() => undefined, () => undefined);
			return run;
		};
		if (options.autoResume !== false) harness.resume();
		return {
			resume: () => harness!.resume(),
			conversationId: conversation.id,
			providerId,
			admit: async (message, requestId, payloadHash = createHash("sha256").update(message).digest("hex")) => {
				const { submissionId } = await admit(message, requestId, payloadHash);
				return { submissionId };
			},
			admitInbox: async (itemId, message, payloadHash) => {
				if (!itemId.trim() || itemId.length > 256) throw new Error("inbox item id must contain 1 to 256 characters");
				const requestId = memberRequestId(options.memberId, itemId);
				const { submissionId } = await admit(message, requestId, payloadHash);
				return { submissionId, requestId };
			},
			awaitSubmission: async (submissionId) => {
				const numericId = Number(submissionId);
				if (!Number.isSafeInteger(numericId) || numericId <= 0) throw new Error("submissionId must be a positive integer");
				const submission = await harness!.submission(numericId as SubmissionId, context);
				if (!submission) throw new Error("submission does not exist");
				return resultForSubmission(submission);
			},
			submit: async (message, requestId) => {
				const { submission } = await admit(message, requestId, createHash("sha256").update(message).digest("hex"));
				return resultForSubmission(submission);
			},
			close: () => {
				closePromise ??= (async () => {
					try {
						await harness!.close(context);
					} finally {
						await storageLock.release();
					}
				})();
				return closePromise;
			},
		};
	} catch (error) {
		try {
			if (harness) await harness.close(context);
		} finally {
			await storageLock.release();
		}
		throw error;
	}
}

/** Stable retry key helper. The caller supplies a stable delivery ID; content is not used as identity. */
export function memberRequestId(memberId: string, deliveryId: string): string {
	if (!memberId.trim() || !deliveryId.trim()) throw new Error("memberId and deliveryId must not be empty");
	const digest = createHash("sha256").update(`${memberId}\0${deliveryId}`).digest("hex");
	return `bebop:${digest}`;
}
