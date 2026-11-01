# Pi Durable member experiment

Opt-in local host/client MVP for one long-lived member. Pi Durable owns the independent conversation; Bebop still owns membership and communication. This does not replace Bebop's existing Pi extension or turn members into task-owned subagents.

## Requirements

- Node.js `>=22.19.0` (tested with `v22.23.3`).
- OpenAI API key in `OPENAI_API_KEY`. The host explicitly configures `openaiProvider()`; it does not inherit Pi CLI provider credentials, settings, or extensions.
- macOS or Linux with Unix domain sockets. The local endpoint is owner-only under `/tmp/pi-bebop-<uid>`; it is not an HTTP listener.
- One host per SQLite file. The host takes an exclusive lock. A dead local PID lock is recovered on next start; malformed/foreign locks are refused.

Install the isolated dependencies without running install scripts:

```sh
npm ci --prefix experimental/pi-durable --ignore-scripts
```

## Run a member

From the repository root:

```sh
export OPENAI_API_KEY=... # keep credentials out of command arguments
npm start --prefix experimental/pi-durable -- start \
  --db "$HOME/.local/share/bebop-durable/designer.sqlite" \
  --member-id designer \
  --role designer \
  --model gpt-4.1-mini \
  --workspace "$HOME/work/project" \
  --instructions-file crew/designer.md

npm start --prefix experimental/pi-durable -- status --db "$HOME/.local/share/bebop-durable/designer.sqlite"
printf '%s' 'Summarize the project notes' | npm start --prefix experimental/pi-durable -- send \
  --db "$HOME/.local/share/bebop-durable/designer.sqlite" --member-id designer
npm start --prefix experimental/pi-durable -- stop --db "$HOME/.local/share/bebop-durable/designer.sqlite"
```

`start` launches a detached local host. Closing a client terminal does not close that host or cancel its accepted submission. If the host process crashes, rerun the same `start` command; it reopens the SQLite database and the same root conversation. Use a unique database per independent member. The DB persists and checks member ID, role, model, canonical workspace, and instructions hash; changing any requires a new DB. The optional role instruction file must be inside the workspace.

The host has one custom tool: bounded UTF-8 file reading (64 KiB maximum) under `--workspace`. It does not write files or run shell commands. For uncertain client retries, pass the same `--request-id <stable-delivery-id>` to each `send` attempt. The host stores a message hash before Durable admission and rejects reusing that key with different content. Admission is not work completion, and this does not claim exactly-once external effects.

## Test

```sh
npm test --prefix experimental/pi-durable
npm audit --prefix experimental/pi-durable --omit=dev
```

## Configured-recipient Inbox-only bridge

The experimental package now has a narrow bridge API in `src/inbox.ts`; this does not imply full Pi/Bebop RPC parity. It serves one member explicitly present in a trusted crew manifest and only transfers that member's existing Inbox items. The caller must supply the project root and Pi-equivalent project-trust decision. After the Durable host is listening, the bridge claims that member's configured socket alias through Bebop's shared endpoint helper. It refuses an endpoint owned by a live Pi member and checks that its alias still targets this host before each admission and removal.

For each item, the bridge renders a deterministic Inbox message and calls an injected immediate `admit(message, requestId, payloadHash)` API. The request ID is stable for the configured recipient, Inbox item ID, and enqueue timestamp. This scopes retries to one queue occurrence, because the root store may reuse an item ID after its queue empties. `payloadHash` is SHA-256 over the full canonical stored payload. The admission adapter must persist that ID/hash pair and reject reuse with another payload hash; the bridge removes the Inbox item only after it returns a submission receipt. A retry after admission but before removal reuses the same key/hash. No cross-store atomic transaction is claimed. The message shows the actual enqueue timestamp and always says the item may be stale; it does not fabricate a delivery age. The rendered message is limited to 8,000 characters by the current Durable admission API; oversized items stay in the Inbox.

The host CLI/lifecycle is not yet wired to poll or trigger this bridge. Treat it as an integration seam, not a user-ready Inbox feature. Full membership RPC, presence, Member Requests, and session restoration remain out of scope.

## Boundaries and remaining gaps

- The local host/client is not yet attached to Bebop's full Unix socket control protocol, trusted crew membership/session restore, presence, or Member Requests. The Inbox bridge is configured-recipient and Inbox-only, not a replacement for those paths. No Inbox item is removed unless the bridge owns the trusted configured endpoint and Durable admission returns a receipt.
- The process restart test proves this host reopens the same conversation after `SIGKILL`; it does not prove uninterrupted OS process supervision. Restart remains an explicit user/OS action.
- Only the read-only file tool opts into replay. No writes, shell, coding tools, provider credentials import, Pi extension compatibility, or full Pi context/skills parity are claimed.
- Package APIs are experimental and pinned to Pi Durable 1.4.0 and its Pi AI/Chord 1.4.0 line, separate from Bebop's Pi 0.84 peers.
- SQLite WAL/NORMAL protects process-crash recovery; it is not a promise against power/host failure. Keep the host local and the DB private.
