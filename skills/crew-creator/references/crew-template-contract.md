# Crew Template contract reference

Use [`docs/CREW-TEMPLATE-EVALUATION-CONTRACT.md`](../../../docs/CREW-TEMPLATE-EVALUATION-CONTRACT.md)
as the normative product contract.

A Template is versioned authoring material: manifest, shared and Role
instructions, usage guidance, and a bounded Crew Deliverable. It is not live
Crew state or a runner configuration. A Configuration separately selects models,
providers, thinking levels, inputs, bounds, repetitions, and environment.

Evaluation compares a candidate with an explicit Baseline on the same declared
cases, fixtures, compatible settings, bounds, allowed effects, and repetitions.
Declare deterministic assertions before outputs exist. Deterministic failures
win over semantic grading. Infrastructure failures are errors, not passing
negative cases.

The external harness owns lifecycle, isolation, case execution, grading, and
reports. Bebop transports identity, membership, messages, and truthful outcomes
only. Never add orchestration, task state, model judgment, or completion claims
to Bebop.
