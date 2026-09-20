---
id: TASK-0214
title: Deliver online Inbox items as Follow-ups and warn when stale
status: done
depends_on: []
priority: high
tags: [crew, inbox, follow-up, lifecycle, freshness, tdd]
---

# Deliver online Inbox items as Follow-ups and warn when stale

## Problem

Bebop already persists Inbox items and offers them through Pi's Follow-up path, but the enqueue-time wake hint is itself sent as a model-visible Follow-up before the real Inbox item. An online recipient can therefore spend a continuation seeing “check your inbox” instead of receiving the persisted content directly.

Old Inbox items already show a factual age-at-delivery header, but there is no explicit stale boundary. A message delivered days later can look actionable without a clear warning to revalidate it.

## Desired outcome

For an online joined recipient, persistence wakes the Inbox bridge without injecting a placeholder message. The oldest eligible Inbox item enters the next available Pi model continuation as one ordinary non-interrupting Follow-up.

Inbox items aged 48 hours or more are still delivered, with an explicit stale warning and exact age. Bebop never silently discards a message because of age.

## Product decisions

- Persist first. Online acceleration remains best-effort and never weakens durable delivery.
- A wake signal is transport/control activity only. It is not user content and must not appear in model context, TUI conversation history, or consume a provider turn.
- “Next continuation” means the next FIFO position Pi can accept after the active turn and Follow-ups already accepted. Inbox never steers, redirects, aborts, or jumps the queue.
- The bridge offers the oldest pending item. A newly sent item does not bypass older Inbox items.
- An item is stale when `deliveredAt - enqueuedAt >= 48 hours`, measured from persisted recipient-owned timestamps.
- Stale is evidence, not invalidation. Deliver the unchanged content and instructions, add a warning to verify relevance, and retain normal evidence-gated removal.
- No automatic expiry or deletion is introduced.

## Acceptance criteria

### Online handoff

- [ ] Sending to an online, joined recipient persists exactly one Inbox item before any wake attempt.
- [ ] With offering active and no older item, the actual persisted content is accepted into the recipient's next available model continuation as `followUp`.
- [ ] The enqueue-time wake produces no separate Pi message, conversation entry, model context, provider turn, notification content, or assistant continuation.
- [ ] If the recipient is busy, delivery waits non-interruptingly behind the current turn and previously accepted Follow-ups.
- [ ] If the recipient is idle, the actual Inbox item can trigger the next continuation directly without a placeholder round.
- [ ] Older pending Inbox items remain FIFO-ahead of the newly persisted item.
- [ ] Repeated or concurrent wakes remain idempotent: at most one oldest item is outstanding and no duplicate content is handed to Pi.
- [ ] Paused offering, stale ownership, leave, role switch, shutdown, and untrusted state do not hand content to the wrong session.
- [ ] Offline, failed, timed-out, or malformed wake attempts do not roll back persistence; join, restore, resume, or `turn_end` can deliver later.
- [ ] Sender output continues to claim only `persisted`; a successful wake acknowledgement does not claim read, delivered, started, answered, or completed.

### Stale warning

- [ ] Items younger than 48 hours keep the normal exact age-at-delivery header without a stale warning.
- [ ] At exactly 48 hours and later, model context and human-visible rendering clearly label the item stale and say to verify relevance before acting.
- [ ] The stale calculation uses immutable `enqueuedAt` and recipient `deliveredAt`, not render time, sender clock, session start, or current wall-clock reads.
- [ ] Retry, restart, and offline recovery preserve the original enqueue time and therefore the same deterministic freshness classification.
- [ ] The warning does not rewrite, summarize, suppress, prioritize, or grant authority to message content or instructions.
- [ ] Stale items are not automatically removed. They follow the existing evidence-gated removal or explicit cancellation path.
- [ ] Invalid or reversed timestamps fail safely without inventing an age or stale classification.

### Verification and guidance

- [ ] Deterministic tests cover online idle and busy recipients, no placeholder turn, FIFO with live Follow-ups and older Inbox items, duplicate wakes, pause/leave/switch, offline recovery, and wake failure.
- [ ] Boundary tests cover 47h59m59s, exactly 48h, over 48h, restart/retry, and invalid/reversed timestamps.
- [ ] End-to-end evidence proves one persisted item becomes one model-visible Inbox Follow-up, not a hint plus a second message.
- [ ] README and tool/CLI wording explain online next-continuation behavior, offline durability, FIFO caveat, and the 48-hour stale warning without promising completion.
- [ ] Focused tests, package verification, and final quality gate pass.

## Constraints

- Keep durable storage, offering, and Pi delivery as separate concerns.
- Preserve the existing stable item ID and evidence reconciliation contract.
- Use typed protocol intent for internal wake behavior; do not classify or suppress ordinary member content by matching prose.
- Keep trust and current Membership ownership checks at the recipient boundary.

## Non-goals

Configurable retention, automatic expiry, deleting stale items, priority queues, task/workflow interpretation, completion tracking, bypassing older messages, redirecting active work, or guaranteeing exactly-once model execution.
