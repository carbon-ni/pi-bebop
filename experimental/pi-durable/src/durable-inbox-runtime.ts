import type { DurableMember } from "./member.ts";
import { openDurableInboxBridge } from "./inbox.ts";
import type { DurableInboxDrainResult } from "./inbox.ts";

export interface DurableInboxRuntime {
	drainOne(): Promise<DurableInboxDrainResult>;
	close(): Promise<void>;
	resume(): void;
}

/** Claim the trusted recipient before Durable resumes, then serialize Inbox-triggered work. */
export async function openDurableInboxRuntime(options: {
	readonly manifestPath: string;
	readonly projectRoot: string;
	readonly isProjectTrusted: () => boolean;
	readonly memberId: string;
	readonly hostSocketPath: string;
	readonly member: DurableMember;
}): Promise<DurableInboxRuntime> {
	const bridge = await openDurableInboxBridge({
		manifestPath: options.manifestPath,
		projectRoot: options.projectRoot,
		isProjectTrusted: options.isProjectTrusted,
		memberId: options.memberId,
		hostSocketPath: options.hostSocketPath,
		admit: (message, requestId, payloadHash) => options.member.admit(message, requestId, payloadHash),
	});
	let closed = false;
	let drainTail: Promise<unknown> = Promise.resolve();
	const drainOne = (): Promise<DurableInboxDrainResult> => {
		const run = drainTail.then(() => closed
			? Promise.reject(new Error("Durable Inbox runtime is closed"))
			: bridge.drainOne());
		drainTail = run.then(() => undefined, () => undefined);
		return run;
	};
	return {
		drainOne,
		close: async () => {
			if (closed) return;
			closed = true;
			await bridge.close();
		},
		resume: () => options.member.resume(),
	};
}
