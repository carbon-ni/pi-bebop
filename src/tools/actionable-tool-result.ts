import { presentActionableError, type ActionableErrorDescriptor } from "../domain/index.ts";

export interface ActionableToolResult {
	readonly content: Array<{ readonly type: "text"; readonly text: string }>;
	readonly isError: true;
	readonly details: Record<string, unknown>;
}

/** Shared tool envelope: compatibility code plus the complete safe model. */
export function actionableToolError(
	descriptor: ActionableErrorDescriptor,
	extraDetails: Record<string, unknown> = {},
): ActionableToolResult {
	const actionableError = presentActionableError(descriptor);
	return {
		content: [{ type: "text", text: actionableError.message }],
		isError: true,
		details: { ...extraDetails, error: actionableError.code, actionableError },
	};
}
