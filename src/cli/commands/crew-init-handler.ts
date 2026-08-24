import { createCrewInitFlow } from "../../application/crew-init-flow.ts";
import { createNodeCrewInitFsAdapter } from "../../infra/crew-init-fs.ts";
import { crewInitHelp } from "../../domain/index.ts";
import { errorResult } from "../errors.ts";
import type { CrewInitCliOptions } from "../arguments.ts";
import type { CliOutcome } from "../output.ts";

/**
 * TASK-0063: `crew init` handler — owns the scaffold flow result mapping and
 * the deterministic local help path. No process streams or signals here; the
 * runner installs cancellation.
 */
export async function runCrewInitCommand(options: CrewInitCliOptions, cwd: string): Promise<CliOutcome> {
	if (options.help) return { kind: "help", text: crewInitHelp() };
	const project = options.project ?? cwd;
	try {
		const result = await createCrewInitFlow(createNodeCrewInitFsAdapter()).run(project);
		if (result.ok === false) {
			return {
				kind: "result",
				result: errorResult(result.error.message, project, result.error.code),
				format: options.format,
				full: false,
			};
		}
		return {
			kind: "result",
			result: {
				ok: true,
				target: project,
				status: result.status,
				response:
					result.status === "created"
						? "Scaffolded .pi/bebop crew; review names/contact/instructions before joining"
						: "Crew scaffold already present and byte-identical",
				data: {
					status: result.status,
					project: result.project,
					manifestPath: result.manifestPath,
					createdPaths: result.createdPaths,
					verifiedPaths: result.verifiedPaths,
					nextCommands: result.nextCommands,
				},
			},
			format: options.format,
			full: false,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : "Crew init failed";
		return {
			kind: "result",
			result: errorResult(message, project, "operational"),
			format: options.format,
			full: false,
		};
	}
}
