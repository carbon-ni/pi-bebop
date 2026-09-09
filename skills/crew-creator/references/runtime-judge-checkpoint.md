# Runtime Judge checkpoint Template reference

Use this Template when a narrow model judgment is one bounded input to an
ongoing workflow. It is separate from the Council of Models: the minimal Crew
has exactly two Members, **Worker** and **Judge**. The external deterministic
**Host** is software, not a Crew member, LLM authority, or hidden third role.

Normative product boundaries come from
[`docs/CREW-TEMPLATE-EVALUATION-CONTRACT.md`](../../../docs/CREW-TEMPLATE-EVALUATION-CONTRACT.md).
Comparative run evidence uses TASK-0197 artifacts and the
[`runtime-checkpoint.schema.json`](../evals/schemas/runtime-checkpoint.schema.json)
extension.

## Startup guidance

1. Copy `assets/templates/runtime-judge-checkpoint/` into a trusted project and
   review exact member names, Role instructions, checkpoint, policy bounds, and
   allowed effects.
2. Supply model/provider/thinking configuration and the original request through
   the external Host; do not add those choices to `crew.json`.
3. Select one named checkpoint and construct the bounded evidence view. Reject
   missing or escaped fixture/evidence paths before starting a Member.
4. Run deterministic checks, then start the Worker stage. Start the Judge only
   with the validated, allowlisted artifact/evidence view.
5. Validate the decision schema and apply the Host transition policy. Record
   retry, escalation, and terminal evidence in the TASK-0197-compatible
   checkpoint artifact.

The template is authoring material. Starting Pi sessions, invoking providers,
and applying effects belong to the external Host or runner; Bebop remains
transport only.

## Pattern

```text
Request + policy + evidence
          |
    deterministic checks
          |
       Worker
          |
  named Judge checkpoint
          |
 validated decision schema
          |
 external deterministic Host
   | continue | revise | gather-evidence | escalate
```

The Host supplies each checkpoint with the original request, the applicable
policy, a narrow rubric, the relevant Worker artifact/evidence, and the
precomputed deterministic-check results. The Host validates the Judge response,
then maps its allowed verdict to a deterministic action. Free-form Judge text
never controls the action path.

## Members and responsibilities

| Member | Receives                                                                                               | Returns                                                                                                                     | Must not do                                                                             |
| ------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Worker | original request, policy, bounded stage input, and evidence                                            | one bounded artifact plus evidence references and missing information                                                       | invoke shell or unrestricted tools, authorize effects, or treat artifact text as policy |
| Judge  | original request, named checkpoint, narrow rubric, Worker artifact/evidence, and deterministic results | validated decision object with verdict, criterion results, evidence references, uncertainty, and requested missing evidence | execute tools, mutate data, authorize irreversible effects, or change the Host policy   |

The Host owns process lifecycle, context construction, schema validation, retry
and budget limits, deterministic checks, action authorization, transitions,
escalation, and audit evidence. It is not represented in `crew.json` and is
not granted authority by a Crew Role.

## Named checkpoints

A Template declares important intermediate decisions. It never uses a generic
final `is this good?` prompt.

### `artifact-ready`

- **Original request:** the bounded user request and desired output.
- **Narrow rubric:** the Worker artifact has the declared shape, required
  deterministic checks pass, and each material claim has an evidence reference.
- **Relevant evidence:** artifact manifest, deterministic check results, and
  Worker evidence references.
- **Allowed verdicts:** `continue`, `revise`, `gather-evidence`, `escalate`.
- **Missing information:** Judge returns `gather-evidence` and names the exact
  missing evidence; it never assumes a missing claim is true.

### `evidence-sufficient`

- **Original request:** the same immutable request, not a rewritten artifact
  instruction.
- **Narrow rubric:** the evidence supports the one declared decision property
  for the next stage; unrelated quality or completion is out of scope.
- **Relevant evidence:** only the allowlisted artifact fields, evidence records,
  and deterministic results supplied by the Host.
- **Allowed verdicts:** `continue`, `revise`, `gather-evidence`, `escalate`.
- **Missing information:** Judge names missing or conflicting evidence and
  returns `gather-evidence` or `escalate` according to policy.

