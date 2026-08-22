import * as os from "node:os";
import * as path from "node:path";

export const CONTROL_DIR = path.join(os.homedir(), ".pi", "intray");
export const SOCKET_SUFFIX = ".sock";

export function getSocketPath(sessionId: string): string {
	return path.join(CONTROL_DIR, `${sessionId}${SOCKET_SUFFIX}`);
}

export function getAliasPath(alias: string): string {
	return path.join(CONTROL_DIR, `${alias}.alias`);
}
