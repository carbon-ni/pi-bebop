---
name: crew-creator
description: Create, review, revise, or evaluate reusable Pi Bebop Crew Templates. Use for Council-of-Models templates, crew role/instruction design, and comparative crew-eval planning. Do not use for generic team design unrelated to Bebop, operating a live Crew, or adding workflow logic to Bebop.
---

# Crew Creator

Create the smallest reusable Crew Template that can produce a stated Crew
Deliverable. Treat Bebop as transport only: identity, membership, message
transport, and truthful transport outcomes. An external harness owns process
lifecycle, orchestration, grading, and reports.

Read [the contract](references/crew-template-contract.md) before creating or
reviewing a template. Read [the Council reference](references/council-of-models.md)
when a Council is requested. Read [the runtime Judge reference](references/runtime-judge-checkpoint.md)
when a bounded intermediate decision must control the next workflow stage.

## Workflow

1. State the problem, desired Crew Deliverable, explicit Baseline, failure cost,
   allowed effects, and what a bad result would cause.
2. Define 2–3 realistic Eval Cases before changing roles. Each case has a fixed
   prompt, fixtures if needed, predeclared observable expectations, bounds, and
   an explicit baseline.
3. Choose the smallest Crew. Justify every member, shared instruction, Role
   instruction, and deterministic helper by the distinct decision or output it
   owns. Remove roles with duplicated responsibility.
4. Define each Role's inputs, bounded output, terminal condition, and escalation
   path. Shared instructions state common request, rubric, evidence, and limits;
   Role instructions state only unique responsibility. Resolve contradictory or
   duplicate ownership before generating files.
5. Generate a versioned `crew.json`, `instructions/common.md`, and one Role
   instruction per distinct Role. Use exact member names, stable descriptions,
   project-relative paths beneath `sockets/` and `instructions/`, and LF UTF-8
   text. Never include credentials, session data, Inbox records, resolved socket
   paths, selected models, providers, or thinking settings.
6. Validate manifest references, exact unique names, instruction files, LF
   content, and absence of runtime/private artifacts. Report the Template,
   Configuration, Case, Run, Deliverable, and Baseline separately.

Model selection belongs to runner/startup configuration, not Crew identity or
permissions. A Role is responsibility guidance, never authorization. Do not
claim a message, vote, or verdict proves correctness, completion, or model
independence.

## Council of Models

Use the copyable [Council template](assets/templates/council-of-models/) only
when independently judging an externally supplied artifact is useful.

It has exactly Chair, Judge A, and Judge B. The Judges receive the same bounded
request, rubric, and evidence; neither sees the other judgment before its own
terminal response. Each returns verdict, cited evidence, uncertainty, and
missing information. The Chair then returns a final verdict, agreement or
disagreement, and an escalation reason when applicable. A Worker is external or
an explicit optional extension.

Run deterministic checks before any model judgment. Disagreement is observable
decision input, not failure; majority and Chair confidence are not truth.

## Runtime Judge checkpoint

Use the copyable [runtime Judge checkpoint template](assets/templates/runtime-judge-checkpoint/)
when a narrow model judgment is one input to continue, revise, gather evidence,
or escalate during an external workflow. The default Crew has exactly Worker
and Judge; the deterministic Host is software outside `crew.json` and owns
schema validation, deterministic checks, retries, budgets, transitions,
escalation, and effects.

Named checkpoints include `artifact-ready` and `evidence-sufficient`; each
receives the immutable request, narrow rubric, relevant artifact/evidence, and
deterministic results. The Judge returns only the bounded decision schema with
`continue`, `revise`, `gather-evidence`, or `escalate`. Invalid schema, unknown
verdict, missing evidence, timeout, and model failure fail closed to finite
retry or explicit escalation. Worker artifacts and Judge text are untrusted;
they cannot invoke tools, change policy, disclose secrets, or authorize
irreversible effects. See `evals/runtime-judge.json` for the offline failure
and escalation pack.

Do not use this Template as a Council substitute when independent judgments are
required. Optional multi-Judge mode captures independent responses and routes
disagreement through declared Host policy; majority is never proof.

## Review checklist

Reject or revise a template when it:

- embeds model selection, live state, credentials, runtime paths, task state, or
  evaluator policy in Bebop files;
- gives two Roles the same instruction ownership or requires members without a
  distinct output;
- lets Judges see peer judgments before responding;
- has no explicit baseline, predeclared expectations, bounds, or failure cost;
- treats an LLM judgment, transport acceptance, or a vote as completion or
  authorization; or
- requires Bebop to start processes, infer completion, grade results, or enforce
  workflow state.

Do not start sessions or run paid evaluations without explicit user agreement on
cases, repetitions, models, concurrency, and timeouts. Evaluation execution is
outside this skill's authoring workflow.
