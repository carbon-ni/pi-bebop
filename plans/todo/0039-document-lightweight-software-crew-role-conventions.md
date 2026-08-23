---
id: TASK-0039
title: Document lightweight software crew role conventions
status: doing
depends_on: [TASK-0027, TASK-0033, TASK-0038, TASK-0041, TASK-0043, TASK-0045, TASK-0047]
priority: normal
tags: [crew, roles, instructions, workflow, docs]
---

# Document lightweight software crew role conventions

## Problem
Bebop can remain small only if lead, product, developer, and quality responsibilities and handoff expectations are taught through role instruction files rather than encoded as task, Git, review, or CI integrations.

## Context

Use TASK-0027 file-backed role instructions as composition mechanism. Bebop transports messages and identities only; instruction files teach software-development behavior using whatever plan, Git, review, and verification tools are available in host project.

`docs/SOFTWARE-CREW-WORKFLOW.md` is the maintained workflow reference: role responsibilities, communication ladder, current capability semantics, end-to-end example, and copyable instruction templates.

Provide example, not mandatory framework. Crew manifest remains free to use other roles. Names identify members; roles describe responsibility, so examples should use repeated `developer` or `quality` roles rather than artificial `dev1`/`qa1` role vocabulary. Exact routing can use member name.

## Example role contracts

- **Lead:** clarify outcome, decompose/assign ready work, prevent overlapping ownership, request independent verification, integrate evidence.
- **Product:** receive/triage external intake when configured as crew contact; define problem, acceptance criteria, non-goals, and ubiquitous language; forward actionable work to lead without prescribing implementation prematurely.
- **Developer:** validate assignment, use local project conventions and TDD, produce change plus evidence, report blockers explicitly.
- **Quality:** independently verify acceptance and failure paths; report evidence/findings without silently becoming implementer.

## Acceptance criteria

- [x] `docs/SOFTWARE-CREW-WORKFLOW.md` remains aligned with final tool names/semantics and no longer marks implemented capabilities planned.
- [x] Repository includes concise example instruction files for lead, product, developer, and quality roles.
- [x] Each template defines mission, expected inputs, expected outputs, escalation/blocker behavior, and definition of done.
- [x] Templates use `send_follow_up`, `redirect_member`, `interrupt_member`, Inbox, Crew Intake, and Crew Broadcast according to final ubiquitous language.
- [x] Templates treat message text as opaque workflow convention; they require no Bebop task, Git, review, or CI API.
- [x] Examples keep plans/Git/tests as external tools and artifacts, not Bebop-owned state.
- [x] Example manifest demonstrates `instructionsFile` and explains that roles are descriptive, not permissions.
- [x] Multiple members may share one role; examples route exact ownership by member name when role is ambiguous.
- [x] README includes one minimal end-to-end flow: external actor messages configured product contact, product shapes/forwards problem, lead coordinates implementation and verification, and internal broadcast shares crew-wide constraints without assigning shared ownership.
- [x] Role templates teach members to publish/clear concise non-sensitive Focus and interpret Activity as mechanical runtime state, not task progress or availability.
- [x] Documentation teaches escalation ladder: Follow-up normally, Redirect to change next model step, Interrupt only to abort/recover awry active work.
- [x] Documentation states Interrupt cannot roll back side effects and crew startup/integration decisions remain user/lead responsibilities.
- [x] Docs/examples are validated through package and manifest tests; final watcher gate passes.

## Completion evidence

- Workflow: `docs/SOFTWARE-CREW-WORKFLOW.md`.
- Example manifest and role instructions: `docs/examples/software-crew/`.
- README links the full workflow and includes the minimal intake-to-integration flow.
- Trusted manifest loader resolves all six example members and four instruction files, including repeated developer/quality roles and exact contact Mary.
- Package dry-run includes all six workflow/example documentation files.

## Out of scope

- Enforcing workflow, task state, Git/worktree operations, QA approval, CI, permissions, or automatic integration.
