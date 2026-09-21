---
id: TASK-0216
title: Add a filesystem Crew Intake dropbox
status: in-progress
depends_on: []
priority: high
tags: [crew, intake, inbox, filesystem, follow-up, durability, security, tdd]
---

# Add a filesystem Crew Intake dropbox

## Problem

An external local actor can have useful context for a Crew without being a joined Member, admitted Guest, or Bebop CLI caller. Today there is no deliberately simple boundary where that actor can write an ordinary Markdown or text file and leave it for the Crew's configured Intake contact.

The transport must deliver the external text without deciding whether it is actionable. Classification, triage, delegation, and any response belong to the receiving agent.

## Desired outcome

A person or local automation writes one `.md` or `.txt` file into a private Crew Intake directory. Bebop safely and idempotently persists its text through the existing external Crew Intake path for the exact `intake.contact` in `crew.json`. The contact receives it as an ordinary unverified external-intake Follow-up at the next safe continuation. Active work is never interrupted, and the runtime never classifies or acts on the content.

## Target experience

```text
.pi/bebop/intake/
├── new/
│   └── 2026-09-20-login-problem.md
├── processed/
└── failed/
```

Safe publication while editing:

```bash
$EDITOR .pi/bebop/intake/new/login-problem.draft
mv .pi/bebop/intake/new/login-problem.draft \
  .pi/bebop/intake/new/2026-09-20-login-problem.md
```

## Product decisions

- Any trusted joined Member of the exact Crew may ingest a file. The exact configured `intake.contact` is the only Inbox recipient and delivery contact. There is no lead, role, first-Member, first-online, or all-idle fallback.
- Contact idle is sufficient. The rest of the Crew does not need to be idle.
- Filesystem Intake is a local adapter to the existing external Crew Intake and durable Member Inbox. It does not introduce a second delivery semantic.
- Each ready regular `.md` or `.txt` file is one opaque UTF-8 message. Markdown is not parsed or executed.
- The source is labelled unverified external Intake. A filename is provenance, not an authenticated sender identity.
- Bebop transports the text only. The receiving agent decides whether it is actionable, irrelevant, unsafe, incomplete, or needs clarification.
- Accepted files move to `processed/` only after durable Inbox persistence. Rejected files move to `failed/` with a bounded machine-written reason. Neither state implies that an agent read or acted on the message.
- Files are processed in deterministic filename order. Writers should publish unique, sortable names.
- `.draft`, dotfiles, temporary editor files, directories, and unsupported extensions are ignored rather than delivered.

## Acceptance criteria

### Filesystem boundary

- [x] The canonical dropbox is rooted at the exact trusted Crew project: `.pi/bebop/intake/{new,processed,failed}`.
- [x] Intake directories are private runtime data, excluded from Git, created with restrictive permissions where POSIX permissions exist, and never scaffold message content into a repository.
- [x] The adapter accepts only direct-child regular non-symlink `.md` and `.txt` files beneath `new/`; it rejects traversal, symlinks, devices, nested entries, unsafe names, and group/world-writable unsafe roots.
- [x] Accepted content is valid UTF-8, non-empty after transport-safe validation, and bounded by the existing Message payload limit before any Inbox write.
- [x] Content bytes and line order are preserved within the existing normalized Message payload contract; Bebop does not parse Markdown, extract commands, or infer metadata from prose.
- [x] Direct editing is protected from partial reads by a documented ready-file rule: `.draft`/temporary files are ignored, and a candidate must remain unchanged across a bounded quiescence check before claim. Atomic rename to `.md`/`.txt` is the recommended publication path.

### Contact and delivery

- [x] Every scan loads and validates the trusted manifest, resolves the exact `intake.contact`, and invokes the existing external Intake application operation; it never writes directly to a guessed Member Inbox.
- [x] Missing Intake configuration leaves ready files untouched and reports `external-intake-disabled`; an invalid manifest fails closed.
- [x] A configured contact can be offline when the file is accepted. Durable Inbox persistence succeeds independently, and ordinary Inbox lifecycle delivers it after that contact joins.
- [x] When the contact is online and idle, accepted Intake enters the existing FIFO Follow-up path at the next available continuation.
- [x] When the contact is busy, Intake remains durable and waits. The adapter never steers, redirects, interrupts, aborts, or starts a competing provider turn.
- [x] Other Crew Members becoming idle does not consume or receive the contact's Intake.
- [x] Rendered delivery identifies `external intake`, includes bounded filename provenance, states that the origin is unverified, and preserves the existing age/stale evidence.
- [x] No delivery or acknowledgement claims the contact read, understood, accepted, classified, delegated, or completed the message.

