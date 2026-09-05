---
id: TASK-0174
title: Add one synchronous Crew ask command
status: todo
depends_on: [TASK-0173]
priority: high
tags: [cli, crew, member, ask, request, response, routing, tdd]
---

# Add one synchronous Crew ask command

## Problem

Asking one question currently requires Request send, opaque ID handling, and a separate wait command. Users need one bounded command addressed to a Crew or exact Member that returns the correlated answer or an actionable terminal outcome.

## User story

As a Crew coordinator, I want one `ask` command so that a normal question does not expose the underlying Member Request lifecycle.

## Target experience

```text
pi-bebop ask funzzy "What are you working on?"
pi-bebop ask funzzy/Mony "What is blocked?"
```

## Acceptance criteria

- [ ] `pi-bebop ask <crew-selector[/member]> <question>` resolves the product target from a current joined Member or approved Guest route, submits exactly one Member request, waits for exactly its correlated Response, and returns in one CLI invocation. Standalone Crew Locator access never grants Ask authority.
- [ ] Crew-only targets use the explicit Crew contact; missing contact fails with a corrected `crew/member` example and never guesses a recipient.
- [ ] The normal result exposes Crew, Member, answer, terminal outcome, and freshness needed for the next decision while hiding source session, sockets, and Request ID.
- [ ] Accepted is never presented as answered; offline, response-after-idle timeout, total timeout, cancellation, malformed Response, and route loss are distinct terminal results.
- [ ] Candidate probes are fixed at 300 ms each, discovery is bounded at 2 s, delivery RPC at 5 s, post-idle Response grace defaults to 30 s (1–600 s), and total Ask wait defaults to 120 s (2–1,800 s and greater than grace). Help uses one documented duration grammar and never permits an unbounded wait.
- [ ] Questions and instructions preserve exact UTF-8 bytes/order within existing domain limits and are never echoed in raw dependency errors or diagnostic logs.
- [ ] Retrying after an uncertain transport result does not silently create duplicate correlated requests; the command reports whether safe retry is known.
- [ ] Agent-default TOON plus explicit text/JSON are deterministic; human text answers the question directly and includes an actionable next step only on failure.
- [ ] Existing low-level Member Request CLI remains available for advanced asynchronous workflows but is absent from the simple happy path.
- [ ] Tests cover Crew contact, exact Member, duplicate names, self-target, direct/queued delivery, each terminal outcome, timeout boundaries, SIGINT, private-data leakage, and packed CLI behavior.

## Non-goals

Broadcast questions, multiple Responses, task assignment, progress inference, or treating answers as authenticated facts/completion proof.
