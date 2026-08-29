import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { presentActionableError, type ActionableErrorDescriptor } from "../domain/index.ts";

export function reportActionableError(ctx: ExtensionContext, descriptor: ActionableErrorDescriptor): void {
	const message = presentActionableError(descriptor).message;
	if (ctx.hasUI) {
		ctx.ui.notify(message, "error");
		return;
	}
	console.error(message);
}
