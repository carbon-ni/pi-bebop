# Software Crew Workflow

Use the [STE100 profile](STYLE.md) when you edit this guide. Keep tool names and code examples exact.

Pi Bebop provides crew identity and communication. It does not manage backlog, Git, tests, reviews, CI, or integration decisions. Keep those in project tools and crew conventions.

This optional workflow uses current Bebop features. It is a convention, not an enforced framework. Copy and adapt the example manifest and role instructions. Do not treat roles as permissions.

## Roles

Roles describe responsibility; they do not grant permissions. Multiple members
may share one role. Use member name when ownership must be exact.

| Actor           | Responsibility                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| External actor  | Sends one-way request into Crew Intake without becoming member.                                       |
| Product contact | Triages external request, clarifies problem and acceptance, then forwards actionable outcome to lead. |
| Lead            | Coordinates ownership, timing, independent verification, and integration decisions.                   |
| Developer       | Implements one owned change using project conventions and reports evidence or blockers.               |
| Quality         | Independently verifies acceptance and failure paths, then reports findings and verdict.               |

Product owner is recommended Crew Intake contact for software crew, but manifest
must select exact member explicitly. Bebop never infers contact from `product`,
`lead`, first member, or current presence.

## Example crew and role instructions

The example under [`docs/examples/software-crew/`](examples/software-crew/)
demonstrates:

- exact configured Crew Intake contact;
- stable member descriptions;
- `instructionsFile` composition;
- two members sharing `developer` and two sharing `quality` roles;
- exact-name routing when a role is ambiguous.

Files:

- [`crew.json`](examples/software-crew/crew.json)
- [`lead.md`](examples/software-crew/instructions/lead.md)
- [`product.md`](examples/software-crew/instructions/product.md)
- [`developer.md`](examples/software-crew/instructions/developer.md)
- [`quality.md`](examples/software-crew/instructions/quality.md)

To use it, copy `crew.json` and `instructions/` into a trusted project's
`.pi/bebop/`, then create/start the configured member endpoints. Role
instructions are read as a snapshot during join/restore/rejoin; they are not hot
reloaded. Descriptions are crew-visible profile text, and Role
instructions are behavioral guidance.

## Communication ladder

Choose least disruptive operation that solves coordination need.

| Need                                    | Capability                   | Typical user                                | Behavior                                                                                                                                   |
| --------------------------------------- | ---------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------ |
| Inspect reachability                    | `/crew members`              | Any joined member                           | Shows current/online/offline only; online does not mean available.                                                                         |
| Inspect timing                          | `get_member_status`          | Usually lead, but any joined member         | Returns live `idle                                                                                                                         | busy | compacting` and pending-message signal. Never reads conversation.                                                                         |
| Normal targeted coordination            | `send_follow_up`             | Any joined member                           | Safe default. Waits behind target active work.                                                                                             |
| Durable targeted message                | `send_to_inbox`              | Any joined member                           | Persists for online/offline recipient and survives restart. Success means persisted, not completed.                                        |
| Change next model step                  | Redirect (`redirect_member`) | Any joined member, commonly lead or quality | Pi steer enters after current assistant turn/tool calls and before next model step. It does not abort current operation.                   |
| Stop and recover awry active work       | `interrupt_member`           | Any joined member, exceptionally            | Records recovery, requests best-effort abort, then introduces guidance ahead of older Follow-ups. Cannot roll back completed side effects. |
| Share one constraint with everyone else | `broadcast_to_crew`          | Any joined member                           | Persists separate non-interrupting Inbox copy for every other member. Never redirect-all.                                                  |
| Message crew from outside               | Crew Intake                  | External actor                              | Persists one-way message for configured contact, who owns triage rather than automatic acceptance.                                         |

Do not query status before every message. `send_follow_up` is safe default even
when target is busy. Query status only when ownership or timing decision depends
on it.

## End-to-end flow

### 1. Intake

External actor sends request through Crew Intake. Product contact receives it
even when offline because Intake uses durable Inbox.

Product contact decides whether to ignore malformed/unwanted content, clarify
through available external channel, or shape it into actionable problem.

### 2. Product shaping

Product contact defines:

- problem and desired outcome;
- acceptance criteria;
- non-goals and constraints;
- relevant ubiquitous language.

Product sends shaped outcome to lead with `send_follow_up` when lead online, or
`send_to_inbox` when delivery must survive absence/restart.

### 3. Coordination

Lead chooses exact owner. If timing matters, lead checks Member Status. Activity
is mechanical Pi state and never implies progress. Lead does not infer
availability, competence, acknowledgement, or task progress from it; ask the
member explicitly for intent or progress.

