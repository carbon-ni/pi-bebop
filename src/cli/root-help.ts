/**
 * TASK-0074: deterministic, zero-IO root help for `pi-bebop --help` / `-h`.
 * Derives only from the registry vocabulary — never touches the filesystem,
 * project, sessions, or dependencies, so it is safe to render before any
 * parsing or dispatch.
 */
export function rootCliHelp(commands: readonly string[]): string {
	const listed = commands.length === 0 ? "  (none)" : commands.map((command) => `  ${command}`).join("\n");
	return [
		"pi-bebop — Pi Bebop crew coordination CLI",
		"",
		"Usage:",
		"  pi-bebop <command> [args] [flags]",
		"  pi-bebop --help | -h",
		"  pi-bebop -v | --version",
		"",
		"Commands:",
		listed,
		"",
		"Run 'pi-bebop <command> --help' for command details.",
		"",
	].join("\n");
}
