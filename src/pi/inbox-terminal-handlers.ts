import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface InboxTerminalCallbacks {
	onSettled: (event: unknown, context: any) => void | Promise<void>;
	onCompaction: (event: unknown, context: any) => void | Promise<void>;
}

/** Composes terminal lifecycle behavior once, so extension wiring and tests share it. */
export function createInboxTerminalOfferCallbacks(dependencies: {
	emitSettled: (context: any) => void;
	offer: () => void | Promise<void>;
	markSettled?: () => void;
	onCompaction?: (event: unknown, context: any) => void;
}): InboxTerminalCallbacks {
	return {
		onSettled: async (_event, context) => {
			dependencies.emitSettled(context);
			dependencies.markSettled?.();
			await dependencies.offer();
		},
		onCompaction: async (event, context) => {
			dependencies.onCompaction?.(event, context);
			await dependencies.offer();
		},
	};
}

export function registerInboxTerminalOfferHandlers(
	pi: Pick<ExtensionAPI, "on">,
	callbacks: InboxTerminalCallbacks,
): void {
	pi.on(
		"agent_settled" as never,
		((event: unknown, context: unknown) => callbacks.onSettled(event, context)) as never,
	);
	pi.on(
		"session_compact" as never,
		((event: unknown, context: unknown) => callbacks.onCompaction(event, context)) as never,
	);
	pi.on(
		"session_compact_failed" as never,
		((event: unknown, context: unknown) => callbacks.onCompaction(event, context)) as never,
	);
}
