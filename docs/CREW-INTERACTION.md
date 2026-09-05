# Name-first Crew interaction contract

Status: product contract for TASK-0171. Implementation is deferred to dependent tasks.

## Promise

A caller addresses a Crew by its stable selector and a Member by its exact configured name. Pi Bebop resolves trusted local routing and correlation details. It never guesses identity, authority, or work progress.

```text
pi-bebop crew list
pi-bebop crew status funzzy
pi-bebop ask funzzy "What are you working on?"
pi-bebop ask funzzy/Mony "What is blocked?"
```

These commands require an authorized route: the current joined Member or an approved Guest membership for that exact Crew. Automatic routing never borrows another Member identity. A standalone External actor may discover Crews or use one-way Crew Intake, but a Crew Locator alone does not authorize Ask, Member actions, or Guest actions.

## Identity and location

- **Crew Selector** is `crew.id`: stable, case-sensitive, and public. It matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. Renaming `displayName` does not change it.
- **Crew display name** is informative and non-unique. Commands never resolve by display name.
- **Crew Locator** is the canonical resolved path of an allowed `.pi/bebop/crew.json` or compatibility `.pi/crew/crew.json`. It uniquely scopes a local Crew copy and is the manifest, trust, and routing lookup root. It is not Crew identity, authentication, or a universal transport endpoint.
- **Member Target** is an exact, case-sensitive configured Member name within one Crew. Member names remain manifest-owned. Public target parsing splits on the first `/`; the Crew Selector therefore cannot contain `/`.
- **Crew Target** is either one Crew Selector or an explicit `--crew <locator>` recovery selector. `crew/member` adds one Member Target.

Name-first resolution succeeds only when exactly one trusted eligible Crew Locator matches the Crew Selector. Duplicate IDs across worktrees are ambiguous even when they refer to clones of the same project. The error discloses only the candidate Crew Locators needed for an explicit corrected command. Runtime session IDs, sockets, Member endpoints, Request IDs, and capabilities remain hidden.

An explicit Locator is caller consent to inspect that exact local manifest. It is not caller authentication. Resolution must canonicalize the path, enforce the existing exact layout allowlist, check project trust before manifest IO, and reject traversal or symlink escape.

## Directory eligibility

`crew list` may include only:

1. exact trusted manifests in the current project layout;
2. live joined runtimes that report an exact trusted Crew Locator; and
3. bounded previously observed Locator records, marked offline and with `lastSeenAt`.

It never scans arbitrary projects or infers a Crew from a socket/session alias. A manifest without valid `crew.id` is shown as unaddressable only when reached through the current project or an explicit Locator; the recovery tells the user to add stable Crew identity metadata.

Default directory output contains Crew Selector, display name, availability, Member counts, and freshness. Locator is shown only for ambiguity recovery, explicit `--crew`, or diagnostic output.

## Authorization and attribution

Routing preserves the caller's actual product identity:

- a current joined Member acts as that Member;
- an approved Guest acts through that exact Crew membership and capability;
- a standalone CLI remains an unverified External actor.

A Locator never grants Member or Guest identity. Pi Bebop must not select an arbitrary joined session as a source because that would silently impersonate its Member.

Crew Intake remains the only standalone external write path: `send --crew <locator>` is one-way, targets only manifest-authored `intake.contact`, and promises persistence only. It never becomes Ask, direct Member delivery, Broadcast, or Guest admission.

Crew-level Ask resolves only `intake.contact` as recipient policy; the caller must still have a joined Member or approved Guest route. Missing contact fails without lead, role, first-member, or online-member fallback. Exact Member Ask resolves only the configured Member name and applicable caller authorization.

## Ask lifecycle

Ask is one non-interactive Member Request operation. It returns exactly one correlated Response or one terminal non-Response outcome. Correlation IDs stay internal.

Defaults and bounds:

| Stage | Default | Allowed | Meaning |
| --- | ---: | ---: | --- |
| Candidate probe | 300 ms each | fixed | Mechanical reachability only. |
| Discovery | 2 s total | fixed | Bound for resolving eligible local routes. |
| Delivery RPC | 5 s | fixed | Bound for request acceptance; not Response wait. |
| Post-idle Response grace | 30 s | 1–600 s | Time after responder first becomes idle to send one Response. |
| Total Ask wait | 120 s | 2–1,800 s | Absolute caller wait; must exceed Response grace. |

