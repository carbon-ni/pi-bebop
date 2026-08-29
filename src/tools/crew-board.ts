import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readCrewBoard, leaveCrewPost, type CrewBoardStoreDependencies } from "../application/crew-board.ts";
import { openTrustedCrewBoardStore } from "../infra/crew-board-store.ts";
import type { SocketState } from "../pi/control-runtime.ts";
import type { BoardReadResult, CrewPost } from "../domain/index.ts";
import { actionableToolError } from "./actionable-tool-result.ts";

const kinds = Type.Union([
	Type.Literal("tip"),
	Type.Literal("kudos"),
	Type.Literal("feedback"),
	Type.Literal("warning"),
	Type.Literal("note"),
]);
const link = Type.Object(
	{
		relation: Type.Union([Type.Literal("supersedes"), Type.Literal("disputes")]),
		post_id: Type.String({ minLength: 1, maxLength: 69 }),
	},
	{ additionalProperties: false },
);
const appendParameters = Type.Object(
	{
		kind: Type.Optional(kinds),
		message: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
		references: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 16 })),
		link: Type.Optional(link),
	},
	{ additionalProperties: false },
);
const readParameters = Type.Object(
	{
		kinds: Type.Optional(Type.Array(kinds, { maxItems: 5 })),
		after: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
	},
	{ additionalProperties: false },
);

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean; details: unknown };
type AppendParams = {
	kind?: "tip" | "kudos" | "feedback" | "warning" | "note";
	message: string;
	references?: string[];
	link?: { relation: "supersedes" | "disputes"; post_id: string };
};
type ReadParams = { kinds?: ("tip" | "kudos" | "feedback" | "warning" | "note")[]; after?: string; limit?: number };

type DecisionPost = {
	sequence: number;
	kind: CrewPost["kind"];
	author: CrewPost["author"];
	message: string;
	references?: readonly string[];
	link?: { relation: "supersedes" | "disputes"; post_id: string };
};

type DecisionView = {
	posts: readonly DecisionPost[];
	nextCursor?: string;
	hasMore?: true;
	warnings?: readonly string[];
};

function decisionPost(post: CrewPost): DecisionPost {
	return {
		sequence: post.sequence,
		kind: post.kind,
		author: { name: post.author.name, role: post.author.role },
		message: post.message,
		...(post.references.length === 0 ? {} : { references: [...post.references] }),
		...(post.link === null ? {} : { link: { relation: post.link.relation, post_id: post.link.postId } }),
	};
}

function decisionWarnings(result: BoardReadResult): string[] {
	const warnings: string[] = [];
	if (result.corruptCount > 0)
		warnings.push(`${result.corruptCount} corrupt Post${result.corruptCount === 1 ? "" : "s"}`);
	if (result.quarantinedThisRead > 0)
		warnings.push(
			`${result.quarantinedThisRead} Post${result.quarantinedThisRead === 1 ? "" : "s"} quarantined during this read`,
		);
	if (result.corruptCountTruncated) warnings.push("corrupt Post count truncated");
	return warnings;
}

export function toCrewBoardDecisionView(result: BoardReadResult): DecisionView {
	const warnings = decisionWarnings(result);
	return {
		posts: result.posts.map(decisionPost),
		...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
		...(result.hasMore ? { hasMore: true as const } : {}),
		...(warnings.length === 0 ? {} : { warnings }),
	};
}

function formatDecisionPost(post: DecisionPost): string {
	const lines = [`#${post.sequence} [${post.kind}] ${post.author.name} (${post.author.role})`, post.message];
	if (post.references?.length) lines.push(`References: ${post.references.join(", ")}`);
	if (post.link) lines.push(`Link: ${post.link.relation} ${post.link.post_id}`);
	return lines.join("\n");
}

export function formatCrewBoardDecision(result: BoardReadResult): string {
	const view = toCrewBoardDecisionView(result);
	if (view.posts.length === 0) {
		const suffixes = [
			...(view.nextCursor === undefined ? [] : [`More: ${view.nextCursor}`]),
			...(view.warnings?.length ? [`Warning: ${view.warnings.join("; ")}`] : []),
		];
		return ["Crew Board is empty.", ...suffixes].join("\n");
	}
	const posts = view.posts.map(formatDecisionPost).join("\n\n");
	const suffixes = [
		...(view.nextCursor === undefined ? [] : [`More: ${view.nextCursor}`]),
		...(view.warnings?.length ? [`Warning: ${view.warnings.join("; ")}`] : []),
	];
	return suffixes.length === 0 ? posts : `${posts}\n\n${suffixes.join("\n")}`;
}

