# Crew Template and Evaluation Contract

Status: normative product contract for TASK-0195. This document defines reusable
Crew authoring and comparative evaluation. It does not add runtime behavior to
Pi Bebop.

## Promise and boundary

A **Crew Template** is a reusable, versioned description of a Crew's intended
roles, instructions, usage, and deliverable. It is an authoring artifact, not a
live Crew and not an evaluation runner. A template must be useful without
assuming a socket, session, credential, provider, model, or hidden workflow.

The external **evaluation harness** owns process lifecycle, case orchestration,
isolated workspaces, grading, aggregation, and reports. Bebop remains a
transport boundary for identity, membership, messaging, and observed outcomes.
Bebop does not start the harness, choose models, own cases, grade artifacts, or
infer quality from member presence, votes, messages, or silence.

This contract is deliberately transport-neutral. A future skill, artifact
schema, or runner may implement it only by preserving these boundaries.

## Core vocabulary

- **Crew Template**: versioned template manifest, shared instructions, Role
  instructions, and usage guidance. Its manifest may contain deterministic,
  project-relative configured Member endpoint paths, but it contains no
  resolved runtime sockets, endpoint claims, Inbox records, sessions,
  credentials, or implicit model selection. It describes intended structure and
  behavior, not a live membership claim.
- **Crew Configuration**: one Template plus runner-selected models, providers,
  thinking levels, case inputs, resource bounds, repetition plan, and
  environment. Configuration belongs to the external harness and is explicit.
- **Crew Eval Case**: one fixed prompt, optional disposable fixtures, expected
  outcome, and predeclared assertions. A case is reusable evidence, not a live
  Crew message or task.
- **Crew Eval Run**: one isolated execution of one Configuration against one
  Case. A repetition is another independently isolated Run of the same declared
  comparison.
- **Crew Deliverable**: the bounded artifact selected by the Template contract
  for grading. For the Council Template, the terminal deliverable is the
  Chair's final verdict; it is not a vote, transcript, or claim of truth.
- **Crew Baseline**: an explicit comparison Configuration, such as a single
  agent or a prior Template snapshot. An unlabeled absence of Crew is not a
  baseline.
- **Council**: the default three-member evaluation arrangement: one Chair and
  exactly two independent Judges. Council membership does not guarantee
  distinct models or unbiased judgment.
- **Chair**: Council member that frames the request and rubric, requests the
  independent judgments, exposes agreement and disagreement, and reports the
  terminal verdict.
- **Judge**: Council member that evaluates the supplied artifact independently
  against the same evidence and rubric, then returns a verdict, evidence,
  uncertainty, and missing information.
- **Worker**: optional producer that creates the artifact being evaluated. A
  Council does not silently become a Worker; the artifact may instead be
  supplied by an external producer.
- **Evaluation harness**: external software that owns lifecycle, isolation,
  case execution, assertions, grading, metrics, and reports.
- **Infrastructure failure**: a run error caused by lifecycle, transport,
  timeout, setup, dependency, or other execution infrastructure. It is not a
  passing negative case and does not become a quality grade.

Template, Configuration, Case, Run, Deliverable, and Baseline are distinct
artifacts. No one may be inferred from another.

## Reusable Template contract

A Template MUST state:

1. its stable template name and version;
2. intended problem and desired Crew Deliverable;
3. member identities, Roles, shared instructions, Role instructions, and usage
   guidance;
4. inputs each Role receives and outputs it must return;
5. terminal conditions and bounded output expectations;
6. known limits, optional extensions, and safe non-goals; and
7. how to construct a comparable Baseline and Eval Case.

A Template MUST NOT contain:

- resolved runtime sockets, endpoint claims or symlinks, session IDs, Inbox
  records, credentials, or other live runtime state. Deterministic
  project-relative configured Member endpoint paths in the template manifest
  are allowed;
- selected model/provider/thinking settings or an implied model assignment;
- hidden case inputs, unbounded retries, unbounded context, or implicit
  process-lifecycle assumptions; or
