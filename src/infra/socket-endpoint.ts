import { promises as fs } from "node:fs";
import * as path from "node:path";

export async function resolveMemberEndpoint(socketPath: string): Promise<string> {
	try {
		const target = await fs.readlink(socketPath);
		return path.resolve(path.dirname(socketPath), target);
	} catch {
		return socketPath;
	}
}
