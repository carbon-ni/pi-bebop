import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SocketState } from "../pi/control-runtime.ts";
import { registerMemberIntentTool, type MemberToolAdapterDependencies } from "./member-tool-adapter.ts";

export function registerSendFollowUpTool(
	pi: ExtensionAPI,
	state: SocketState,
	dependencies: MemberToolAdapterDependencies = {},
): void {
	registerMemberIntentTool(pi, state, "follow_up", dependencies);
}
