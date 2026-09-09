---
id: TASK-0195
title: Define reusable Crew Template and evaluation contract
status: done
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

- [x] Maintained documentation defines each core term above and keeps Crew Template separate from live Crew state and runner configuration.
- [x] Minimal Council specification contains Chair plus exactly two independent Judges and explains why extra roles are optional.
- [x] Chair and Judge responsibilities, inputs, outputs, and terminal deliverable are testable without prescribing transport implementation.
- [x] Council accepts an externally supplied artifact; producing that artifact requires an explicit optional Worker or external producer.
- [x] Model/provider/thinking selection stays outside `crew.json`; documentation never implies distinct members guarantee distinct models.
- [x] Evaluation compares candidate and explicit baseline on same cases, fixtures, compatible model settings, bounds, and repetitions.
- [x] Assertions are declared before outputs are inspected; deterministic checks take precedence over semantic LLM grading.
- [x] Evaluation reports quality, false acceptance/rejection where labels exist, duration, authoritative token usage, message count, errors, and variation across repetitions.
- [x] Failed infrastructure runs remain errors and cannot count as passing negative cases.
- [x] External harness owns process lifecycle, case orchestration, grading, and reports. Bebop remains transport for identity, membership, messaging, and truthful outcomes.
- [x] Contract explicitly identifies disagreement, escalation, retry, and human review as observable outcomes rather than inferred completion.

## Evidence

- Normative contract: [`docs/CREW-TEMPLATE-EVALUATION-CONTRACT.md`](../../docs/CREW-TEMPLATE-EVALUATION-CONTRACT.md).
- Ubiquitous language: [`UL.md`](../../UL.md) defines the Template, Configuration, Case, Run, Deliverable, Baseline, Council, Chair, Judge, Worker, and Evaluation harness terms.
- Acceptance mapping: the contract's [Acceptance evidence map](../../docs/CREW-TEMPLATE-EVALUATION-CONTRACT.md#acceptance-evidence-map) links every criterion to its governing section.
- Scope check: `git diff --name-only` contains only the two documentation files and this plan; no `src/`, schema, skill, template asset, runner, or Bebop transport file changed.
- Focused validation: `git diff --check` passed; Markdown files are non-empty and link targets are repository-relative. No runtime/schema/template/runner implementation was added.
- Independent product/QA review: Mary requested and approved the endpoint distinction between deterministic project-relative configured Member endpoint paths and resolved runtime sockets; all other acceptance gates passed.

## Non-goals

Implementing Template files or runner, selecting models in Crew manifest, adding workflow state to Bebop, treating vote as truth, guaranteeing judge independence, or defining a universal quality rubric.
