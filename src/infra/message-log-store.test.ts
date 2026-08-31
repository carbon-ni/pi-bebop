import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import {
	link,
	mkdir,
	mkdtemp,
	open,
	rename,
	readFile,
	readdir,
	realpath,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createMessageLogStore, MessageLogStoreError } from "./message-log-store.ts";
import { canonicalMessageLogEntryBytes } from "../domain/index.ts";

const entry = {
	version: 1,
	kind: "message-event",
	id: "entry-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	occurredAt: "2026-08-28T00:00:00.000Z",
	surface: "follow-up",
	stage: "delivery",
	outcome: "queued",
	operation: { id: "op-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", lifecycleSequence: 1 },
	payload: {
		state: "represented",
		reason: null,
		content: {
			state: "captured",
			reason: null,
			text: "",
			normalizedUtf8Bytes: 0,
			retainedUtf8Bytes: 0,
			omittedUtf8Bytes: 0,
			truncated: false,
			escapedMarkerCount: 0,
			redactions: [],
		},
		instructions: [],
		instructionCount: 0,
	},
	errorCode: null,
	capture: {
		endpointId: "endpoint-cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
		epochId: "epoch-dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
		attemptSequence: 1,
		capturedAt: "2026-08-28T00:00:00.000Z",
	},
	semanticFingerprint: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
};

