#!/usr/bin/env bash

set -eu

QUIET_PERIOD_SECONDS=120
STATE_DIR=".tmp/funzzy-failure-notification"
STATE_FILE="$STATE_DIR/state"
LOCK_DIR="$STATE_DIR/worker.lock"

write_state() {
	local state="$1"
	local temporary="$STATE_FILE.$$"
	printf '%s\n' "$state" >"$temporary"
	mv -f "$temporary" "$STATE_FILE"
}

worker() {
	trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

	while true; do
		local state
		state="$(cat "$STATE_FILE" 2>/dev/null || true)"
		if [[ "$state" != failure:* ]]; then
			exit 0
		fi

		local failed_at="${state#failure:}"
		local now="$(date +%s)"
		local remaining=$((QUIET_PERIOD_SECONDS - now + failed_at))
		if ((remaining > 0)); then
			sleep "$remaining"
			continue
		fi

		# Another failure may have arrived while the worker slept.
		if [[ "$(cat "$STATE_FILE" 2>/dev/null || true)" != "$state" ]]; then
			continue
		fi

		pi-bebop crew broadcast --message "Funzzy generation failed; inspect the watcher output." || true
		exit 0
	done
}

if [[ "${1:-failure}" == "--worker" ]]; then
	worker
	exit 0
fi

mkdir -p "$STATE_DIR"
write_state "failure:$(date +%s)"
if mkdir "$LOCK_DIR" 2>/dev/null; then
	nohup "$0" --worker >/dev/null 2>&1 </dev/null &
fi
