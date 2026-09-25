import { promises as fs } from "node:fs";
import * as path from "node:path";
import { CrewManifestError, parseCrewManifest, type CrewManifest } from "../domain/index.ts";
import { type CrewDirectoryDependencies, type CrewDirectoryLiveRuntime } from "../application/crew-directory.ts";
import { getTrustedCrewManifestPaths, isTrustedCrewManifestPath } from "./crew-layout.ts";
import { getLiveSessions } from "./control-store.ts";
import { sendRpcCommand } from "./rpc-client.ts";
import { CrewManifestReadError } from "./crew-manifest-store.ts";
import { probeMemberEndpoint } from "./member-endpoint.ts";

const PROBE_TIMEOUT_MS = 300;

async function readDirectoryManifest(manifestPath: string, projectRoot: string): Promise<CrewManifest> {
	// Trust/layout checks happen before any manifest IO. The realpath check also
	// prevents a supported-looking manifest symlink from escaping the project.
	if (!isTrustedCrewManifestPath(manifestPath, projectRoot))
		throw new CrewManifestReadError("untrusted-path", "crew manifest is outside the supported project layout");
	let projectReal: string;
	let manifestReal: string;
	try {
		projectReal = await fs.realpath(projectRoot);
		manifestReal = await fs.realpath(manifestPath);
	} catch (error) {
		throw new CrewManifestReadError("read-failed", "crew manifest could not be resolved", { cause: error });
	}
	const relative = path.relative(projectReal, manifestReal);
	if (
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative) ||
		path.basename(manifestReal) !== "crew.json" ||
		!(["bebop", "crew"] as const).includes(path.basename(path.dirname(manifestReal)) as "bebop" | "crew")
	)
		throw new CrewManifestReadError(
			"untrusted-path",
			"crew manifest resolves outside the supported project layout",
		);
	let contents: string;
	try {
		contents = await fs.readFile(manifestReal, "utf8");
	} catch (error) {
		throw new CrewManifestReadError("read-failed", "crew manifest could not be read", { cause: error });
	}
	try {
		return parseCrewManifest(JSON.parse(contents), manifestReal);
	} catch (error) {
		if (error instanceof CrewManifestError) throw error;
		throw new CrewManifestReadError("invalid-json", "crew manifest contains invalid JSON", { cause: error });
	}
}

async function readLiveCrewRuntimes(
	projectRoot: string,
	signal?: AbortSignal,
): Promise<readonly CrewDirectoryLiveRuntime[]> {
	if (signal?.aborted) return [];
	const observedAt = new Date().toISOString();
	let sessions;
	try {
		sessions = await getLiveSessions(signal);
	} catch {
		return [];
	}
	const results = await Promise.all(
		sessions.map(async (session): Promise<CrewDirectoryLiveRuntime | undefined> => {
			if (signal?.aborted) return undefined;
			try {
				const { response } = await sendRpcCommand(
					session.socketPath,
					{ type: "status" },
					{ timeout: PROBE_TIMEOUT_MS, signal },
				);
				const statusData = response.data as
					| { status?: unknown; crewLocator?: unknown; projectTrusted?: unknown }
					| undefined;
				if (!response.success || statusData?.status !== "joined") return undefined;
				const data = statusData;
				if (
					typeof data.crewLocator !== "string" ||
					data.projectTrusted !== true ||
					!isTrustedCrewManifestPath(data.crewLocator, projectRoot)
				)
					return undefined;
				return { manifestPath: path.resolve(data.crewLocator), observedAt, availability: "online" };
			} catch {
				return undefined;
			}
		}),
	);
	return results.filter((row): row is CrewDirectoryLiveRuntime => row !== undefined);
}

export const defaultCrewDirectoryDependencies: CrewDirectoryDependencies = {
	discoverManifestPaths: (projectRoot) => getTrustedCrewManifestPaths(projectRoot),
	manifestExists: async (manifestPath, projectRoot) => {
		if (!isTrustedCrewManifestPath(manifestPath, projectRoot)) return false;
		try {
			await fs.access(manifestPath);
			return true;
		} catch {
			return false;
		}
	},
	readManifest: readDirectoryManifest,
	probeMember: (socketPath, signal) => probeMemberEndpoint(socketPath, { timeoutMs: PROBE_TIMEOUT_MS, signal }),
	readObservedLocators: async () => [],
	readLiveRuntimes: readLiveCrewRuntimes,
	now: () => new Date(),
};
