---
id: TASK-0233
title: Add correlated Ask to the Bebop SDK
status: todo
depends_on: [TASK-0221]
priority: high
tags: [sdk, member-request, ask, correlation]
---

# Add correlated Ask to the Bebop SDK

## Problem

SDK consumers can send accepted Follow-ups and Inbox messages, but cannot ask one exact Member a question and await that Request's correlated Response without handling Request IDs, RPC lifecycle, sockets, or transport errors themselves. That makes duplicate sends and cross-request response association unsafe.

## Desired outcome

A selected trusted joined `BebopSource` exposes one typed `ask` operation. It sends exactly one Member Request, waits only for that Request's Response, preserves UTF-8 content and instruction order, and returns explicit accepted/answered semantics with safe retry truth.

## Public shape

```ts
const result = await source.ask("developer", {
  question: "Review the change and report blockers",
  instructions: ["Be concise"],
}, { responseGraceSeconds: 30, totalWaitSeconds: 120, signal });
```

The operation hides Request IDs, sessions, sockets, RPC methods, and transport details.

## Acceptance criteria

- [ ] Add typed `ask` API and result/error contracts to the SDK without exposing transport or Request IDs.
- [ ] Enforce default 30-second response grace and 120-second total wait; enforce grace 1..600 seconds and total 2..1800 seconds, strictly greater than grace.
- [ ] Use one end-to-end budget, AbortSignal support, and fixed delivery acceptance bound; never retry uncertain delivery.
- [ ] Await only the exact correlated Request Response, including repeated waits after nonterminal pending-after-idle outcomes.
- [ ] Distinguish answered, accepted-but-offline, and accepted-but-timeout outcomes and expose safe retry truth.
- [ ] Preserve stable invalid-input/programming errors, UTF-8/instruction order, aggregate payload limits, and existing SDK error mappings.
- [ ] Cover happy/unhappy paths, concurrent correlation isolation, malformed responses, offline member, route loss, timeout, cancellation, and package declarations/consumer verification.
- [ ] Document API and semantics; move this plan to `plans/done` after verification.
- [ ] Open exactly one PR from the isolated branch and pass exact-head watcher/GitHub gates with Kelly QA.

## Non-goals

Crew-name routing, CLI `ask`, broadcast, response APIs, extra messaging parity, automatic retries, raw RPC, socket/session/Request ID exposure, or semantic answer correctness.