### Watching and recovery

- [x] A filesystem watcher is only a wake hint. Every event triggers a serialized bounded rescan; correctness never depends on event count, order, filename payload, or the watcher observing every change.
- [x] Startup, Membership restore, contact join, and turn-end safe points also rescan so files written while Bebop was offline or watcher events were lost are recovered.
- [x] Repeated/coalesced watcher events cannot enqueue the same file twice or run overlapping claims.
- [x] Runtime pause, leave, shutdown, manifest/contact change, endpoint ownership change, and stale async completion invalidate in-flight offers before they can reach the wrong session.
- [x] Watcher errors are observable and recoverable through later safe-point scans; they never delete or mark a ready file processed.

### Atomicity and idempotency

- [x] Claim, durable Inbox enqueue, receipt recording, and final move have a documented crash-state table.
- [x] A stable idempotency key derived from trusted Crew identity plus canonical filename and content digest prevents duplicate Inbox items after restart or a crash between enqueue and move.
- [x] The Inbox store plus adjacent private commit-intent and receipt ledgers enforce that idempotency key atomically, including the original resolved target across contact changes; an in-memory set is insufficient.
- [x] The source moves to `processed/` only after persistence is proven. A move failure leaves recoverable evidence and cannot cause another enqueue.
- [x] Name collisions in `processed/` or `failed/` fail closed without overwrite or data loss.
- [x] Invalid files move to `failed/` only after a bounded reason is durably recorded; content is never silently discarded.
- [x] Concurrent trusted runtimes for the Crew cannot both claim one file; the shared filesystem lock and atomic claim yield one durable item for the configured contact.

### Limits, privacy, and observability

- [x] Each scan has bounded file count, bytes, duration, and error output. Excess files remain queued in deterministic order for a later scan.
- [x] Processed and failed files are retained for manual review/cleanup; Bebop performs no automatic deletion in this task.
- [x] Default logs/status contain filenames, states, counts, and stable error codes but never message content, credentials, raw dependency errors, session IDs, or socket paths.
- [x] File permissions and Git-ignore behavior are covered on supported platforms; unsupported permission checks are reported honestly rather than claimed.
- [x] Documentation states this is a local filesystem boundary. Remote submission requires an independently trusted mount, sync, or writer and is not provided by Bebop.

### Verification

- [x] Domain/application tests prove exact-contact resolution and that no content classifier, worker selector, or action inference is called.
- [x] Deterministic real-filesystem tests cover draft publication, quiescence mutation, ordering, enumeration bounds, invalid UTF-8, oversize, symlink/traversal boundaries, collisions, permissions, and failed-directory handling. Fake filesystem/clock seams are intentionally out of scope because the security contract is defined by OS filesystem behavior.
- [x] Crash/restart evidence covers enqueue-before-receipt, contact-change-before-restart, and receipt-before-move recovery paths, with the private target intent and durable receipt/idempotency table proving exactly one Inbox item.
- [x] Integration coverage proves offline contact ingestion, online idle delivery, startup scan, contact-generation changes, and lifecycle invalidation; existing Inbox integration tests prove busy/FIFO/leave/shutdown/48-hour stale semantics. Watcher event loss is intentionally non-authoritative: the documented safe-point scan is the product recovery mechanism.
- [x] A real lifecycle test writes a Markdown file, observes one unverified external-intake Follow-up to the configured contact, and proves another Member never receives it.
- [x] README and Crew setup documentation show the directory, safe `.draft` → `.md` publication, contact configuration, local-only boundary, and “delivery is not action” guarantee.
- [x] Focused tests, package verification, security checks, and final quality gate pass.

## Verification scope

The product deliberately keeps the filesystem watcher as a wake hint and the Pi lifecycle as the authoritative scheduler. A fake event source would test an implementation detail rather than the contract; the deterministic evidence therefore uses real OS files, lifecycle calls, and the existing Inbox integration harness. The remaining unmodeled failure window is bounded by the stable Inbox idempotency key, private target commit intent, and receipt ledger.

## Constraints

- Reuse `resolveIntakeContact`, `createExternalIntakePayload`, `submitExternalIntake`, the durable Member Inbox, and its FIFO Follow-up handoff.
- Keep filesystem mechanics in infrastructure, sequencing/idempotency in application code, and actionability decisions outside Bebop.
- Do not add model calls, polling provider turns, content classification, task creation, automatic delegation, or reply routing.

## Non-goals

Remote networking, email/webhook ingestion, authenticated sender identities, bidirectional replies, message classification, task management, Crew-wide broadcast, automatic cleanup, watching arbitrary directories, or deciding whether external content is actionable.