`--response-grace <duration>` and `--timeout <duration>` expose human durations. Invalid relations return the exact corrected command. Response, offline, timeout-after-idle, timeout-total, malformed-response, and route-lost are terminal. `SIGINT` stops the local wait with exit 130; it does not claim to cancel target work. A retry creates a new Ask and can produce a second response.

Accepted means the request was validated and accepted by a live endpoint. It does not mean seen, answered, or completed. A Response is correlated communication, not proof that work is correct or complete.

## Target and outcome table

| State | Result | Required recovery or output |
| --- | --- | --- |
| Missing Crew Selector | Error before probing | `pi-bebop crew list` |
| Unknown Crew Selector | Error | `pi-bebop crew list` and closest exact selectors only when deterministic |
| Duplicate selector/worktree | Ambiguous error | one runnable `--crew <locator>` command per trusted candidate |
| Exact Locator outside allowed layout | Trust error before manifest IO | required canonical layout, no fallback |
| Missing `crew.id` | Unaddressable error | add valid `crew.id`, or use Locator only for supported external Intake |
| Missing Member name | Error before delivery | runnable exact Member targets in manifest order |
| Duplicate Member name | Invalid-manifest error | fix manifest; never choose first |
| Crew-level Ask without contact | Policy error | corrected `ask crew/member` examples for configured names |
| No current Member/Guest authority | Authorization error | join as exact Member or establish approved Guest membership |
| Offline Crew | Offline terminal outcome | retry later; one-way Intake only when configured |
| Offline Member | Offline terminal outcome | retry later or use authorized durable Inbox when applicable |
| Self-target | Error | choose another exact Member or an approved Guest route |
| Stale route | One bounded re-resolution, then route-lost | rerun exact Ask; no hidden loop |
| Partial Crew Status | Success with `partial: true` | every unavailable Member has its own terminal reason |
| Malformed Response | Terminal protocol error | `pi-bebop doctor`; never render malformed content as valid |
| Total/grace timeout | Distinct timeout outcome | exact retry command with valid duration relation |
| Caller cancellation | exit 130 | state that only local wait stopped |

## Crew Status truth model

Crew Status is one bounded aggregation, not monitoring and not transcript analysis. It requests current reports from authorized reachable Members and keeps provenance per field.

| Field | Source | Timestamp | When absent |
| --- | --- | --- | --- |
| Crew Selector/display name | manifest-authored | manifest observation time | invalid/unaddressable Crew |
| Member name/role/description | manifest-authored | manifest observation time | invalid manifest |
| Presence/activity | mechanically observed runtime | `observedAt` | `unknown`, never offline by assumption |
| goal | explicit Member report | `reportedAt` | `unavailable` |
| assignment | explicit Member report | `reportedAt` | `unavailable` |
| progress | explicit Member report | `reportedAt` | `unavailable` |
| blockers | explicit Member report | `reportedAt` | `unavailable`, never “none” |
| results | explicit Member report | `reportedAt` | `unavailable` |
| next step | explicit Member report | `reportedAt` | `unavailable` |

Conflicting Member reports remain separate attributed rows. Bebop never infers these fields from conversation history, tool activity, Git, plans, role, Presence, Activity, idle state, or silence. Offline and timeout are mechanics, not reported work state.

Current status retains no hidden transcript. Bounded history may retain at most 20 explicit reports per Member and no report older than seven days. It records report content, author, `reportedAt`, collection outcome, and Locator fingerprint; it does not record prompts, socket routes, capability material, or session IDs. History output is explicit and never injected into a new Ask as truth.

## Output and diagnostics

- Text is concise and human-readable; TOON is deterministic and token-efficient; JSON is stable machine output.
- The same semantic fields and terminal outcome codes exist in all formats.
- Ordered output uses Crew Selector, then manifest Member order. Timestamps are RFC 3339 UTC.
- Default output excludes transport identifiers and internal errors.
- `--diagnostic` may show safe route class, Crew Locator, probe timing, retry count, and protocol version. It never shows socket paths, capabilities, message content, or raw Request IDs.
- Errors name the failed product target and include a runnable corrected command when one can be generated without guessing.

## Non-goals

Bebop does not infer permission from role, summarize transcripts, manage tasks, monitor continuously, authenticate a caller from a filesystem path, or claim a Response proves completion.
