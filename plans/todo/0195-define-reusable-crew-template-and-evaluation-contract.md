---
id: TASK-0195
title: Define reusable Crew Template and evaluation contract
status: todo
depends_on: []
priority: high
tags: [product, crew, template, evaluation, council, determinism, ubiquitous-language]
---

# Define reusable Crew Template and evaluation contract

## Problem

Crew manifests and role instructions can be copied, but there is no product contract for a reusable Crew Template or for evaluating whether one improves results. Without that boundary, a template can hide workflow assumptions inside Bebop, confuse model configuration with Crew identity, or claim value from one subjective run.

## Desired outcome

Define a small, reusable Crew Template contract and a comparative evaluation model. Use a three-member Council of Models as first concrete specification without making council behavior part of Bebop runtime.

## Core vocabulary

- **Crew Template**: versioned manifest, shared instructions, Role instructions, and usage guidance. It contains no runtime sockets, Inbox records, sessions, credentials, or implicit model selection.
- **Crew Configuration**: Template plus explicit runner-selected models, thinking levels, case inputs, bounds, and environment.
- **Crew Eval Case**: one fixed prompt, optional disposable fixtures, expected outcome, and predeclared assertions.
- **Crew Eval Run**: one isolated execution of one configuration against one case.
- **Crew Deliverable**: bounded artifact selected by Template contract for grading; for Council, Chair's final verdict.
- **Crew Baseline**: explicit comparison configuration, such as single agent or prior Template snapshot; never an unlabeled absence of Crew.

## Minimal Council contract

The default Council has exactly three members:

1. **Chair** frames request and rubric, requests independent judgments, and reports final verdict.
2. **Judge A** evaluates supplied work independently against same evidence and rubric.
3. **Judge B** evaluates supplied work independently against same evidence and rubric.

Judges return verdict, evidence, uncertainty, and missing information before seeing other judgment. Chair exposes agreement and disagreement; disagreement is decision input, not failure. Majority, Chair confidence, or model identity is never proof. Specialist judges and a separate Worker are optional extensions, not default members.

## Acceptance criteria

- [ ] Maintained documentation defines each core term above and keeps Crew Template separate from live Crew state and runner configuration.
- [ ] Minimal Council specification contains Chair plus exactly two independent Judges and explains why extra roles are optional.
- [ ] Chair and Judge responsibilities, inputs, outputs, and terminal deliverable are testable without prescribing transport implementation.
- [ ] Council accepts an externally supplied artifact; producing that artifact requires an explicit optional Worker or external producer.
- [ ] Model/provider/thinking selection stays outside `crew.json`; documentation never implies distinct members guarantee distinct models.
- [ ] Evaluation compares candidate and explicit baseline on same cases, fixtures, compatible model settings, bounds, and repetitions.
- [ ] Assertions are declared before outputs are inspected; deterministic checks take precedence over semantic LLM grading.
- [ ] Evaluation reports quality, false acceptance/rejection where labels exist, duration, authoritative token usage, message count, errors, and variation across repetitions.
- [ ] Failed infrastructure runs remain errors and cannot count as passing negative cases.
- [ ] External harness owns process lifecycle, case orchestration, grading, and reports. Bebop remains transport for identity, membership, messaging, and truthful outcomes.
- [ ] Contract explicitly identifies disagreement, escalation, retry, and human review as observable outcomes rather than inferred completion.

## Non-goals

Implementing Template files or runner, selecting models in Crew manifest, adding workflow state to Bebop, treating vote as truth, guaranteeing judge independence, or defining a universal quality rubric.