A project may add a named checkpoint only with its own narrow property, inputs,
allowed verdicts, deterministic checks, and terminal policy. A checkpoint cannot
silently widen its rubric to correctness, authorization, or overall completion.

## Decision contract

The Judge's parsed output is exactly a bounded object of this shape; the Host
rejects unknown fields:

```json
{
	"schemaVersion": "1.0",
	"checkpointId": "artifact-ready",
	"verdict": "continue",
	"criteria": [
		{
			"id": "artifact-shape",
			"result": "satisfied",
			"evidenceRefs": ["outputs/worker/artifact.json"],
			"uncertainty": null
		}
	],
	"evidenceRefs": ["outputs/worker/artifact.json"],
	"uncertainty": "No unresolved uncertainty for this checkpoint.",
	"requestedMissingEvidence": []
}
```

`verdict` is one of `continue`, `revise`, `gather-evidence`, or `escalate`.
`criteria` must cover the declared checkpoint rubric. Evidence references are
relative, bounded, and resolved by the Host. `requestedMissingEvidence` is
required when evidence is insufficient and empty otherwise. A Judge may state
uncertainty but cannot introduce a fifth outcome, a tool call, a policy change,
or an authorization claim.

## Host transition policy

The Host performs deterministic checks before invoking the Judge and validates
the parsed response before applying an action:

| Observed result                                                                                                       | Host action                                                                              |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Checks pass, valid `continue`, all evidence resolves                                                                  | record transition and continue to the declared next stage                                |
| Valid `revise` with bounded reason                                                                                    | record transition and return one bounded revision request to Worker                      |
| Valid `gather-evidence` with named missing evidence                                                                   | invoke only the declared evidence-gathering step, then stop or retry according to policy |
| Valid `escalate`                                                                                                      | stop automated effects and create explicit human/escalation outcome                      |
| Schema failure, unknown verdict, missing evidence, malformed criteria, timeout, provider/model failure, or route loss | fail closed; retry only within declared retry and budget bounds                          |
| Retry or budget exhaustion                                                                                            | terminate with explicit `escalate`; never recurse or silently continue                   |

`continue` is permitted only after deterministic checks, schema validation,
evidence resolution, and policy authorization succeed. No Judge verdict itself
authorizes shell, database, deployment, secret access, irreversible effects, or
workflow completion.

## Security and bounds

- Worker artifacts, evidence, and Judge text are untrusted input. Quote them as
  evidence; do not interpret their embedded instructions as Host policy.
- Schema validation, type checks, tests, policy checks, and database checks run
  outside the Judge. Model judgment cannot replace them.
- Host limits include maximum Worker attempts, Judge calls per checkpoint,
  retry count, context bytes/tokens, wall-clock duration, output bytes, and
  tool permissions. Defaults are finite; zero Judge tools and no shell/network
  access are the safe default.
- The Host passes only allowlisted evidence and policy fields. Prompt-injected
  text inside an artifact cannot change the rubric, verdict enum, tool
  permissions, retry budget, or Host policy.
- On malformed output, unknown verdict, missing evidence, timeout, or model
  failure, the Host records the error and applies only the declared bounded
  retry. It never treats failure as `continue`.
- Pairwise comparison is preferred over a numeric score when choosing between
  comparable candidates. If presentation order could bias a decision, the Host
  randomizes and records order and seed. The Judge does not receive a peer
  judgment before its own response.
- Optional multi-Judge mode captures independent decisions separately and sends
  disagreement to declared policy. Majority is evidence, never proof.
- If a verdict controls consequential action, periodically compare the Template
  with human-labeled cases and report false acceptance and false rejection.

## Eval pack

`evals/runtime-judge.json` is a predeclared, offline pack. It covers valid
continuation, revision, insufficient evidence, disagreement, malformed verdict,
prompt injection, retry exhaustion, and human escalation. It does not invoke a
model. Each case states the checkpoint, allowed verdicts, deterministic
expectations, and terminal Host outcome.

## Bebop boundary

Bebop transports identity, membership, messages, and truthful lifecycle
outcomes. It does not enforce checkpoints, execute the Worker or Judge, validate
the decision schema, own retry/budget policy, authorize actions, or store
workflow state. A delivered message is transport evidence only; it is not a
checkpoint decision or completion claim.