- Bebop workflow state, grading state, or claims that a Role grants authority.

A `crew.json` manifest may identify configured Crew members and deterministic
project-relative Member endpoint paths. A Template must not contain resolved
runtime sockets, endpoint claims, session IDs, or other live fields. Model,
provider, and thinking selection belong to the external Crew Configuration and
MUST stay outside `crew.json`. Three configured member names do not imply three
different models; model independence is an evaluation choice that must be
recorded by the harness.

## Minimal Council specification

The default Council has exactly three members:

| Member  | Inputs                                                        | Responsibilities                                                                                                                  | Required output                                                                    |
| ------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Chair   | request, rubric, case evidence, both terminal Judge responses | frame the request and rubric; request independent judgments; expose agreement and disagreement; produce the final bounded verdict | final verdict, decision evidence, uncertainty, disagreement/escalation disposition |
| Judge A | supplied artifact, same case evidence, same rubric            | independently assess the artifact before seeing any other judgment                                                                | verdict, evidence, uncertainty, missing information                                |
| Judge B | supplied artifact, same case evidence, same rubric            | independently assess the artifact before seeing any other judgment                                                                | verdict, evidence, uncertainty, missing information                                |

The Chair is not a fourth evaluator. Judges receive no peer judgment before
returning their own terminal response. The Chair may synthesize only after
both independent responses are captured. Agreement is evidence to expose;
disagreement is decision input, not an automatic failure.

The Council accepts an externally supplied artifact. It does not imply that a
Worker exists or that any Council member produced the artifact. If production
is part of a case, the Configuration MUST explicitly name an optional Worker
or external producer and record its output boundary before judging starts.

A specialist Judge, Worker, extra reviewer, or human reviewer is an optional
extension. It must be explicitly declared with its purpose, inputs, output,
additional cost, and comparison impact. Extra members are never required to
make the default Council valid: the minimum remains Chair plus Judge A plus
Judge B. Majority, Chair confidence, model identity, or member count is never
proof of correctness.

The Council contract requires observable outcomes for disagreement, escalation,
retry, and human review. A missing outcome is not inferred from an idle member,
absence of messages, or a process exit.

## Comparative evaluation contract

The harness evaluates a candidate Template against an explicit Baseline. For
each Case, it MUST run candidate and baseline with:

- the same prompt and fixtures, or documented equivalent fixtures;
- compatible model/provider/thinking settings, with every difference declared;
- the same resource and time bounds;
- the same allowed effects and isolation policy; and
- the same number and plan of repetitions.

A comparison is invalid when the baseline is unnamed, receives different case
inputs without explanation, reuses candidate-produced fixtures, or has
incompatible bounds that are not declared. A prior Template snapshot and a
single-agent baseline are both valid choices; the report identifies which one
was used. Quality alone never proves efficiency or value.

### Assertions and grading order

The Case declares assertions before either output is inspected. Assertions are
ordered by authority:

1. deterministic checks (schema, required files, exact fields, bounds, allowed
   effects, exit state, and other machine-verifiable facts);
2. expected-outcome and gold-label checks where labels exist; then
3. semantic LLM grading against the declared rubric, with evidence and
   uncertainty.

Deterministic failures cannot be overridden by a favorable semantic grade.
Semantic grading cannot invent a missing deliverable, relabel an infrastructure
failure as a negative example, or turn a vote into truth. The harness records
which assertion failed and whether the run was valid, invalid, or an
infrastructure error.

A Case that has labels MUST report false acceptance and false rejection against
those labels. A Case without labels MUST say so; it must not manufacture those
metrics. Missing, malformed, or ambiguous required Deliverables fail the
relevant assertion unless the Run itself is invalid infrastructure.

### Required report evidence

The comparison report contains candidate and Baseline values and explicit
candidate-minus-Baseline deltas for, at minimum:

