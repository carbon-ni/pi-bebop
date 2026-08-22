import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "intray.json");

interface IntrayConfig {
	startByDefault?: boolean;
}

/**
 * Checks whether intray should start its base server by default via the config file
 * at ~/.pi/agent/intray.json.
 * When `startByDefault: true`, intray starts automatically without the --intray flag.
 *
 * The `read` parameter enables dependency injection for testing.
 */
export function isIntrayEnabledByConfig(read: (path: string) => string = (p) => readFileSync(p, "utf-8")): boolean {
	try {
		const raw = read(CONFIG_PATH);
		const config: IntrayConfig = JSON.parse(raw);
		return config.startByDefault === true;
	} catch (err: unknown) {
		if (isEnoent(err)) return false;
		if (err instanceof SyntaxError) return false;
		throw err;
	}
}

function isEnoent(err: unknown): boolean {
	return err instanceof Error && (err as Error & { code: string }).code === "ENOENT";
}
