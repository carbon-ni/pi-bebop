import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(root, "package-fixtures", "release-consumer");
const archiveDir = await mkdtemp(path.join(tmpdir(), "pi-bebop-package-"));
const consumerDir = await mkdtemp(path.join(tmpdir(), "pi-bebop-consumer-"));
const environment = { ...process.env, NODE_PATH: "" };
try {
	await cp(path.join(fixture, "package.json"), path.join(consumerDir, "package.json"));
	await cp(path.join(fixture, "package-lock.json"), path.join(consumerDir, "package-lock.json"));
	console.log("Installing committed, integrity-pinned release consumer fixture (network/cache required)...");
	await execFile("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
		cwd: consumerDir,
		env: environment,
	});

	const packed = await execFile("npm", ["pack", "--pack-destination", archiveDir], { cwd: root, env: environment });
	const archiveName = packed.stdout
		.trim()
		.split("\n")
		.find((line) => line.endsWith(".tgz"));
	if (!archiveName) throw new Error("npm pack did not produce an archive");
	const packageRoot = path.join(consumerDir, "node_modules", "pi-bebop");
	await mkdir(packageRoot, { recursive: true });
	await execFile("tar", ["-xzf", path.join(archiveDir, archiveName), "-C", packageRoot, "--strip-components=1"]);

	const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json")));
	if (manifest.main !== "./dist/extension.js") throw new Error("Installed extension entrypoint is not configured");
	const testedTypebox = JSON.parse(
		await readFile(path.join(consumerDir, "node_modules", "typebox", "package.json")),
	).version;
	if (testedTypebox !== "1.1.38" || manifest.peerDependencies.typebox !== ">=1.1.38 <1.2.0")
		throw new Error(`TypeBox fixture/range mismatch: ${testedTypebox}`);

	const cli = path.join(packageRoot, "dist/cli/main.js");
	let cliError;
	try {
		await execFile(process.execPath, [cli, "send", "--socket", "/x", "--message", "x", "--wait", "invalid"], {
			cwd: consumerDir,
			env: environment,
		});
	} catch (error) {
		cliError = error;
	}
	if (cliError?.code !== 2 || !/Invalid --wait/.test(cliError.stdout ?? ""))
		throw new Error("Installed CLI verification failed");

	// TASK-0054: packed CLI must ship the deterministic crew init templates and
	// scaffold a fresh project; exact rerun is a byte-identical unchanged no-op.
	const initDir = await mkdtemp(path.join(tmpdir(), "pi-bebop-init-"));
	try {
		const initHelp = await execFile(process.execPath, [cli, "crew", "init", "--help"], {
			cwd: initDir,
			env: environment,
		});
		if (!/crew init/.test(initHelp.stdout) || !/\.pi\/bebop\/crew\.json/.test(initHelp.stdout))
			throw new Error("Installed CLI crew init --help missing layout/docs");

		// TASK-0057: no-argument home must render compact TOON project state
		// (scaffold missing -> copyable crew init hint), not full help.
		const home = await execFile(process.execPath, [cli], { cwd: initDir, env: environment });
		if (
			!/status: home/.test(home.stdout) ||
			!/scaffold: missing/.test(home.stdout) ||
			!/crew init/.test(home.stdout)
		)
			throw new Error("Installed CLI no-argument home missing compact state");

		const created = await execFile(process.execPath, [cli, "crew", "init", "--format", "json"], {
			cwd: initDir,
			env: environment,
		});
		const createdResult = JSON.parse(created.stdout);
		if (createdResult.status !== "created" || !createdResult.data.createdPaths.includes(".pi/bebop/crew.json"))
			throw new Error("Installed CLI crew init did not create the canonical scaffold");

		const unchanged = await execFile(process.execPath, [cli, "crew", "init", "--format", "json"], {
			cwd: initDir,
			env: environment,
		});
		const unchangedResult = JSON.parse(unchanged.stdout);
		if (unchangedResult.status !== "unchanged") throw new Error("Installed CLI crew init rerun was not unchanged");
	} finally {
		await rm(initDir, { recursive: true, force: true });
	}
	const extension = await execFile(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			"const resolved = await import.meta.resolve('./node_modules/pi-bebop/dist/extension.js'); if (!resolved.startsWith('file://' + process.cwd() + '/node_modules/')) throw new Error(resolved); const loaded = await import('file://' + process.cwd() + '/node_modules/pi-bebop/dist/extension.js'); if (typeof loaded.default !== 'function') throw new Error('extension entrypoint missing'); const toon = await import('@toon-format/toon'); if (!toon.encode) throw new Error('runtime dependency missing'); const peer = await import.meta.resolve('@earendil-works/pi-coding-agent'); if (!peer.startsWith('file://' + process.cwd() + '/node_modules/')) throw new Error(peer);",
		],
		{ cwd: consumerDir, env: environment },
	);
	if (extension.stderr) process.stderr.write(extension.stderr);
	const host = await execFile(
		process.env.PI_BIN ?? "pi",
		["--no-extensions", "--extension", path.join(packageRoot, "dist/extension.js"), "--help"],
		{ cwd: consumerDir, env: { ...environment, PI_OFFLINE: "1" } },
	);
	if (!host.stdout.includes("--crew-socket")) throw new Error("Pi host loader did not register --crew-socket");
	if (
		/Failed to load extension|Type\\.(Recursive|Composite) is not a function|Unknown option: --crew-socket/.test(
			host.stderr + host.stdout,
		)
	)
		throw new Error(`Pi host extension load failed: ${host.stderr}${host.stdout}`);
	console.log(`Package verification passed in isolated consumer and Pi host loader: ${consumerDir}`);
} finally {
	await rm(archiveDir, { recursive: true, force: true });
	await rm(consumerDir, { recursive: true, force: true });
}
