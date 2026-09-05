---
id: TASK-0186
title: Sanction node:path in domain layer docs
status: done
depends_on: []
priority: low
tags: [techdebt, docs, domain, agents-md]
---

# Sanction node:path in domain layer docs

## Problem

`src/domain/crew-manifest.ts` imports `node:path` for socket containment and traversal checks — security-critical domain logic. AGENTS.md states domain has "no runtime APIs" flatly, so reality and the rule disagree. Future agents will either cargo-cult new runtime imports or "fix" working security code.

## Acceptance criteria

- [x] `src/domain/AGENTS.md` explicitly permits `node:path` in domain and states the boundary: pure path derivation/validation yes, filesystem IO no.
- [x] No code changes were required. The only other runtime reference found is `process.argv` in `src/domain/cli.ts`, already owned by TASK-0185.

## Evidence

`rg '^import .*node:|\\bprocess\\.|\\brequire\\(' src/domain --glob '!*.test.ts'` returns only sanctioned `node:path` in `crew-manifest.ts` and the TASK-0185 `process.argv` debt.

## Notes

Architecture review F4. Injecting a PathOps seam would be over-engineering — document the exception instead. Pure docs commit.
