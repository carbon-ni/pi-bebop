---
id: TASK-0213
title: Reduce docs to active product guides
status: done
depends_on: [TASK-0212]
priority: medium
tags: [docs, cleanup, product, maintenance]
---

# Reduce docs to active product guides

## Problem

`docs/` mixes active user guidance, internal architecture notes, historical task evidence, unimplemented product contracts, and skill-specific template policy. This makes it unclear which documents describe the product people can use today.

## Desired outcome

Top-level narrative docs contain only active product guides linked from README. Historical evidence remains in plans or reports, executable behavior remains in source/tests, and Crew Template policy lives with the Crew Creator skill that consumes it.

## Keep

- `docs/CREW-INIT.md`
- `docs/CREW-SESSION.md`
- `docs/MEMBER-REQUEST-WORKFLOW.md`
- `docs/ROLE-SESSION-RESUME.md`
- `docs/cli-membership-parity.json` as a test-backed fixture, not narrative documentation
- `docs/examples/` and `docs/images/` assets used by active product guidance

## Remove or fold

- Remove `docs/ARCHITECTURE.md`; durable module architecture belongs in AGENTS.md and source boundaries.
- Remove `docs/CLI-CONTRACT.md`; current CLI behavior belongs in generated Commander help, README, and tests.
- Remove unimplemented or unlinked `docs/CREW-INTERACTION.md` and `docs/CREW-PRINCIPAL.md`.
- Fold the live minimum from `docs/CREW-TEMPLATE-EVALUATION-CONTRACT.md` into `skills/crew-creator/references/`, then remove the top-level contract.
- Remove `docs/SOFTWARE-CREW-WORKFLOW.md`; retain the concrete scaffold/examples and make active guides self-contained.
- Remove `docs/TASK-0152-EVIDENCE.md`; task evidence does not belong in product docs.

## Acceptance criteria

- [ ] `docs/` top-level narrative Markdown contains exactly the four active product guides listed under Keep.
- [ ] README links to each retained guide and no removed guide.
- [ ] Retained guides are self-contained and have no links or claims that depend on removed docs.
- [ ] Crew Creator references remain self-contained and do not link to the removed template contract.
- [ ] Active source comments, UL, skills, scripts, and configuration contain no reference to removed docs.
- [ ] Historical plans are not rewritten solely to erase accurate references to artifacts that existed when those plans were completed.
- [ ] No product behavior, command, fixture, schema, example asset, or test-backed contract is removed.
- [ ] Markdown/link checks, focused tests, and final quality gate pass.

## Non-goals

Rewriting all retained guides, deleting historical plans, removing `cli-membership-parity.json`, changing CLI behavior, or changing Crew Template runtime behavior.
