declare const __PI_BEBOP_PACKAGE_VERSION__: unknown;
declare const __PI_BEBOP_BUILD_COMMIT__: unknown;

const SOURCE_PACKAGE_VERSION =
	typeof __PI_BEBOP_PACKAGE_VERSION__ === "string" ? __PI_BEBOP_PACKAGE_VERSION__ : "0.0.0-dev";
const SOURCE_BUILD_COMMIT = typeof __PI_BEBOP_BUILD_COMMIT__ === "string" ? __PI_BEBOP_BUILD_COMMIT__ : "0".repeat(40);
const FULL_COMMIT_SHA = /^[0-9a-fA-F]{40}$/;

/** Formats immutable build provenance for the root CLI version flags. */
export function formatCliVersion(packageVersion: string, buildCommit: string): string {
	if (!FULL_COMMIT_SHA.test(buildCommit))
		throw new Error("Build commit must be a full 40-character hexadecimal commit SHA");
	return `pi-bebop ${packageVersion} (commit ${buildCommit.toLowerCase()})`;
}

/** Build-time constants are replaced by esbuild; this module performs no IO. */
export function cliVersionOutput(): string {
	return formatCliVersion(SOURCE_PACKAGE_VERSION, SOURCE_BUILD_COMMIT);
}
