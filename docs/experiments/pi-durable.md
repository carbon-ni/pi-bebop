# Persistent crew members with Pi Durable

Status: experimental; not a production runtime or a commitment to merge.
Branch: `experiment-pi-durable`.
Starting point: `develop` at `f2837e1`.

## Problem

Bebop is used as a persistent crew. Members usually stay in long-running conversations rather than being replaced for each task. Their useful lifetime should not depend on a terminal connection or one operating-system process.

Today Bebop connects independent Pi sessions. Inbox messages survive offline periods, but persistent messages and conversation history do not provide checkpointed execution recovery. A process failure can interrupt a member's ongoing work.

## Desired outcome

An independent crew member keeps its identity and conversation across long periods of use, client disconnects, and runtime restarts. Pi Durable owns its conversation execution and recovery. Bebop continues to own crew membership and communication, not task assignment or completion decisions.

Existing Pi members remain usable alongside experimental members. A requester does not become the owner of another member's work.

## Working agreement

- Develop and evaluate this experiment on its separate branch and worktree.
- Keep `develop` unchanged by experimental work.
- Use small, tested commits and record supported behavior and known gaps.
- Judge the result through sustained real use, not only a successful demo.
- Prepare a merge only when Cristian decides the experiment is useful enough. Do not merge or replace the default runtime automatically.

## Milestones

### 1. Prove one persistent member

Pin a Pi Durable release and establish its exact API and runtime requirements. Run one fresh member conversation with persistent local storage and explicitly selected read-only tools.

Prove:

- Reopening storage recovers the same conversation and stable member identity.
- An interrupted run resumes according to the pinned runtime's replay policy.
- Disconnecting an observing client does not terminate the member's work.
- Exactly one host owns a storage instance.
- Restart steps and required credentials are documented. Storage recovery is not described as an operating-system process supervisor.

### 2. Connect Bebop Inbox

Reuse the current Inbox as the durable delivery boundary. Map each stored item to a stable recipient-scoped Durable submission key. Define a durable admission receipt before removing the Inbox item.

Prove:

- Crashes before submission, after submission before receipt, and after receipt before Inbox removal do not silently lose an item or admit it twice on retry.
- A receipt means admission, not work started or completed.
- Same-key/different-payload behavior is verified for the pinned version and accidental key reuse is prevented. Do not assume an undocumented framework conflict check.
- Inbox storage and Durable storage remain separate authorities; no cross-store atomicity is claimed.

### 3. Make the member useful in a mixed crew

Add only the runtime adaptations needed for membership, instructions, supported messaging, status, and tools. Document each supported operation and explicit limitation.

Prove:

- Ordinary Pi members and experimental members can coexist.
- Requester abort or crash does not cancel another member's accepted work.
- Existing transient Member Request behavior remains explicit: disconnect can terminate its response channel even if the recipient later resumes working.
- Recovery, busy, idle, and offline observations never imply task completion or correctness.
- Required Pi context, skills, credentials, and extension behavior are tested or explicitly listed as unsupported; coding tools alone are not claimed to provide full Pi parity.

### 4. Evaluate sustained use

Use the experimental member for real long-running work. Record evidence for context growth and compaction, reconnect behavior, recovery, duplicate admission, side-effect ambiguity, operating cost, and maintenance burden.

Fix observed problems in bounded increments. Do not widen the public contract merely to match available Durable primitives.

### 5. Prepare a merge candidate

Only after Cristian approves the real-use outcome:

- Review the full branch diff, compatibility, dependency isolation, and security boundaries.
- Document startup, recovery, supported versions, limitations, and migration or rollback where needed.
- Verify current Pi-member regressions and Durable crash/reconnect tests with fresh results.
- Decide whether the runtime stays opt-in. Experimental success does not automatically change the default.

## Safety and scope boundaries

- Pi Durable is a separate experimental harness, not a switch for existing coding-agent extensions. No unchanged-extension compatibility bridge has been verified.
- Pin versions; do not mix announcement snippets and current-main APIs without checking the selected release.
- Submission admission deduplication does not guarantee exactly-once external effects.
- Mark automatic replay safe only when the underlying action is safe to repeat. Non-idempotent actions need downstream idempotency or truthful interrupted/unknown handling. Test failure after the external effect but before its checkpoint.
- Do not place peer conversations under a requester's cancellable ownership tree.
- Keep initial experiments local. Remote access, authentication, retention, and deployment require separate decisions.
- Do not import existing Pi histories, reinterpret Crew Session bookmarks, replace Inbox storage, redesign durable Member Requests, or build a general ExtensionAPI shim as part of the first milestone.
- Bebop currently declares Pi 0.84.x support. Any coding-agent compatibility upgrade is a separate, tested change from adding Durable.

## Sources

- [Pi Durable announcement](https://earendil.com/posts/pi-durable/)
- [Official Durable documentation](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)
- [Official Durable examples](https://github.com/earendil-works/pi/tree/main/packages/durable/test/examples)
- [Bebop communication contract](../COMMUNICATION.md)
- [Current transient Member Request contract](../MEMBER-REQUEST-WORKFLOW.md)
- [Current Crew Session bookmarks](../CREW-SESSION.md)
