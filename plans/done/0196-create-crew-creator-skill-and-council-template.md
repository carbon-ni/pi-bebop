---
id: TASK-0196
title: Create crew-creator skill and Council template
status: done
depends_on: [TASK-0195]
priority: high
tags: [skill, crew, template, council, instructions, documentation, tdd]
---

# Create crew-creator skill and Council template

## Problem

Creating a fit-for-purpose Crew currently requires hand-authoring a manifest and instruction files without guidance on minimum roles, responsibility overlap, evaluation cases, or safe reuse. Users need one skill that can create, review, and revise Crew Templates while preserving Bebop boundaries.

## Desired outcome

Add `skills/crew-creator/` with a focused authoring workflow and a copyable three-member Council of Models Template. The skill leads from problem and desired outcome to the smallest useful Crew, then prepares realistic eval cases before adding complexity.

## Proposed skill shape

```text
skills/crew-creator/
├── SKILL.md
├── references/
│   ├── crew-template-contract.md
│   └── council-of-models.md
├── assets/templates/council-of-models/
│   ├── crew.json
│   └── instructions/
│       ├── common.md
│       ├── chair.md
│       └── judge.md
└── evals/
    └── evals.json
```

## Acceptance criteria

- [x] Skill description triggers for creating, reviewing, modifying, or evaluating reusable Bebop Crew Templates and avoids generic team-design requests unrelated to Bebop.
- [x] Workflow starts with problem, desired Crew deliverable, baseline, and failure cost before choosing Roles or member count.
- [x] Workflow prefers smallest useful Crew and requires justification for every member, shared instruction, Role instruction, and deterministic helper.
- [x] Generated Templates use current trusted Bebop manifest schema, project-relative instruction paths, exact names, stable descriptions, and no live/private runtime artifacts.
- [x] Skill distinguishes shared constraints from Role responsibilities and rejects duplicated or contradictory instruction ownership.
- [x] Council Template contains one Chair and two Judges; both Judges may reuse one Role instruction while retaining exact member identities.
- [x] Shared instructions require same bounded request, rubric, and evidence; Judges must work independently before Chair synthesis.
- [x] Judge output includes verdict, cited evidence, uncertainty, and missing information. Chair output includes final verdict plus agreement/disagreement and escalation reason.
- [x] Template makes deterministic validation precede model judgment and prevents unsupported claims that acceptance means correct or complete.
- [x] Model choice remains runner/startup configuration and is not encoded as Crew identity or permission.
- [x] Skill proposes 2–3 realistic eval cases with predeclared observable expectations before revising a Template.
- [x] Skill self-evals cover creating minimal Council, reviewing an overstaffed Crew, and refusing to embed model/workflow semantics in Bebop runtime.
- [x] Validation confirms `SKILL.md`, manifest, referenced instruction files, deterministic LF content, and absence of credentials/runtime state.

## Evidence

- `skills/crew-creator/SKILL.md` defines focused triggering, the authoring workflow, review gates, and Bebop boundary.
- `assets/templates/council-of-models/` contains a version-2 manifest, shared constraints, Chair instruction, and reused Judge instruction for the exact three members.
- `evals/evals.json` defines predeclared evaluations for a minimal Council, overstaffed-Crew review, and rejecting Bebop workflow/model semantics.
- Focused validation passed: `quick_validate.py`, targeted Prettier, `git diff --check`, JSON parsing, unique member/path checks, and every manifest instruction-file reference.
- Scope contains only the Crew Creator skill assets and this plan; no `src/` or Bebop transport changes.


## Non-goals

Running Crew evals, starting Pi sessions, changing `pi-bebop crew init`, installing generated Templates automatically, choosing paid models, or defining specialist Judge packs before evidence shows need.
