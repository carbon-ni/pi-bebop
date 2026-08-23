---
id: TASK-0063
title: Split CLI execution into command adapters
status: todo
depends_on: [TASK-0058]
priority: high
tags: [cli, application, adapters, separation-of-concerns, tdd]
---

# Split CLI execution into command adapters

## Problem
After parsing is modernized, `main.ts` still mixes home IO, stdin, signals, application wiring, errors, rendering, and exit assignment, making each new CLI capability risky.

## Context

Make `main.ts` a composition root. Extract one handler per current command and
shared message-input/error/output adapters. This task changes structure, not
public behavior.

```text
src/cli/run.ts
src/cli/commands/home-handler.ts
src/cli/commands/send-handler.ts
src/cli/commands/direct-send-adapter.ts
src/cli/commands/crew-intake-adapter.ts
src/cli/commands/crew-init-handler.ts
src/cli/message-input.ts
src/cli/errors.ts
src/cli/main.ts
```

## Acceptance criteria

- [ ] Tests first cover each handler's happy, no-op/empty, usage, operational failure, cancellation, and cleanup paths.
- [ ] Root dispatch is exhaustive over typed intents and contains no command business logic.
- [ ] Send routing keeps direct RPC and durable Intake dependencies separate after target validation.
- [ ] Stdin is injected, bounded, cancellable, and read only after full validation; empty stdin remains usage error.
- [ ] SIGINT listeners are installed once and removed on every terminal path.
- [ ] Domain/application modules remain independent of CLI library and renderer.
- [ ] One renderer boundary writes structured output once; errors keep stable codes/exits and never leak stacks.
- [ ] `main.ts` owns only real process streams, environment, signals, adapters, and exit assignment.
- [ ] Existing home, send, and Crew init integration/packaged tests remain compatible.
- [ ] `runCli` complexity drops materially from 19 and the CLI module graph has no cycles.
