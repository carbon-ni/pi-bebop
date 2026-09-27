---
id: TASK-0243
title: Share CLI and SDK Ask orchestration
status: todo
depends_on: [TASK-0242]
priority: high
tags: [sdk, cli, ask, tdd]
---

# Share Ask orchestration

## Problem

CLI Ask and SDK Ask each orchestrate request/wait. CLI ends on post-idle pending while SDK re-waits; blindly replacing either changes behavior.

## Desired outcome

One tested Ask orchestration uses Request primitives, with explicit policies for intentional interface differences.

## Acceptance criteria

- [ ] Characterize CLI and SDK deadline, pending, cancellation and error behavior before changing implementation.
- [ ] Preserve existing contracts through explicit narrow policy inputs; any proposed semantic change needs a documented decision before implementation.
- [ ] CLI invokes shared SDK Ask orchestration instead of direct start/wait RPC; Crew contact resolution remains outside correlation mechanics.
- [ ] Preserve explicit source identity, approved Guest route scope and no authority from cwd/Locator alone.
- [ ] One total budget, bounded delivery, exact Response identity, no retries and honest accepted/answered/safeRetry results are covered.
- [ ] Real deadline-ordering tests cover accepted timeout with possibly live remote Request, caller abort, route loss and concurrency.
- [ ] No Request IDs/topology leak in high-level output; text/TOON/JSON and packed SDK/CLI gates pass.

## Non-goals

New global routing authority or forcing Pi agents to replace asynchronous Request tools with blocking Ask. Follow `docs/SDK-REFACTOR.md`.