async function makeFixture(layout: "bebop" | "crew" = "bebop") {
	const root = await mkdtemp(`${tmpdir()}/message-log-`);
	const manifestPath = path.join(root, ".pi", layout, "crew.json");
	await mkdir(path.dirname(manifestPath), { recursive: true });
	return {
		root,
		manifestPath,
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}

test("trusted message log append is replay-idempotent and rejects conflicts", async () => {
	const fixture = await makeFixture();
	try {
		const store = createMessageLogStore({
			manifestPath: fixture.manifestPath,
			projectRoot: fixture.root,
			isProjectTrusted: () => true,
			fs: { sync: async () => undefined },
		});
		await store.append(entry);
		await store.append(entry);
		assert.deepEqual(await store.read(entry.id), canonicalMessageLogEntryBytes(entry));
		await assert.rejects(
			() => store.append({ ...entry, outcome: "failed", errorCode: "storage-failed" }),
			(e) => e instanceof MessageLogStoreError && e.code === "id-conflict",
		);
	} finally {
		await fixture.cleanup();
	}
});

test("rejects canonical entries over the 64 KiB per-event capacity before publication", async () => {
	const fixture = await makeFixture();
	const oversized = { ...entry, summary: "x".repeat(65_000) };
	try {
		const store = createMessageLogStore({
			manifestPath: fixture.manifestPath,
			projectRoot: fixture.root,
			isProjectTrusted: () => true,
			fs: { sync: async () => undefined },
		});
		await assert.rejects(
			() => store.append(oversized),
			(error) => error instanceof MessageLogStoreError && error.code === "capacity-exceeded",
		);
		await assert.rejects(() =>
			readFile(path.join(fixture.root, ".pi", "bebop", "message-log", `${entry.id}.json`)),
		);
	} finally {
		await fixture.cleanup();
	}
});

test("reports malformed, oversized, noncanonical, and mismatched persisted bytes without mutation", async () => {
	const persistedCases: ReadonlyArray<readonly [string, Buffer]> = [
		["malformed", Buffer.from('{"version":1}\n')],
		["oversized", Buffer.alloc(65_537, 120)],
		["noncanonical", Buffer.from(`${JSON.stringify(entry)}\n`)],
		[
			"mismatched-id",
			Buffer.from(
				canonicalMessageLogEntryBytes({
					...entry,
					id: "entry-ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
				}),
			),
		],
	];
	for (const [label, persisted] of persistedCases) {
		const fixture = await makeFixture();
		const target = path.join(fixture.root, ".pi", "bebop", "message-log", `${entry.id}.json`);
		try {
			await mkdir(path.dirname(target), { recursive: true });
			await writeFile(target, persisted);
			const store = createMessageLogStore({
				manifestPath: fixture.manifestPath,
				projectRoot: fixture.root,
				isProjectTrusted: () => true,
			});
			await assert.rejects(
				() => store.read(entry.id),
				(error) => {
					assert.equal(error instanceof MessageLogStoreError, true, label);
					return error instanceof MessageLogStoreError && error.code === "invalid-entry";
				},
			);
			assert.deepEqual(await readFile(target), persisted, label);
		} finally {
			await fixture.cleanup();
		}
	}
});

test("quarantines a malformed artifact before publishing its replacement", async () => {
	const fixture = await makeFixture();
	const messageLog = path.join(fixture.root, ".pi", "bebop", "message-log");
	const target = path.join(messageLog, `${entry.id}.json`);
	const malformed = Buffer.from('{"version":1}\n');
	const quarantineName = `artifact-${"a".repeat(64)}.bin`;
	try {
		await mkdir(messageLog, { recursive: true });
		await writeFile(target, malformed);
		const store = createMessageLogStore({
			manifestPath: fixture.manifestPath,
			projectRoot: fixture.root,
			isProjectTrusted: () => true,
			hash: () => "a".repeat(64),
			fs: { sync: async () => undefined },
		});
		await store.append(entry);
		assert.deepEqual(Buffer.from(await readFile(target)), Buffer.from(canonicalMessageLogEntryBytes(entry)));
		assert.deepEqual(Buffer.from(await readFile(path.join(messageLog, "quarantine", quarantineName))), malformed);
	} finally {
		await fixture.cleanup();
	}
});

test("rejects a quarantine symlink before enumerating outside the trusted log", async () => {
	const fixture = await makeFixture();
	const messageLog = path.join(fixture.root, ".pi", "bebop", "message-log");
	const quarantineDir = path.join(messageLog, "quarantine");
	const outsideDir = path.join(fixture.root, "outside");
	const target = path.join(messageLog, `${entry.id}.json`);
	const malformed = Buffer.from('{"version":1}\n');
	let quarantineEnumerated = false;
	try {
		await mkdir(messageLog, { recursive: true });
		await mkdir(outsideDir, { recursive: true });
		await writeFile(target, malformed);
		await symlink(outsideDir, quarantineDir, "dir");
		const store = createMessageLogStore({
			manifestPath: fixture.manifestPath,
			projectRoot: fixture.root,
			isProjectTrusted: () => true,
			fs: {
				readdir: async (directory) => {
					if (directory === quarantineDir) quarantineEnumerated = true;
					return readdir(directory);
				},
				sync: async () => undefined,
			},
		});
		await assert.rejects(
			() => store.append(entry),
			(error) => error instanceof MessageLogStoreError && error.code === "untrusted-path",
		);
		assert.equal(quarantineEnumerated, false);
		assert.deepEqual(await readFile(target), malformed);
	} finally {
		await fixture.cleanup();
	}
});

test("preserves healthy entries when quarantine byte capacity is full", async () => {
	const fixture = await makeFixture();
	const messageLog = path.join(fixture.root, ".pi", "bebop", "message-log");
	const quarantineDir = path.join(messageLog, "quarantine");
	const existing = path.join(messageLog, `${entry.id}.json`);
	const nextEntry = { ...entry, id: "entry-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
	try {
		await mkdir(quarantineDir, { recursive: true });
		await writeFile(existing, canonicalMessageLogEntryBytes(entry));
		await writeFile(path.join(quarantineDir, "artifact-full.bin"), Buffer.alloc(16 * 1024 * 1024));
		const store = createMessageLogStore({
			manifestPath: fixture.manifestPath,
			projectRoot: fixture.root,
			isProjectTrusted: () => true,
			fs: { sync: async () => undefined },
		});
		await store.append(nextEntry);
		assert.deepEqual(await store.read(nextEntry.id), canonicalMessageLogEntryBytes(nextEntry));
	} finally {
		await fixture.cleanup();
	}
});

test("fails closed when scanning a corrupt artifact cannot read it", async () => {
	const fixture = await makeFixture();
	const messageLog = path.join(fixture.root, ".pi", "bebop", "message-log");
	const target = path.join(messageLog, `${entry.id}.json`);
	const malformed = Buffer.from('{"version":1}\n');
	try {
		await mkdir(messageLog, { recursive: true });
		await writeFile(target, malformed);
		const store = createMessageLogStore({
			manifestPath: fixture.manifestPath,
			projectRoot: fixture.root,
			isProjectTrusted: () => true,
			fs: {
				readFile: async (filePath) => {
					if (filePath === target) throw Object.assign(new Error("read failed"), { code: "EIO" });
					return readFile(filePath);
				},
				sync: async () => undefined,
			},
		});
		await assert.rejects(
			() => store.append(entry),
			(error) => error instanceof MessageLogStoreError && error.code === "write-failed",
		);
		assert.deepEqual(await readFile(target), malformed);
	} finally {
		await fixture.cleanup();
	}
});

test("fails closed when quarantine file capacity is full", async () => {
	const fixture = await makeFixture();
	const messageLog = path.join(fixture.root, ".pi", "bebop", "message-log");
	const quarantineDir = path.join(messageLog, "quarantine");
	const target = path.join(messageLog, `${entry.id}.json`);
	const malformed = Buffer.from('{"version":1}\n');
	try {
		await mkdir(quarantineDir, { recursive: true });
		await writeFile(target, malformed);
		await Promise.all(
			Array.from({ length: 256 }, (_, index) =>
				writeFile(path.join(quarantineDir, `artifact-${index}.bin`), Buffer.from([index % 256])),
			),
		);
		const store = createMessageLogStore({
			manifestPath: fixture.manifestPath,
			projectRoot: fixture.root,
			isProjectTrusted: () => true,
			fs: { sync: async () => undefined },
		});
		await assert.rejects(
			() => store.append(entry),
			(error) => error instanceof MessageLogStoreError && error.code === "capacity-exceeded",
		);
		assert.deepEqual(Buffer.from(await readFile(target)), malformed);
	} finally {
		await fixture.cleanup();
	}
});

test("fails closed before publication when the bounded scan overflows", async () => {
	const fixture = await makeFixture();
	const messageLog = path.join(fixture.root, ".pi", "bebop", "message-log");
	const files = Array.from({ length: 50_001 }, (_, index) => `entry-${index.toString(16).padStart(64, "0")}.json`);
	try {
		await mkdir(messageLog, { recursive: true });
		const store = createMessageLogStore({
			manifestPath: fixture.manifestPath,
			projectRoot: fixture.root,
			isProjectTrusted: () => true,
			fs: {
				readdir: async (directory) => (directory === messageLog ? files : []),
				sync: async () => undefined,
			},
		});
		await assert.rejects(
			() => store.append(entry),
			(error) => error instanceof MessageLogStoreError && error.code === "capacity-exceeded",
		);
	} finally {
		await fixture.cleanup();
	}
});

test("fails closed when quarantine file capacity exceeds 256 files", async () => {
	const fixture = await makeFixture();
	const messageLog = path.join(fixture.root, ".pi", "bebop", "message-log");
	const quarantineDir = path.join(messageLog, "quarantine");
	const target = path.join(messageLog, `${entry.id}.json`);
	const malformed = Buffer.from('{"version":1}\n');
	try {
		await mkdir(quarantineDir, { recursive: true });
		await writeFile(target, malformed);
		const store = createMessageLogStore({
			manifestPath: fixture.manifestPath,
			projectRoot: fixture.root,
			isProjectTrusted: () => true,
			fs: {
				readdir: async (directory) =>
					directory === quarantineDir
						? Array.from({ length: 257 }, (_, index) => `artifact-${index}.bin`)
						: [],
				sync: async () => undefined,
			},
		});
		await assert.rejects(
			() => store.append(entry),
			(error) => error instanceof MessageLogStoreError && error.code === "capacity-exceeded",
		);
		assert.deepEqual(await readFile(target), malformed);
	} finally {
		await fixture.cleanup();
	}
});

test("fails closed when a corrupt artifact exceeds remaining 16 MiB quarantine capacity", async () => {
	const fixture = await makeFixture();
	const messageLog = path.join(fixture.root, ".pi", "bebop", "message-log");
	const quarantineDir = path.join(messageLog, "quarantine");
	const existingQuarantine = path.join(quarantineDir, "artifact-full.bin");
	const target = path.join(messageLog, `${entry.id}.json`);
	const malformed = Buffer.from('{"version":1}\n');
	try {
		await mkdir(quarantineDir, { recursive: true });
		await writeFile(existingQuarantine, Buffer.from([1]));
		await writeFile(target, malformed);
		const store = createMessageLogStore({
			manifestPath: fixture.manifestPath,
			projectRoot: fixture.root,
			isProjectTrusted: () => true,
			fs: {
				stat: async (filePath) =>
					filePath === existingQuarantine ? { size: 16 * 1024 * 1024 } : { size: malformed.byteLength },
				sync: async () => undefined,
			},
		});
		await assert.rejects(
			() => store.append(entry),
			(error) => error instanceof MessageLogStoreError && error.code === "capacity-exceeded",
		);
		assert.deepEqual(await readFile(target), malformed);
	} finally {
		await fixture.cleanup();
	}
});

test("quarantines oversized, noncanonical, and ID-mismatched artifacts", async () => {
	const fixture = await makeFixture();
	const messageLog = path.join(fixture.root, ".pi", "bebop", "message-log");
	const artifacts = [
		["entry-1111111111111111111111111111111111111111111111111111111111111111.json", Buffer.alloc(65_537, 120)],
		[
			"entry-2222222222222222222222222222222222222222222222222222222222222222.json",
			Buffer.from(`${JSON.stringify(entry)}\n`),
		],
		[
			"entry-3333333333333333333333333333333333333333333333333333333333333333.json",
			Buffer.from(
				canonicalMessageLogEntryBytes({
					...entry,
					id: "entry-ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
				}),
			),
		],
	] as const;
	try {
		await mkdir(messageLog, { recursive: true });
		for (const [file, bytes] of artifacts) await writeFile(path.join(messageLog, file), bytes);
		const store = createMessageLogStore({
			manifestPath: fixture.manifestPath,
			projectRoot: fixture.root,
			isProjectTrusted: () => true,
			fs: { sync: async () => undefined },
		});
		await store.append(entry);
		assert.deepEqual(await store.read(entry.id), canonicalMessageLogEntryBytes(entry));
		const expectedNames = artifacts.map(([, bytes]) => {
			const digest = createHash("sha256").update(Buffer.from(bytes).toString("base64")).digest("hex");
			return `artifact-${digest}.bin`;
		});
		assert.deepEqual((await readdir(path.join(messageLog, "quarantine"))).sort(), expectedNames.sort());
	} finally {
		await fixture.cleanup();
	}
});

test("quarantines corrupt artifacts in the legacy .pi/crew layout", async () => {
	const fixture = await makeFixture("crew");
	const messageLog = path.join(fixture.root, ".pi", "crew", "message-log");
	const target = path.join(messageLog, `${entry.id}.json`);
	const malformed = Buffer.from('{"version":1}\n');
	try {
		await mkdir(messageLog, { recursive: true });
		await writeFile(target, malformed);
		const store = createMessageLogStore({
			manifestPath: fixture.manifestPath,
			projectRoot: fixture.root,
			isProjectTrusted: () => true,
			hash: () => "b".repeat(64),
			fs: { sync: async () => undefined },
		});
		await store.append(entry);
		assert.deepEqual(
			await readFile(path.join(messageLog, "quarantine", `artifact-${"b".repeat(64)}.bin`)),
			malformed,
		);
	} finally {
		await fixture.cleanup();
	}
});

test("fails closed for invalid hash and quarantine filesystem failures", async () => {
	const modes = ["hash", "stat", "link", "sync"] as const;
	for (const mode of modes) {
		const fixture = await makeFixture();
		const messageLog = path.join(fixture.root, ".pi", "bebop", "message-log");
		const target = path.join(messageLog, `${entry.id}.json`);
		const malformed = Buffer.from('{"version":1}\n');
		try {
			await mkdir(messageLog, { recursive: true });
			await writeFile(target, malformed);
			let fsOverrides: Parameters<typeof createMessageLogStore>[0]["fs"] = { sync: async () => undefined };
			if (mode === "hash") {
				fsOverrides = { sync: async () => undefined };
			} else if (mode === "stat") {
				fsOverrides = {
					stat: async () => {
						throw Object.assign(new Error("stat failed"), { code: "EIO" });
					},
					sync: async () => undefined,
				};
			} else if (mode === "link") {
				fsOverrides = {
					link: async () => {
						throw Object.assign(new Error("link failed"), { code: "EIO" });
					},
					sync: async () => undefined,
				};
			} else {
				fsOverrides = {
					sync: async (filePath) => {
						if (filePath.includes("/quarantine/")) throw new Error("sync failed");
					},
				};
			}
			const store = createMessageLogStore({
				manifestPath: fixture.manifestPath,
				projectRoot: fixture.root,
				isProjectTrusted: () => true,
				hash: mode === "hash" ? () => "invalid" : undefined,
				fs: fsOverrides,
			});
			await assert.rejects(
				() => store.append(entry),
				(error) => error instanceof MessageLogStoreError && error.code === "write-failed",
			);
			assert.deepEqual(await readFile(target), malformed);
		} finally {
			await fixture.cleanup();
		}
	}
});

test("scans exactly 50,000 healthy entries before appending", async () => {
	const fixture = await makeFixture();
	const messageLog = path.join(fixture.root, ".pi", "bebop", "message-log");
	const files = Array.from({ length: 50_000 }, (_, index) => `entry-${index.toString(16).padStart(64, "0")}.json`);
	try {
		await mkdir(messageLog, { recursive: true });
		const store = createMessageLogStore({
			manifestPath: fixture.manifestPath,
			projectRoot: fixture.root,
			isProjectTrusted: () => true,
			fs: {
				readdir: async (directory) => (directory === messageLog ? files : []),
				stat: async (filePath) => ({
					size: canonicalMessageLogEntryBytes({ ...entry, id: path.basename(filePath, ".json") }).byteLength,
				}),
				readFile: async (filePath) => {
					if (filePath.endsWith(".lock")) return readFile(filePath);
					return Buffer.from(
						canonicalMessageLogEntryBytes({ ...entry, id: path.basename(filePath, ".json") }),
					);
				},
				sync: async () => undefined,
			},
		});
		await store.append(entry);
	} finally {
		await fixture.cleanup();
	}
});

test("uses the injected hash seam for lock ownership tokens", async () => {
	const fixture = await makeFixture();
	const hashInputs: string[] = [];
	let lockOwner: string | undefined;
	try {
		const store = createMessageLogStore({
			manifestPath: fixture.manifestPath,
			projectRoot: fixture.root,
			isProjectTrusted: () => true,
			hash: (value) => {
				hashInputs.push(value);
				return "stable-owner";
			},
			fs: {
				sync: async () => undefined,
				writeFile: async (filePath, data, options) => {
					if (filePath.endsWith("/.lock")) lockOwner = String(data);
					return writeFile(filePath, data, options);
				},
			},
		});
		await store.append(entry);
		assert.equal(hashInputs.length, 1);
		assert.equal(lockOwner, "stable-owner");
	} finally {
		await fixture.cleanup();
	}
});

test("append fsyncs publication sequence", async () => {
	const fixture = await makeFixture();
	const syncCalls: string[] = [];
	try {
		const messageLog = path.join(fixture.root, ".pi", "bebop", "message-log");
		const target = path.join(messageLog, `${entry.id}.json`);
		const temp = `${target}.tmp-${process.pid}`;
		await mkdir(messageLog, { recursive: true });
		const store = createMessageLogStore({
			manifestPath: fixture.manifestPath,
			projectRoot: fixture.root,
			isProjectTrusted: () => true,
			fs: {
				mkdir: async () => undefined,
				readFile: async (filePath: string) => readFile(filePath),
				writeFile: async (filePath: string, data: string | Uint8Array, options?: { flag?: string }) => {
					await writeFile(filePath, data, options);
				},
				link: async (source: string, destination: string) => {
					syncCalls.push(`link:${destination}`);
					return link(source, destination);
				},
				rename: async () => {
					assert.fail("rename must never be used in message log publication path");
				},
				open: async (filePath: string, flags: string) => {
					syncCalls.push(`open:${filePath}`);
					const handle = await open(filePath, flags);
					return { close: async () => handle.close() };
				},
				unlink: async (filePath: string) => {
					syncCalls.push(`unlink:${filePath}`);
					return unlink(filePath);
				},
				realpath: async (filePath: string) => realpath(filePath),
				sync: async (filePath: string) => {
					syncCalls.push(`sync:${filePath}`);
				},
			},
		});
		await store.append(entry);
		assert.deepEqual(await store.read(entry.id), canonicalMessageLogEntryBytes(entry));
		const publicationTrace = syncCalls.filter((line) => line === `link:${target}` || line.startsWith("sync:"));
		assert.deepEqual(publicationTrace, [`sync:${temp}`, `link:${target}`, `sync:${target}`, `sync:${messageLog}`]);
	} finally {
		await fixture.cleanup();
	}
});

test("lock contention is bounded and cleanup permits the next append", async () => {
	const fixture = await makeFixture();
	try {
		const messageLog = path.join(fixture.root, ".pi", "bebop", "message-log");
		await mkdir(messageLog, { recursive: true });
		await writeFile(`${messageLog}/.lock`, "foreign");
		let clock = 0;
		const store = createMessageLogStore({
			manifestPath: fixture.manifestPath,
			projectRoot: fixture.root,
			isProjectTrusted: () => true,
			fs: { sync: async () => undefined },
			now: () => clock,
			sleep: async () => {
				clock += 500;
			},
		});
		await assert.rejects(
			() => store.append(entry),
			(e) => e instanceof MessageLogStoreError && e.code === "lock-conflict",
		);
		await rm(`${messageLog}/.lock`);
		await store.append(entry);
	} finally {
		await fixture.cleanup();
	}
});
test("sync failure before publish prevents publication", async () => {
	const fixture = await makeFixture();
	const messageLog = path.join(fixture.root, ".pi", "bebop", "message-log");
	const target = path.join(messageLog, `${entry.id}.json`);
	await mkdir(messageLog, { recursive: true });
	const ioError = new Error("fsync failure") as NodeJS.ErrnoException;
	ioError.code = "EIO";
	const failingSync = async (filePath: string) => {
		if (filePath === `${target}.tmp-${process.pid}`) throw ioError;
	};
	const store = createMessageLogStore({
		manifestPath: fixture.manifestPath,
		projectRoot: fixture.root,
		isProjectTrusted: () => true,
		fs: {
			sync: failingSync,
		},
	});
	try {
		await assert.rejects(
			() => store.append(entry),
			(error) => {
				assert.ok(error instanceof MessageLogStoreError);
				assert.equal(error.code, "write-failed");
				return true;
			},
		);
		await assert.rejects(
			() => readFile(target),
			(error) => (error as NodeJS.ErrnoException).code === "ENOENT",
		);
	} finally {
		await fixture.cleanup();
	}
});

test("sync failure after publish rollbacks target file", async () => {
	const fixture = await makeFixture();
	const messageLog = path.join(fixture.root, ".pi", "bebop", "message-log");
	const target = path.join(messageLog, `${entry.id}.json`);
	await mkdir(messageLog, { recursive: true });
	const targetSyncFailure = new Error("fsync target failure") as NodeJS.ErrnoException;
	targetSyncFailure.code = "EIO";
	const failingSync = async (filePath: string) => {
		if (filePath === target || filePath === messageLog) {
			if (filePath === target) throw targetSyncFailure;
		}
	};
	const store = createMessageLogStore({
		manifestPath: fixture.manifestPath,
		projectRoot: fixture.root,
		isProjectTrusted: () => true,
		fs: {
			sync: failingSync,
		},
	});
	try {
		await assert.rejects(
			() => store.append(entry),
			(error) => {
				assert.ok(error instanceof MessageLogStoreError);
				assert.equal(error.code, "write-failed");
				return true;
			},
		);
		await assert.rejects(
			() => readFile(target),
			(error) => (error as NodeJS.ErrnoException).code === "ENOENT",
		);
	} finally {
		await fixture.cleanup();
	}
});

test("directory sync failure rolls back target and reports write-failed", async () => {
	const fixture = await makeFixture();
	const messageLog = path.join(fixture.root, ".pi", "bebop", "message-log");
	const target = path.join(messageLog, `${entry.id}.json`);
	await mkdir(messageLog, { recursive: true });
	const directorySyncFailure = new Error("directory fsync failure") as NodeJS.ErrnoException;
	directorySyncFailure.code = "EIO";
	const sync = async (filePath: string) => {
		if (filePath === messageLog) throw directorySyncFailure;
	};
	const store = createMessageLogStore({
		manifestPath: fixture.manifestPath,
		projectRoot: fixture.root,
		isProjectTrusted: () => true,
		fs: { sync },
	});
	try {
		await assert.rejects(
			() => store.append(entry),
			(error) => error instanceof MessageLogStoreError && error.code === "write-failed",
		);
		await assert.rejects(
			() => readFile(target),
			(error) => (error as NodeJS.ErrnoException).code === "ENOENT",
		);
	} finally {
		await fixture.cleanup();
	}
});

test("owner token protects lock release from ownership races", async () => {
	const fixture = await makeFixture();
	try {
		const messageLog = path.join(fixture.root, ".pi", "bebop", "message-log");
		await mkdir(messageLog, { recursive: true });
		const lockPath = path.join(messageLog, ".lock");
		const target = path.join(messageLog, `${entry.id}.json`);
		let tampered = false;
		const store = createMessageLogStore({
			manifestPath: fixture.manifestPath,
			projectRoot: fixture.root,
			isProjectTrusted: () => true,
			fs: {
				mkdir: async () => undefined,
				readFile: async (filePath: string) => {
					return readFile(filePath);
				},
				writeFile: async (
					filePath: string,
					data: Buffer | string | Uint8Array,
					options?: { flag?: string },
				) => {
					await writeFile(filePath, data, options);
				},
				link: async (source: string, destination: string) => {
					const result = await link(source, destination);
					if (!tampered) {
						tampered = true;
						await rm(lockPath, { force: true });
						await writeFile(lockPath, "foreign-owner", { encoding: "utf8" });
					}
					return result;
				},
				rename: async () => {
					assert.fail("rename must never be used in message log publication path");
				},
				open: async (filePath: string, flags: string) => {
					const handle = await open(filePath, flags);
					return { close: async () => handle.close() };
				},
				unlink: async (filePath: string) => unlink(filePath),
				realpath: async (filePath: string) => realpath(filePath),
			},
		});
		await assert.rejects(
			() => store.append(entry),
			(error) => {
				assert.ok(error instanceof MessageLogStoreError);
				assert.equal(error.code, "lock-conflict");
				return true;
			},
		);
		assert.equal(await readFile(target, "utf8"), new TextDecoder().decode(canonicalMessageLogEntryBytes(entry)));
		assert.equal(await readFile(lockPath, "utf8"), "foreign-owner");
	} finally {
		await fixture.cleanup();
	}
});

test("trusted layout rejects symlink-escaped manifest directories", async () => {
	const fixture = await makeFixture();
	const outside = await mkdtemp(`${tmpdir()}/message-log-escape-`);
	const messageLog = path.join(fixture.root, ".pi", "bebop");
	await rm(messageLog, { recursive: true, force: true });
	const safeExternal = path.join(outside, ".pi", "bebop");
	await mkdir(safeExternal, { recursive: true });
	await symlink(safeExternal, messageLog, "dir");
	try {
		const store = createMessageLogStore({
			manifestPath: fixture.manifestPath,
			projectRoot: fixture.root,
			isProjectTrusted: () => true,
		});
		await assert.rejects(
			() => store.append(entry),
			(error) => {
				assert.ok(error instanceof MessageLogStoreError);
				assert.equal(error.code, "untrusted-path");
				return true;
			},
		);
	} finally {
		await rm(outside, { recursive: true, force: true });
		await fixture.cleanup();
	}
});

test("append is idempotent when a target file races publication", async () => {
	const fixture = await makeFixture();
	try {
		const messageLog = path.join(fixture.root, ".pi", "bebop", "message-log");
		await mkdir(messageLog, { recursive: true });
		const bytes = canonicalMessageLogEntryBytes(entry);
		const file = path.join(messageLog, `${entry.id}.json`);
		let reads = 0;
		let race = true;
		const fs = {
			mkdir: async () => undefined,
			readFile: async (filePath: string) => {
				if (filePath === file) {
					reads += 1;
					if (reads === 1) {
						const miss: NodeJS.ErrnoException = new Error("missing");
						miss.code = "ENOENT";
						throw miss;
					}
				}
				return readFile(filePath);
			},
			writeFile: (filePath: string, data: Uint8Array, options?: { flag?: string }) =>
				writeFile(filePath, data, options),
			link: async (source: string, destination: string) => {
				if (destination === file && race) {
					race = false;
					await writeFile(file, bytes, { flag: "wx" });
					const conflict: NodeJS.ErrnoException = new Error("exists");
					conflict.code = "EEXIST";
					throw conflict;
				}
				return link(source, destination);
			},
			rename: async () => {
				assert.fail("rename must never be used in no-replace publication path");
			},
			open: async (filePath: string, flags: string) => open(filePath, flags),
			unlink,
			realpath: async (filePath: string) => realpath(filePath),
		};

		const store = createMessageLogStore({
			manifestPath: fixture.manifestPath,
			projectRoot: fixture.root,
			isProjectTrusted: () => true,
			fs,
		});

		await store.append(entry);
		assert.deepEqual(await store.read(entry.id), bytes);
		assert.equal(race, false);
	} finally {
		await fixture.cleanup();
	}
});

test("trusted layout accepts both .pi/bebop and legacy .pi/crew manifests", async () => {
	for (const layout of ["bebop", "crew"] as const) {
		const fixture = await makeFixture(layout);
		try {
			const store = createMessageLogStore({
				manifestPath: fixture.manifestPath,
				projectRoot: fixture.root,
				isProjectTrusted: () => true,
				fs: { sync: async () => undefined },
			});
			await store.append(entry);
		} finally {
			await fixture.cleanup();
		}
	}
});

test("trusted layout and project checks run before filesystem calls", async () => {
	const calls: string[] = [];
	const guardFs = {
		mkdir: async () => {
			calls.push("mkdir");
			return undefined;
		},
		readFile: async () => {
			calls.push("readFile");
			return new Uint8Array();
		},
		writeFile: async () => {
			calls.push("writeFile");
		},
		rename: async () => {
			calls.push("rename");
		},
		open: async () => {
			calls.push("open");
			return { close: async () => undefined };
		},
		unlink: async () => {
			calls.push("unlink");
		},
		realpath: async () => {
			calls.push("realpath");
			return "/tmp/project-root";
		},
	} satisfies Partial<unknown>;

	const store = createMessageLogStore({
		manifestPath: "/tmp/other/.pi/legacy/crew.json",
		projectRoot: "/tmp/project-root",
		isProjectTrusted: () => true,
		fs: guardFs as any,
	});

	await assert.rejects(
		() => store.append(entry),
		(e) => e instanceof MessageLogStoreError && e.code === "untrusted-path",
	);
	assert.equal(calls.length, 0);
});

test("read missing entry does not mutate filesystem", async () => {
	const calls: string[] = [];
	const callsFs = {
		mkdir: async () => {
			calls.push("mkdir");
			throw new Error("no mkdir expected");
		},
		readFile: async () => {
			calls.push("readFile");
			const error: NodeJS.ErrnoException = new Error("ENOENT");
			error.code = "ENOENT";
			throw error;
		},
		writeFile: async () => {
			calls.push("writeFile");
			throw new Error("no write expected");
		},
		link: async () => {
			calls.push("link");
			throw new Error("no link expected");
		},
		rename: async () => {
			calls.push("rename");
			throw new Error("no rename expected");
		},
		open: async () => {
			calls.push("open");
			throw new Error("no open expected");
		},
		unlink: async () => {
			calls.push("unlink");
			throw new Error("no unlink expected");
		},
		realpath: async (filePath: string) => {
			calls.push(`realpath:${filePath}`);
			if (filePath === "/tmp/project-root") return "/tmp/project-root";
			if (filePath.endsWith("/.pi/bebop")) return "/tmp/project-root/.pi/bebop";
			if (filePath.endsWith("/entry-does-not-exist.json")) return "/tmp/entry-does-not-exist.json";
			if (filePath.endsWith("/message-log")) {
				const error: NodeJS.ErrnoException = new Error("ENOENT");
				error.code = "ENOENT";
				throw error;
			}
			if (filePath.endsWith(".pi/bebop/crew.json")) return "/tmp/project-root/.pi/bebop/crew.json";
			return filePath;
		},
	} satisfies Partial<unknown>;

	const store = createMessageLogStore({
		manifestPath: "/tmp/project-root/.pi/bebop/crew.json",
		projectRoot: "/tmp/project-root",
		isProjectTrusted: () => true,
		fs: callsFs as any,
	});

	const missing = await store.read("entry-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
	assert.equal(missing, null);
	assert.equal(calls.includes("mkdir"), false);
});

test("untrusted project fails before filesystem calls", async () => {
	const calls: string[] = [];
	const guardFs = {
		mkdir: async () => {
			calls.push("mkdir");
			return undefined;
		},
		readFile: async () => {
			calls.push("readFile");
			return new Uint8Array();
		},
		writeFile: async () => {
			calls.push("writeFile");
		},
		rename: async () => {
			calls.push("rename");
		},
		open: async () => {
			calls.push("open");
			return { close: async () => undefined };
		},
		unlink: async () => {
			calls.push("unlink");
		},
		realpath: async () => {
			calls.push("realpath");
			return "/tmp/project-root";
		},
	} satisfies Partial<unknown>;

	const fixture = await makeFixture();
	try {
		const store = createMessageLogStore({
			manifestPath: fixture.manifestPath,
			projectRoot: fixture.root,
			isProjectTrusted: () => false,
			fs: guardFs as any,
		});

		await assert.rejects(
			() => store.read(entry.id),
			(error) => {
				assert.ok(error instanceof MessageLogStoreError);
				assert.equal(error.code, "untrusted-project");
				return true;
			},
		);
	} finally {
		await fixture.cleanup();
	}
	assert.equal(calls.length, 0);
});
