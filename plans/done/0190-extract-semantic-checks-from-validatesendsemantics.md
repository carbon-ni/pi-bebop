---
id: TASK-0190
title: Extract semantic checks from validateSendSemantics
status: done
depends_on: []
priority: normal
tags: [techdebt, cli, complexity, parser]
---

# Extract semantic checks from validateSendSemantics

## Problem

`validateSendSemantics` in `src/cli/parser.ts#L153-L194` scores complexity 21 with 10 ifs and nesting depth 3. Multiple send-semantic rules (mode/wait/reply combinations) are stacked in one function, so each rule's failure message and condition are hard to locate and extend independently.

## Acceptance criteria

- [x] Each send semantic rule is an extracted named check (`validateTargetSelection`, `validateCrewDeliveryFlags`, `validateMessageSource`, and `validateDeliveryOptions`) with characterization coverage in the parser suite.
- [x] Public behavior is identical: the focused parser/CLI suite preserves all accept/reject outcomes and exact error messages.
- [x] Cyclomatic complexity of every resulting semantic-check function is ≤ 10.
- [x] Focused parser tests, `npm run lint`, and watcher verification pass.

## Notes

Architecture review F2. Behavior-preserving; add characterization tests for current rejections before extraction.

Completed at `3b3bf83`. Characterization suite passed before extraction; focused parser/CLI tests pass 65/65 after extraction, `npm run lint` passes, and complexity analysis reports `validateSendSemantics` 6, `validateTargetSelection` 2, `validateCrewDeliveryFlags` 4, `validateMessageSource` 7, and `validateDeliveryOptions` 6.