function defaultDependencies(state: SocketState): CrewBoardStoreDependencies {
	const isProjectTrusted = () => state.context?.isProjectTrusted?.() === true;
	return {
		isProjectTrusted,
		getCurrentMembership: () => state.membershipRuntime?.getMembership() ?? null,
		openStore: (options) => openTrustedCrewBoardStore(options),
	};
}
const BOARD_ERROR_CODES = new Set([
	"not-joined",
	"untrusted-project",
	"untrusted-path",
	"unsupported-layout",
	"stale-membership",
	"invalid-request",
	"invalid-member",
	"invalid-append",
	"invalid-read",
	"invalid-cursor",
	"cursor-filter-mismatch",
	"capacity-exceeded",
	"directory-capacity-exceeded",
	"lock-conflict",
	"read-failed",
	"write-failed",
	"quarantine-failed",
	"idempotency-conflict",
	"link-target-invalid",
]);
export function normalizeCrewBoardErrorCode(code: string | undefined): string {
	return code && BOARD_ERROR_CODES.has(code) ? code : "board-failed";
}

function errorResult(error: unknown): ToolResult {
	const rawCode = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : undefined;
	const code = normalizeCrewBoardErrorCode(rawCode);
	return actionableToolError({
		code,
		operation: "crew_board",
		reason: "the Crew Board operation was rejected",
		recovery: ["verify project trust and crew membership, then retry."],
	});
}

export function registerLeaveCrewPostTool(
	pi: ExtensionAPI,
	state: SocketState,
	dependencies?: CrewBoardStoreDependencies,
): void {
	const boardDependencies = dependencies ?? defaultDependencies(state);
	pi.registerTool({
		name: "leave_crew_post",
		label: "Leave Crew Post",
		description:
			"Append one attributed Crew Post to the shared pull-only Board. Requires current joined Membership; author name and Role come from that Membership, never from arguments. Use when a reusable tip, kudos, feedback, warning, or note should outlive this session. The Post is persisted only: no delivery, notification, read receipt, rating, authority, Agreement, or workflow effect. Other Members may need to inspect the Board explicitly, and content remains a fallible attributed statement.",
		parameters: appendParameters,
		async execute(toolCallId: string, params: AppendParams): Promise<ToolResult> {
			try {
				const result = await leaveCrewPost(
					{
						membership: state.membershipRuntime?.getMembership() ?? null,
						operationId: toolCallId,
						kind: params.kind,
						message: params.message,
						references: params.references,
						link: params.link && { relation: params.link.relation, postId: params.link.post_id },
						now: Date.now(),
					},
					boardDependencies,
				);
				return {
					content: [
						{
							type: "text",
							text: `Crew Post persisted (${result.post.id}, sequence ${result.post.sequence})`,
						},
					],
					details: {
						version: result.version,
						post: result.post,
						persisted: true,
						alreadyPersisted: result.alreadyPersisted,
					},
				};
			} catch (error) {
				return errorResult(error);
			}
		},
	});
}

export function registerReadCrewBoardTool(
	pi: ExtensionAPI,
	state: SocketState,
	dependencies?: CrewBoardStoreDependencies,
): void {
	const boardDependencies = dependencies ?? defaultDependencies(state);
	pi.registerTool({
		name: "read_crew_board",
		label: "Read Crew Board",
		description:
			"Explicitly inspect a bounded page of shared Crew Posts. Requires current joined Membership and is pull-only: reading does not consume, acknowledge, notify, mark read, start a turn, or create per-Member state. Posts are attributed, potentially fallible statements; kinds only filter display and imply no importance, sentiment, authority, rating, or recipient. Use when starting unfamiliar work or seeking shared project context. Newer Posts may appear when refreshing; use the returned cursor for older continuation.",
		parameters: readParameters,
		async execute(_toolCallId: string, params: ReadParams): Promise<ToolResult> {
			try {
				const result = await readCrewBoard(
					{ membership: state.membershipRuntime?.getMembership() ?? null, ...params },
					boardDependencies,
				);
				const view = toCrewBoardDecisionView(result);
				return { content: [{ type: "text", text: formatCrewBoardDecision(result) }], details: view };
			} catch (error) {
				return errorResult(error);
			}
		},
	});
}