Lead sends targeted assignment through Inbox when it must be durable. Shared
constraint goes through Broadcast, but ownership remains targeted to one member.

The [Member Request Workflow](MEMBER-REQUEST-WORKFLOW.md) defines a
non-blocking lead loop for parallel delegated requests. It preserves ordinary
Follow-up and Member Idle Wait semantics while adding bounded Response
correlation.

### 4. Implementation

Developer works with project plan, Git, tests, and watcher independently from
Bebop. If blocked, developer sends focused follow-up to lead rather than waiting
silently.

### 5. Course correction

Use escalation ladder:

1. Follow-up for normal new information.
2. Redirect when target should change next model step after current tool calls.
3. Interrupt only when active work is stuck, harmful, or based on invalid assumption and must abort.

Interrupt does not rewind session or undo filesystem, shell, network, or other
side effects already completed.

### 6. Verification

Developer sends evidence to quality: owned change, relevant artifact/commit,
tests, known risks, and acceptance reference. Quality verifies independently.

Quality sends findings to developer through Follow-up. Redirect is appropriate
when current direction must change; Interrupt is reserved for actively harmful
work. Quality reports verdict to lead and does not silently become implementer.

### 7. Integration

Lead evaluates developer and quality evidence, makes integration decision, and
closes external project artifacts using their native tools. Bebop tracks none of
those states.

Lead or any member may Broadcast a crew-wide constraint or adopted contract.
Broadcast communicates information; it does not create shared task ownership.

### 8. Close-out

Product/lead update documentation and role instructions where product language
or workflow changed.

## Example: external request to verified change

Crew:

- Tony — lead
- Mary — product contact
- Bob — developer
- Kelly — quality

### External actor to product

```bash
pi-bebop send --crew .pi/bebop/crew.json \
  --message "Users need offline crew messages to survive restart" \
  --from "product-request"
```

Mary receives message through Inbox, clarifies behavior, and sends Tony shaped
problem:

```text
send_follow_up({
  member: "Tony",
  message: "Problem: offline member messages are lost. Acceptance: persist per-member messages and hand them to Pi as normal follow-ups after restart; no task/Git workflow semantics."
})
```

### Lead to developer

Tony checks timing only if needed:

```text
get_member_status({ member: "Bob" })
```

If Bob offline or assignment must be durable:

```text
send_to_inbox({
  member: "Bob",
  message: "Implement durable Inbox enqueue according to plans/todo/0036-add-member-inbox-enqueue-operation-and-tool.md. Report tests, risks, and blockers."
})
```

### Developer execution

Bob implements with project tools, then requests independent verification:

```text
send_follow_up({
  member: "Kelly",
  message: "Inbox enqueue is ready for verification. Validate offline target, persistence acknowledgement, origin derivation, capacity failure, and restart behavior."
})
```

### Quality feedback

Kelly verifies. Normal finding:

```text
send_follow_up({
  member: "Bob",
  message: "Finding: full Inbox error collapses into generic storage failure. Preserve actionable capacity error and add unhappy-path test."
})
```

If Bob is continuing from invalid assumption but current operation need not abort:

```text
# Current tool: redirect_member
redirect_member({
  member: "Bob",
  message: "Change direction: keep Inbox transport-only; do not add task lifecycle fields."
})
```

If Bob is actively executing harmful operation:

```text
interrupt_member({
  member: "Bob",
  message: "Abort current operation. Do not rewrite shared session history; recover from current committed state."
})
```

### Crew-wide update

After integration, Tony shares adopted constraint:

```text
broadcast_to_crew({
  message: "Inbox is transport-only. Persisted never means delivered or completed."
})
```

## Using the templates

Each template defines mission, expected inputs, expected outputs, escalation,
and definition of done. Message text carries these conventions opaquely; Bebop
does not parse acceptance, assignments, evidence, verdicts, or completion.

Adapt the templates to the host project's tools and AGENTS guidance. Plans, Git,
tests, coverage, reviews, CI, releases, and integration remain outside Bebop.
Crew startup, member process lifecycle, and final integration decisions remain
explicit user/lead responsibilities.

## Guardrails

- Roles describe responsibility and routing hints; they never grant permissions.
- Presence is reachability, not availability.
- Activity is Pi runtime state, not productivity.
- Follow-up is default.
- Inbox is durable delivery, not task tracker.
- Redirect changes next model step but does not abort current tool calls.
- Interrupt is destructive control and cannot roll back side effects.
- Broadcast is for shared information, not shared ownership.
- Crew Intake chooses one configured contact; it never broadcasts.
