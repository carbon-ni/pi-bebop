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

## Two-agent Crew Intake smoke harness

`crew_intake_smoke.py` is a separate lifecycle harness for the filesystem
Intake adapter. It creates a fresh project, manifest, session directories,
private Intake directories, and tmux session. It never starts a model prompt:
`publish` is the explicit action that may trigger a paid turn.

Preflight and start an online Contact/Peer case:

```bash
RUN=$(python3 skills/crew-creator/scripts/crew_intake_smoke.py start \
  --case online --provider google --model gemini-2.5-flash --thinking off \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["runDirectory"])')
```

Publish a bounded fixture atomically, inspect observable state, and capture:

```bash
python3 skills/crew-creator/scripts/crew_intake_smoke.py publish \
  --run-dir "$RUN" --file /absolute/path/to/intake.md --confirm-paid
python3 skills/crew-creator/scripts/crew_intake_smoke.py status --run-dir "$RUN"
python3 skills/crew-creator/scripts/crew_intake_smoke.py capture --run-dir "$RUN"
```

For the contact-joins-later case, start only Peer, publish before Contact joins,
then attach Contact explicitly:

```bash
RUN=$(python3 skills/crew-creator/scripts/crew_intake_smoke.py start \
  --case contact-joins-later --provider google --model gemini-2.5-flash \
  --thinking off | python3 -c 'import json,sys; print(json.load(sys.stdin)["runDirectory"])')
python3 skills/crew-creator/scripts/crew_intake_smoke.py publish \
  --run-dir "$RUN" --file /absolute/path/to/intake.md --confirm-paid
python3 skills/crew-creator/scripts/crew_intake_smoke.py attach \
  --run-dir "$RUN" --role Contact
```

Use `attach --view` to join the tmux session, or bounded observable waits such
as `status --wait-for processed --timeout-ms 120000`. Stop is idempotent and
retains evidence by default; add `--remove` only when the run directory should
be deleted:

```bash
python3 skills/crew-creator/scripts/crew_intake_smoke.py attach --run-dir "$RUN" --view
python3 skills/crew-creator/scripts/crew_intake_smoke.py stop --run-dir "$RUN"
# python3 skills/crew-creator/scripts/crew_intake_smoke.py stop --run-dir "$RUN" --remove
```

`start` returns only after every requested Member has a live titled pane and an
exact Unix-socket claim; startup errors or a deadline failure retain bounded
`failure.json` evidence and terminate the run session. The harness reports
file, pane, socket, and process evidence only. A processed file, live socket, idle pane, or transcript never proves that a Member read,
understood, acted on, or completed the Intake. If preflight fails, inspect the
reported executable/version and use a fresh run directory; if a pane dies,
`status` and `capture` preserve bounded evidence before `stop`. Run
`CREW_INTAKE_REAL_TMUX_SMOKE=1 python3 -m unittest discover -s skills/crew-creator/scripts -p 'test_crew_intake_smoke.py'`
only when an opt-in local no-prompt tmux layout check is desired.
