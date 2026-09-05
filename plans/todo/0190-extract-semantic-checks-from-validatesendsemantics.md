---
id: TASK-0190
title: Extract semantic checks from validateSendSemantics
status: todo
depends_on: []
priority: normal
tags: [techdebt, cli, complexity, parser]
---

# Extract semantic checks from validateSendSemantics

## Problem

`validateSendSemantics` in `src/cli/parser.ts#L153-L194` scores complexity 21 with 10 ifs and nesting depth 3. Multiple send-semantic rules (mode/wait/reply combinations) are stacked in one function, so each rule's failure message and condition are hard to locate and extend independently.

## Acceptance criteria

- [ ] Each semantic rule is an extracted named check (e.g. mode/wait pairing, reply routing constraints) with its own test.
- [ ] Public behavior identical: same accept/reject outcomes and same error messages.
- [ ] Cyclomatic complexity of every resulting function ≤ 10.
- [ ] `npm test`, `npm run lint` pass.

## Notes

Architecture review F2. Behavior-preserving; add characterization tests for current rejections before extraction.
