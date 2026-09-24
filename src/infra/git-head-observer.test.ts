import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";

import { watchGitHead } from "./git-head-observer.ts";

test("watches HEAD without polling while the Git directory is available", async () => {
	const watcher = new EventEmitter() as FSWatcher;
	let onEvent: ((event: string, filename: string | null) => void) | undefined;
	let changes = 0;
	let gitLookups = 0;
	let closed = false;
	const stop = await watchGitHead(
		() => {
			changes++;
		},
		{
			findGitDir: async () => {
				gitLookups++;
				return "/repo/.git";
			},
			watch: (_path, listener) => {
				onEvent = listener as typeof onEvent;
				watcher.close = () => {
					closed = true;
				};
				return watcher;
			},
			fallback: () => {
				throw new Error("must not poll a watched repository");
			},
		},
	);

	assert.ok(onEvent);
	onEvent("rename", "HEAD.lock");
	onEvent("change", "HEAD");
	onEvent("rename", null);
	assert.equal(changes, 2);
	assert.equal(gitLookups, 1);

	stop();
	onEvent("change", "HEAD");
	assert.equal(changes, 2);
	assert.equal(closed, true);
});

test("falls back when an active Git watcher fails", async () => {
	const watcher = new EventEmitter() as FSWatcher;
	let closed = false;
	let tick: (() => void) | undefined;
	let changes = 0;
	const stop = await watchGitHead(
		() => {
			changes++;
		},
		{
			findGitDir: async () => "/repo/.git",
			watch: () => {
				watcher.close = () => {
					closed = true;
				};
				return watcher;
			},
			fallback: (callback) => {
				tick = callback;
				return () => {
					tick = undefined;
				};
			},
		},
	);

	watcher.emit("error", new Error("directory removed"));
	assert.equal(closed, true);
	tick?.();
	assert.equal(changes, 1);
	stop();
	assert.equal(tick, undefined);
});

test("falls back to slow refresh when the Git directory cannot be watched", async () => {
	let tick: (() => void) | undefined;
	let stopped = false;
	let changes = 0;
	const stop = await watchGitHead(
		() => {
			changes++;
		},
		{
			findGitDir: async () => null,
			watch: () => {
				throw new Error("must not watch outside Git");
			},
			fallback: (callback, delay) => {
				assert.equal(delay, 60_000);
				tick = callback;
				return () => {
					stopped = true;
				};
			},
		},
	);

	tick?.();
	assert.equal(changes, 1);
	stop();
	assert.equal(stopped, true);
});
