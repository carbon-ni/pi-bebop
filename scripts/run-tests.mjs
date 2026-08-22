import { spawnSync } from "node:child_process";

const result = spawnSync("sh", ["-c", "node_modules/.bin/tsx --test src/**/*.test.ts"], {
	stdio: "inherit",
});
process.exit(result.status ?? 1);