- quality and pass rate;
- false acceptance and false rejection where authoritative labels exist;
- duration/latency;
- authoritative token usage from the model/provider boundary;
- message count and other declared interaction overhead;
- errors, including infrastructure failures separately from graded failures;
- repetition count and variation across repetitions (mean, min, max, and
  standard deviation or another declared dispersion measure); and
- Candidate, Baseline, case, configuration, and Template version identities.

The report keeps each Run's evidence and terminal outcome. It does not claim a
passing negative case when setup, transport, timeout, dependency, or process
lifecycle failed. Unknown or missing usage is reported as unavailable rather
than estimated from message text or claimed as zero.

## Lifecycle and observable outcomes

The external harness owns this sequence:

1. validate Template, Configuration, Case, Baseline, bounds, and predeclared
   assertions;
2. prepare separate candidate and Baseline workspaces and record identities;
3. run each isolated Run, capturing authoritative evidence;
4. capture Judge A and Judge B terminal responses independently, then allow the
   Chair to synthesize;
5. apply deterministic assertions before semantic grading;
6. classify valid result, assertion failure, infrastructure failure, or
   explicitly cancelled/unknown outcome; and
7. aggregate repetitions without hiding variation and publish the comparison.

The harness must expose, rather than infer, these Council outcomes:

- **agreement**: both Judges returned and their decision relationship is shown;
- **disagreement**: Judges returned materially different judgments;
- **escalation**: a declared policy requested a specialist or human decision;
- **retry**: a bounded, declared rerun occurred and its reason is recorded;
- **human review**: a human supplied a review outcome; and
- **infrastructure failure**: execution could not produce a valid graded Run.

Neither a Chair verdict nor a majority vote upgrades an uncertain result to
truth. The report states missing information and uncertainty.

## Bebop boundary

Bebop may provide the harness with product-level identity, membership,
message delivery, and observed transport outcomes. It remains responsible for
truthful delivery/error states at that boundary. It does not own:

- model/provider/thinking selection;
- worker or evaluator lifecycle;
- Case and fixture creation;
- candidate/Baseline orchestration or workspace isolation;
- assertions, semantic grading, aggregation, or benchmark reports; or
- inferred progress, quality, completion, correctness, or judge independence.

The harness may use Bebop messaging, but a Bebop message is not automatically an
Eval Case, Run, Deliverable, grade, or completion signal. Transport success is
reported as transport evidence only. The same boundary applies whether the
harness is a local script, CI job, or future skill.

## Acceptance evidence map

This contract is the maintained documentation for TASK-0195:

| Criterion                                                      | Evidence                                                                                       |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Core terms and separation from live state/configuration        | [Core vocabulary](#core-vocabulary), [Reusable Template contract](#reusable-template-contract) |
| Exactly three Council members and optional extra roles         | [Minimal Council specification](#minimal-council-specification)                                |
| Testable inputs, outputs, and terminal deliverable             | Council table and [Lifecycle and observable outcomes](#lifecycle-and-observable-outcomes)      |
| External artifact and explicit optional Worker                 | Council artifact/Worker paragraphs                                                             |
| Model/provider/thinking outside `crew.json`                    | Template boundary paragraphs                                                                   |
| Same-case candidate/Baseline comparison                        | [Comparative evaluation contract](#comparative-evaluation-contract)                            |
| Predeclared deterministic-first assertions                     | [Assertions and grading order](#assertions-and-grading-order)                                  |
| Required quality, error, cost, overhead, and variation metrics | [Required report evidence](#required-report-evidence)                                          |
| Infrastructure failures remain errors                          | Assertions and report evidence                                                                 |
| External harness/Bebop transport-only boundary                 | [Bebop boundary](#bebop-boundary)                                                              |
| Disagreement, escalation, retry, and human review observable   | [Lifecycle and observable outcomes](#lifecycle-and-observable-outcomes)                        |

## Non-goals

This contract does not implement Template files, a Crew Creator skill, an Eval
Case schema, an evaluation runner, model selection, a universal quality rubric,
Bebop workflow state, transport changes, or a guarantee that Judges are
independent or correct.
