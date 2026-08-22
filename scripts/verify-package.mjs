import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const archiveDir = await mkdtemp(path.join(tmpdir(), "pi-bebop-package-"));
const consumerDir = await mkdtemp(path.join(tmpdir(), "pi-bebop-consumer-"));
const environment = { ...process.env, NODE_PATH: "" };
try {
	const packed = await execFile("npm", ["pack", "--pack-destination", archiveDir], { cwd: root, env: environment });
	const archiveName = packed.stdout.trim().split("\n").find((line) => line.endsWith(".tgz"));
	if (!archiveName) throw new Error("npm pack did not produce an archive");
	const archivePath = path.join(archiveDir, archiveName);
	const consumerPackage = {
		private: true,
		dependencies: {
			"pi-bebop": `file:${archivePath}`,
			"@earendil-works/pi-ai": "0.84.2",
			"@earendil-works/pi-coding-agent": "0.84.2",
			"@earendil-works/pi-tui": "0.84.2",
			"@sinclair/typebox": "0.34.50",
			typebox: "1.1.38",
			"@toon-format/toon": "4.1.1",
		},
	};
	await writeFile(path.join(consumerDir, "package.json"), `${JSON.stringify(consumerPackage, null, 2)}\n`);
	console.log("Installing pinned release consumer dependencies (network/cache required)...");
	await execFile("npm", ["install", "--ignore-scripts", "--no-package-lock", "--no-audit", "--no-fund"], { cwd: consumerDir, env: environment });
	const packageRoot = path.join(consumerDir, "node_modules", "pi-bebop");
	const cli = path.join(packageRoot, "dist/cli/main.js");
	let cliError;
	try { await execFile(process.execPath, [cli, "send", "--socket", "/x", "--message", "x", "--wait", "invalid"], { cwd: consumerDir, env: environment }); } catch (error) { cliError = error; }
	if (cliError?.code !== 2 || !/Invalid --wait/.test(cliError.stdout ?? "")) throw new Error("Installed CLI verification failed");
	const extension = await execFile(process.execPath, ["--input-type=module", "-e", "const resolved = await import.meta.resolve('pi-bebop'); if (!resolved.startsWith('file://' + process.cwd() + '/node_modules/')) throw new Error(resolved); const loaded = await import('pi-bebop'); if (typeof loaded.default !== 'function') throw new Error('extension entrypoint missing'); const toon = await import('@toon-format/toon'); if (!toon.encode) throw new Error('runtime dependency missing'); const peer = await import.meta.resolve('@earendil-works/pi-coding-agent'); if (!peer.startsWith('file://' + process.cwd() + '/node_modules/')) throw new Error(peer);"], { cwd: consumerDir, env: environment });
	if (extension.stderr) process.stderr.write(extension.stderr);
	const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json")));
	if (manifest.main !== "./dist/extension.js") throw new Error("Installed extension entrypoint is not configured");
	console.log(`Package verification passed in isolated consumer: ${consumerDir}`);
} finally {
	await rm(archiveDir, { recursive: true, force: true });
	await rm(consumerDir, { recursive: true, force: true });
}
