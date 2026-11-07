# Pi Durable member experiment

Opt-in local host/client MVP for one long-lived member. Pi Durable owns the independent conversation; Bebop still owns membership and communication. This does not replace Bebop's existing Pi extension or turn members into task-owned subagents.

## Requirements

- Node.js `>=22.19.0` (tested with `v22.23.3`).
- A provider login saved by Pi in the normal agent directory. The legacy `OPENAI_API_KEY` environment path also remains supported. The experiment uses Pi's public `ModelRuntime` API; it does not parse or print auth tokens.
- macOS or Linux with Unix domain sockets. The local endpoint is owner-only under `/tmp/pi-bebop-<uid>`; it is not an HTTP listener.
- One host per SQLite file. The host takes an exclusive lock. A dead local PID lock is recovered on next start; malformed/foreign locks are refused.

From the repository root, install both dependency trees without install scripts. The Inbox adapter reuses Bebop's existing root modules; the new runtime dependencies stay isolated:

```sh
npm ci --ignore-scripts
npm ci --prefix experimental/pi-durable --ignore-scripts
```

## Run a member

From the repository root:

```sh
# Sign in once through Pi, for example: pi then /login and choose a provider.
# List models for saved Pi logins without opening a DB or sending a model request.
npm start --prefix experimental/pi-durable -- models
npm start --prefix experimental/pi-durable -- models --provider openai-codex
npm start --prefix experimental/pi-durable -- start \
  --db "$HOME/.local/share/bebop-durable/designer.sqlite" \
  --member-id designer \
  --provider openai-codex \
  --role designer \
  --model gpt-5.6-luna \
  --workspace "$HOME/work/project" \
  --instructions-file crew/designer.md

# Alternative: start a separate database bound to the trusted configured Inbox.
# First STOP the ordinary Pi session for this exact recipient (idle is insufficient).
# The manifest must contain the exact name "designer". Review/trust the project in Pi first.
BEBOP_PROJECT_TRUSTED=1 npm start --prefix experimental/pi-durable -- start \
  --db "$HOME/.local/share/bebop-durable/designer-inbox.sqlite" \
  --member-id designer --provider openai-codex --role designer --model gpt-5.6-luna \
  --workspace "$HOME/work/project" \
  --trusted-project-root "$HOME/work/project" \
  --manifest "$HOME/work/project/.pi/bebop/crew.json"

npm start --prefix experimental/pi-durable -- status --db "$HOME/.local/share/bebop-durable/designer.sqlite" # includes host PID and effective configuration
# For the alternative Inbox-bound host, explicitly deliver newly queued items:
npm start --prefix experimental/pi-durable -- drain-inbox --db "$HOME/.local/share/bebop-durable/designer-inbox.sqlite"
printf '%s' 'Summarize the project notes' | npm start --prefix experimental/pi-durable -- send \
  --db "$HOME/.local/share/bebop-durable/designer.sqlite" --member-id designer
npm start --prefix experimental/pi-durable -- stop --db "$HOME/.local/share/bebop-durable/designer.sqlite"
```

The runtime uses Pi's public `ModelRuntime` and reads saved credentials and model configuration from the normal Pi agent directory (including `PI_CODING_AGENT_DIR`). Run Pi's `/login` once, then use `models` to list catalog models for saved login metadata. Listing reads only credential metadata: it does not expose token values, open the Durable database, refresh OAuth, or send a model request. A listed login proves a saved credential exists, not that it is still valid or entitled to every catalog model; validity is discovered only when a real submission runs. Select `--provider` and `--model` from that list. The existing `OPENAI_API_KEY` environment route remains supported for explicit OpenAI provider/model selection.

`start` launches a detached local host. If startup fails, rerun the same member and optional Inbox arguments with `serve` instead of `start`; foreground mode prints the underlying startup error. Closing a client terminal does not close that host or cancel its accepted submission. If the host process crashes, rerun the same `start` command; it reopens the SQLite database and the same root conversation. Use a unique database per independent member. The DB persists and checks member ID, provider, role, model, canonical workspace, instructions hash, and optional trusted project/manifest binding; changing any requires a new DB. The two startup examples are alternatives with different databases. Use the matching database in all later commands, and stop both hosts if you started both. The optional role instruction file must be inside the workspace.

The host has one custom tool: bounded UTF-8 file reading (64 KiB maximum) under `--workspace`. It does not write files or run shell commands. `stop` closes pending client sockets and gives Durable five seconds to close; if active work ignores cancellation, the host exits so its lock can be recovered on the next start. The client allows 120 seconds of inactivity for a model submission (control requests use one second); a timeout disconnects only the client, not accepted host work. `send` prints its delivery request ID before dispatch. For uncertain retries, pass that same `--request-id <stable-delivery-id>` to each `send` attempt. The host stores a message hash before Durable admission and rejects reusing that key with different content. Admission is not work completion, and this does not claim exactly-once external effects.

