---
id: TASK-0039
title: Document lightweight software crew role conventions
status: todo
depends_on: [TASK-0027, TASK-0033, TASK-0038, TASK-0041, TASK-0043, TASK-0045]
priority: normal
tags: [crew, roles, instructions, workflow, docs]
---

# Document lightweight software crew role conventions

## Problem
Bebop can remain small only if lead, product, developer, and quality responsibilities and handoff expectations are taught through role instruction files rather than encoded as task, Git, review, or CI integrations.

## Context

Use TASK-0027 file-backed role instructions as composition mechanism. Bebop transports messages and identities only; instruction files teach software-development behavior using whatever plan, Git, review, and verification tools are available in host project.

Provide example, not mandatory framework. Crew manifest remains free to use other roles. Names identify members; roles describe responsibility, so examples should use repeated `developer` or `quality` roles rather than artificial `dev1`/`qa1` role vocabulary. Exact routing can use member name.

## Proposed role contracts

- **Lead:** clarify outcome, decompose/assign ready work, prevent overlapping ownership, request independent verification, integrate evidence.
- **Product:** receive/triage external intake when configured as crew contact; define problem, acceptance criteria, non-goals, and ubiquitous language; forward actionable work to lead without prescribing implementation prematurely.
- **Developer:** validate assignment, use local project conventions and TDD, produce change plus evidence, report blockers explicitly.
- **Quality:** independently verify acceptance and failure paths; report evidence/findings without silently becoming implementer.

## Acceptance criteria

- [ ] Repository includes concise example instruction files for lead, product, developer, and quality roles.
- [ ] Each template defines mission, expected inputs, expected outputs, escalation/blocker behavior, and definition of done.
- [ ] Templates use `send_follow_up`, `redirect_member`, `interrupt_member`, Inbox, Crew Intake, and Crew Broadcast according to final ubiquitous language.
- [ ] Templates treat message text as opaque workflow convention; they require no Bebop task, Git, review, or CI API.
- [ ] Examples keep plans/Git/tests as external tools and artifacts, not Bebop-owned state.
- [ ] Example manifest demonstrates `instructionsFile` and explains that roles are descriptive, not permissions.
- [ ] Multiple members may share one role; examples route exact ownership by member name when role is ambiguous.
- [ ] README includes one minimal end-to-end flow: external actor messages configured product contact, product shapes/forwards problem, lead coordinates implementation and verification, and internal broadcast shares crew-wide constraints without assigning shared ownership.
- [ ] Documentation teaches escalation ladder: Follow-up normally, Redirect to change next model step, Interrupt only to abort/recover awry active work.
- [ ] Documentation states Interrupt cannot roll back side effects and crew startup/integration decisions remain user/lead responsibilities.
- [ ] Docs/examples are validated through package and manifest tests; final watcher gate passes.

## Out of scope

- Enforcing workflow, task state, Git/worktree operations, QA approval, CI, permissions, or automatic integration.
