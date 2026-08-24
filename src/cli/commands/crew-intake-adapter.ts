import { promises as fs } from "node:fs";
import path from "node:path";
import { submitExternalIntake, type ExternalIntakeRequest } from "../../application/external-intake.ts";
import { openTrustedMemberInboxStore } from "../../infra/member-inbox-store.ts";
import { CrewManifestReadError } from "../../infra/crew-manifest-store.ts";
import { isTrustedCrewManifestPath } from "../../infra/crew-layout.ts";
import { parseCrewManifest, type CrewManifest, type ExternalIntakeAck } from "../../domain/index.ts";
import type { SendCliOptions } from "../arguments.ts";
import type { CliContext } from "../context.ts";
import type { CliOutcome } from "../output.ts";

/**
 * TASK-0063: durable Crew Intake adapter. Owns the manifest loader with
 * caller-consent framing (TASK-0040 trust boundary) and the intake
 * submission; failures propagate as typed intake errors for the send handler
 * to map. Keeps durable Intake fully separate from direct RPC routing.
 */

export interface ManifestIo {
	readonly readFile: (filePath: string, encoding: "utf8") => Promise<string>;
}

export interface CrewIntakeDependencies {
	readonly submit: (
		request: ExternalIntakeRequest,
		deps: Parameters<typeof submitExternalIntake>[1],
	) => Promise<ExternalIntakeAck>;
	readonly io: ManifestIo;
}

export const defaultCrewIntakeDependencies: CrewIntakeDependencies = {
	submit: (request, deps) => submitExternalIntake(request, deps),
	io: { readFile: (filePath, encoding) => fs.readFile(filePath, encoding) },
};

/**
 * CLI manifest loader with caller-consent framing (TASK-0040 trust boundary):
 * the explicit --crew path plus readable exact-layout manifest plus filesystem
 * permissions are the consent. We enforce layout/filesystem safety here and
 * never report the project as Pi-trusted; the trusted store re-validates the
 * exact layout on open.
 */
export function createCrewManifestLoader(
	cwd: string,
	io: ManifestIo = defaultCrewIntakeDependencies.io,
): (manifestPath: string) => Promise<CrewManifest> {
	return async (manifestPath) => {
		const resolved = path.resolve(cwd, manifestPath);
		const projectRoot = path.resolve(path.dirname(resolved), "..", "..");
		if (!isTrustedCrewManifestPath(resolved, projectRoot)) {
			throw new CrewManifestReadError(
				"untrusted-path",
				`crew manifest must be in an exact supported layout (.pi/bebop or .pi/crew): ${manifestPath}`,
			);
		}
		let contents: string;
		try {
			contents = await io.readFile(resolved, "utf8");
		} catch (error) {
			throw new CrewManifestReadError("read-failed", `failed to read crew manifest: ${resolved}`, {
				cause: error,
			});
		}
		let input: unknown;
		try {
			input = JSON.parse(contents);
		} catch (error) {
			throw new CrewManifestReadError("invalid-json", `invalid JSON in crew manifest: ${resolved}`, {
				cause: error,
			});
		}
		return parseCrewManifest(input, resolved);
	};
}

export async function deliverCrewIntake(
	options: SendCliOptions,
	message: string,
	context: CliContext,
	deps: CrewIntakeDependencies = defaultCrewIntakeDependencies,
): Promise<CliOutcome> {
	const ack = await deps.submit(
		{
			manifestPath: options.crewPath!,
			label: options.origin?.label ?? "external",
			content: message,
			instructions: options.instructions.length === 0 ? undefined : options.instructions,
		},
		{
			loadManifest: createCrewManifestLoader(context.cwd, deps.io),
			// Caller consent replaces Pi trust for the standalone CLI: the explicit
			// --crew path (already layout-validated) plus filesystem permissions are
			// the consent; the store re-validates the exact layout. We never report
			// the project as Pi-trusted.
			openStore: async (storeOptions) =>
				openTrustedMemberInboxStore({
					manifestPath: storeOptions.manifestPath,
					projectRoot: storeOptions.projectRoot,
					isProjectTrusted: () => true,
					member: storeOptions.member,
				}),
		},
	);
	return {
		kind: "result",
		result: {
			ok: true,
			target: options.crewPath!,
			status: "persisted",
			response: `Persisted for ${ack.contact} (${ack.contactRole}) — inbox item ${ack.itemId}`,
			data: ack,
		},
		format: options.format,
		full: options.full,
	};
}