## Test

```sh
npm test --prefix experimental/pi-durable
npm audit --prefix experimental/pi-durable --omit=dev
```

## Configured-recipient Inbox-only bridge

The experimental package now has a narrow bridge API in `src/inbox.ts`; this does not imply full Pi/Bebop RPC parity. It serves one member explicitly present in a trusted crew manifest and only transfers that member's existing Inbox items. The caller must supply the project root and Pi-equivalent project-trust decision. Stop the ordinary Pi session for this recipient before enabling this mode; waiting for idle is not enough. After the Durable host is listening, the bridge claims that member's configured socket alias through Bebop's shared endpoint helper. It refuses an endpoint owned by a live Pi member and checks that its alias still targets this host before each admission and removal. This is not a shared consumer lease: stale in-process Pi membership or external alias mutation can violate the single-owner precondition. Do not run both runtimes for the same recipient.

For each item, the bridge renders a deterministic Inbox message and calls an injected immediate `admit(message, requestId, payloadHash)` API. The request ID is stable for the configured recipient, Inbox item ID, and enqueue timestamp. This scopes retries to one queue occurrence, because the root store may reuse an item ID after its queue empties. `payloadHash` is SHA-256 over the full canonical stored payload and is checked separately from the request ID. The source store has no unique occurrence token finer than its enqueue timestamp; two otherwise identical records re-enqueued with the same timestamp cannot be distinguished, so exactly-once delivery is not claimed for that edge case. The admission adapter must persist that ID/hash pair and reject reuse with another payload hash; the bridge removes the Inbox item only after it returns a submission receipt. A retry after admission but before removal reuses the same key/hash. No cross-store atomic transaction is claimed. The message shows the actual enqueue timestamp and always says the item may be stale; it does not fabricate a delivery age. The rendered message is limited to 8,000 characters by the current Durable admission API; oversized items stay in the Inbox.

When both `--trusted-project-root` and `--manifest` are supplied, `BEBOP_PROJECT_TRUSTED=1` is also required as an explicit caller attestation. The host listens on its private local socket, opens the trusted recipient Inbox bridge and claims the configured socket alias before calling Durable `resume()`. It drains up to 100 queued items per startup/settled-submission pass to keep host startup and replies bounded; use `drain-inbox` again for larger backlogs. Newly queued items while the host is idle require `drain-inbox`: this MVP does not implement the ordinary Bebop `inbox_hint` RPC or poll for new messages. The automatic passes are only startup and completion of local client submissions. It releases the endpoint during shutdown. This trust attestation is not Pi's own trust store: only set it after checking project trust through Pi. Without those three opt-ins, Inbox is not opened and its endpoint is not claimed. Full Bebop membership RPC, presence, Member Requests, and session restoration remain out of scope.

## Boundaries and remaining gaps

- Tests use the real Durable runtime, SQLite, and a deterministic faux provider. Pi's saved login is reused through the public ModelRuntime; no credentials are copied or printed. No paid-provider response has been verified, and the selected provider account must have access to the requested model.
- Startup failures from detached `start` can be diagnosed by rerunning the same flags with `serve` instead; this runs the host in the foreground. Stop any already-running host first.
- Workspace reads can disclose allowed files to the selected provider. Keep secrets and private credentials outside the workspace. Compaction preserves historical records; it is not deletion. Retrying an accepted submission does not rerun a previously completed answer.

- The local host/client is not yet attached to Bebop's full Unix socket control protocol, trusted crew membership/session restore, presence, or Member Requests. The Inbox bridge is configured-recipient and Inbox-only, not a replacement for those paths. No Inbox item is removed unless the bridge owns the trusted configured endpoint and Durable admission returns a receipt.
- The process restart test proves this host reopens the same conversation after `SIGKILL`; it does not prove uninterrupted OS process supervision. Restart remains an explicit user/OS action.
- Only the read-only file tool opts into replay. No writes, shell, coding tools, provider credentials import, Pi extension compatibility, or full Pi context/skills parity are claimed.
- Package APIs are experimental and pinned to Pi Durable, Pi AI, Chord, and Pi coding-agent 1.4.0, separate from Bebop's Pi 0.84 peers. The coding-agent dependency is isolated to this experimental package; root dependencies are unchanged.
- SQLite WAL/NORMAL protects process-crash recovery; it is not a promise against power/host failure. Keep the host local and the DB private.
