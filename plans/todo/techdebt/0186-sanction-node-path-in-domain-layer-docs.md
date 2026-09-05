---
id: TASK-0186
title: Sanction node:path in domain layer docs
status: todo
depends_on: []
priority: low
tags: [techdebt, docs, domain, agents-md]
---

# Sanction node:path in domain layer docs

## Problem

`src/domain/crew-manifest.ts` and `src/domain/crew-init.ts` import `node:path` for socket containment and traversal checks — security-critical domain logic. AGENTS.md states domain has "no runtime APIs" flatly, so reality and the rule disagree. Future agents will either cargo-cult new runtime imports or "fix" working security code.

## Acceptance criteria

- [ ] `src/domain/AGENTS.md` (or the extension root AGENTS.md layer rules) explicitly permits `node:path` in domain and states the boundary: path derivation yes, filesystem IO no.
- [ ] No code changes required; if any domain file imports beyond `node:path` runtime APIs, that is a separate task.

## Notes

Architecture review F4. Injecting a PathOps seam would be over-engineering — document the exception instead. Pure docs commit.
