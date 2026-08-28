---
id: TASK-0131
title: Expose pull-based Crew Message Log review
status: todo
depends_on: [TASK-0130]
priority: high
tags: [crew, messaging, evidence, tools, command, retrospective, privacy, tdd]
---

# Expose pull-based Crew Message Log review

## Problem

The Crew needs a bounded, Membership-scoped way to inspect and export messaging evidence for retrospectives without automatically injecting transcripts, inferring preferences, or creating read state.

## Desired surfaces

- `read_crew_message_log` for agent-driven, explicit pull review;
- `/crew message-log` for bounded TUI inspection without a model turn;
- one injected read-only source for Crew Retrospective evidence assembly.

No public append surface is added: Log Entries come only from canonical runtime capture.

## Acceptance criteria

- [ ] One shared application query authenticates Current Membership at execution and store-read boundaries. Any newly joined/rejoined Current Member has identical access to all retained entries in the active layout regardless of capture-time roster/Role; leave or Membership loss during a read rejects, Role switch changes no visibility, and inactive-layout history is never merged implicitly.
- [ ] Closed schemas expose a fixed UTC half-open interval plus bounded filters for exact Member name, surface, outcome, direction, and stable cursor. Unknown fields, Roles-as-targets, invalid times, excessive filters, and unsafe cursors reject before store IO.
- [ ] Results use deterministic chronological/lifecycle ordering, stable pagination, exact retained/truncated/gap counts, per-endpoint epoch coverage, and bounded entries. Repeated identical reads return byte-equivalent data while retained storage is unchanged.
- [ ] Default output is metadata-first and token-bounded; visible payload content requires an explicit include-content option and remains redacted/bounded. Neither mode reveals routes, socket paths, stacks, secrets, credentials, or hidden reasoning.
- [ ] `read_crew_message_log` content/details are lossless for the selected bounded representation and never claim delivery, acknowledgement, response, completion, preference, or correctness beyond stored outcomes.
- [ ] `/crew message-log` is TUI-only: it starts no provider/model turn, sends no message, changes no queue/read state, and gives actionable pagination/filter guidance.
- [ ] Reads are pull-only. Join/startup/system prompt/Member context/notification surfaces never preload entries, counts, summaries, or cursors and never announce new Log Entries.
- [ ] The Retrospective adapter fixes its roster/interval, requests one durable coverage checkpoint from each reachable frozen-roster endpoint, maps canonical entries to TASK-0112/TASK-0111 evidence with stable references/fingerprints, and reports retention, corruption, missing endpoint coverage, volatile-loss/unclean epochs, and unavailable ranges as gaps rather than absence of messaging.
- [ ] Source/target/Origin wording preserves Membership versus claimed attribution. Filters and output never rank Members or infer availability, productivity, intent, sentiment, preference, agreement, or completion.
- [ ] README, architecture, UL, tool guidance, command help, package surface inventory, and actionable-error inventory are updated consistently.
- [ ] Tests cover all filters, pagination boundaries, content opt-in, access loss, no-auto-load behavior, zero-side-effect command execution, large/Unicode/redacted records, retained gaps, both layouts, and real Retrospective collection.
- [ ] Focused coverage/risk analysis, package verification, architecture gate, and watcher final gate pass.

## Non-goals

Append/edit/delete commands, read receipts, notifications, live tailing, dashboards, remote export, automatic synthesis, or product/Agreement activation.
