---
id: TASK-0199
title: Add runtime Judge checkpoint Crew Template
status: done
depends_on: [TASK-0196, TASK-0197]
priority: high
tags: [skill, crew, template, llm-judge, runtime, control-flow, security, evaluation]
---

# Add runtime Judge checkpoint Crew Template

## Problem

The Council Template evaluates a supplied artifact after work exists. It does not cover the broader runtime pattern where a narrow model judgment becomes one input to continue, revise, gather evidence, or escalate during an agent workflow. Without a separate contract, users may let free-form model text directly control actions, add unbounded judge loops, or mistake a Judge verdict for authorization or proof.

## Desired outcome

Add a second `crew-creator` Template for bounded runtime judgment checkpoints. Keep Worker and Judge responsibilities in Crew instructions while an external deterministic Host validates verdicts and owns control flow.

## Minimal pattern

```text
Request + policy + evidence
          |
    deterministic checks
          |
       Worker
          |
  narrow Judge checkpoint
          |
 validated decision schema
          |
 external deterministic Host
   | continue | revise | gather-evidence | escalate
```

The minimal Crew has two members:

1. **Worker** performs one bounded stage and returns artifact plus evidence.
2. **Judge** evaluates one declared property against supplied rubric and evidence.

The external **Host** is software, not another Crew member. It validates structured output, applies retry/budget/policy rules, and authorizes effects. A second independent Judge or Council is optional when disagreement has measured value or risk justifies its cost.

## Acceptance criteria

- [x] `skills/crew-creator` includes a copyable runtime-Judge Template separate from Council of Models, with problem, suitable uses, limits, and startup guidance.
- [x] Default Template uses exactly Worker and Judge; external Host is explicit and never represented as an LLM authority.
- [x] Template defines one or more named checkpoints around important intermediate decisions, not a generic final “is this good?” prompt.
- [x] Each checkpoint supplies original request, narrow rubric, relevant artifact/evidence, allowed verdicts, and missing-information behavior.
- [x] Judge output uses a bounded validated schema containing verdict, criterion results, evidence references, uncertainty, and requested missing evidence.
- [x] Allowed semantic outcomes are `continue`, `revise`, `gather-evidence`, and `escalate`; Host maps them to actions through deterministic policy.
- [x] Schema failure, unknown verdict, missing evidence, timeout, and model failure fail closed to bounded retry or escalation; they never silently continue.
- [x] Retry count, model calls, context size, duration, and tool permissions are bounded. Exhaustion terminates with explicit escalation rather than recursion.
- [x] Deterministic schema, type, test, policy, and database checks run outside the Judge and are never replaced by model judgment.
- [x] Judge text and Worker artifacts are treated as untrusted input; neither can directly invoke shell, mutate data, disclose secrets, or authorize irreversible effects.
- [x] Prompt-injected instructions inside evaluated artifacts cannot change rubric, allowed verdicts, tool permissions, or Host policy.
- [x] Pairwise comparison is preferred over numeric scoring when choosing between comparable candidates; presentation order is randomized and recorded when order bias matters.
- [x] Optional multi-Judge mode preserves independent judgments and routes disagreement to declared policy; majority alone is never proof.
- [x] Template requires periodic comparison against human-labeled cases when verdicts control consequential actions and records false acceptance/rejection.
- [x] Eval pack covers valid continuation, revision, insufficient evidence, disagreement, malformed verdict, prompt injection, retry exhaustion, and human escalation.
- [x] TASK-0197 artifacts record checkpoint decisions, Host transitions, latency, tokens, retries, and terminal outcome without leaking secrets or unrelated session content.
- [x] Documentation states that Bebop transports messages and truthful lifecycle outcomes only; it does not enforce checkpoints, authorize actions, or own workflow state.

## Evidence

- Reference contract: [`skills/crew-creator/references/runtime-judge-checkpoint.md`](../../skills/crew-creator/references/runtime-judge-checkpoint.md).
- Copyable two-member Template: `skills/crew-creator/assets/templates/runtime-judge-checkpoint/` contains exactly Worker and Judge, with shared, Worker, and Judge instructions.
- Bounded decision artifact: `skills/crew-creator/evals/schemas/runtime-checkpoint.schema.json` records deterministic checks, Worker/Judge evidence, decision schema, Host transitions, latency, provider-authoritative tokens, retries, and terminal outcome.
- Offline eval pack: `skills/crew-creator/evals/runtime-judge.json` covers all eight required valid/failure/escalation cases.
- Skill integration: `skills/crew-creator/SKILL.md` links the runtime reference and states the Host/Bebop boundary without modifying Council assets.
- Focused validation: JSON parsing, template manifest/reference checks, exact Worker/Judge count, schema-reference checks, LF checks, Prettier, and `git diff --check` pass.
- Scope check: only runtime-Judge references/assets/eval extension, the necessary `SKILL.md` and TASK-0197 README references, and this plan changed; no runner, model invocation, source/runtime, or Bebop transport changes.

## Non-goals

Adding orchestration to Bebop, building a universal policy engine, allowing an LLM to authorize irreversible actions, promising Judge correctness, forcing multiple Judges, or replacing offline regression evaluation with runtime checks.
