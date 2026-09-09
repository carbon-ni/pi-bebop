# Crew evaluation runner

`crew_eval_runner.py` is an external harness adapter. It does not change Bebop
transport or production Crew state.

## Run one comparison

The command requires absolute Template, Case, Configuration, and fresh output
paths. Candidate and Baseline use the same Case and receive separate fresh
workspaces:

```bash
python3 crew_eval_runner.py run \
  --template /abs/template/crew.json \
  --case /abs/cases/case.json \
  --configuration /abs/config/candidate.json \
  --baseline-configuration /abs/config/baseline.json \
  --artifact /abs/input/artifact.json \
  --run-directory /abs/evals/iteration-1/eval-1 \
  --model Worker=provider/model \
  --timeout-ms 120000 \
  --concurrency 2 \
  --repetitions 3 \
  --adapter command \
  --member-command Worker=/abs/bin/worker \
  --member-command Judge=/abs/bin/judge
```

Each child reads request JSONL and must return a correlated completion JSONL
record with the same `requestId`, `status: "completed"`, an object `payload`,
and optional provider-authoritative `usage` counts. Missing or unknown usage is
never estimated; aggregation refuses to claim token efficiency without
provider-reported totals. `--adapter fake` is deterministic offline harness
support for tests and smoke runs.

## Aggregate

```bash
python3 crew_eval_runner.py aggregate \
  --evaluation-directory /abs/evals/iteration-1/eval-1
```

The aggregator retains every repetition, writes `benchmark.json`, and writes a
bounded `benchmark.md` review surface. It never averages away individual runs.

## Safety and limits

- Run directories must not exist. Candidate and Baseline get separate project,
  manifest, instruction, socket, session-state, input, output, transcript,
  timing, trace, and stderr paths. The source Crew is never joined or mutated.
- Timeout, concurrency, repetition, model-call, and child cleanup bounds are
  finite. SIGINT, timeout, child crash, malformed response, route loss, and
  cleanup failure are infrastructure errors and never passing assertions.
- Completion is request-correlated. Online/idle state, notifications, process
  exit, sleeps, or arbitrary transcript text never complete a run.
- Council Judges receive the same artifact/evidence without peer judgment;
  Chair synthesis happens only after both Judge completions are captured.
- Deterministic assertions run before optional semantic grading. Semantic cases
  require an explicit independent `--grader-model`; absent or not-run semantic
  grading remains a non-passing result.
- Process isolation is not a filesystem or network sandbox. Do not run paid
  evaluations, untrusted fixtures, or consequential effects without explicit
  user-agreed cases, models, repetitions, concurrency, timeouts, permissions,
  and an external policy boundary.
