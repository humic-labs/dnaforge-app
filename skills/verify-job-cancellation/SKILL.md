---
name: verify-job-cancellation
description: Verify DNAForge legacy job cancellation through authenticated sidecar routes, real asyncio handlers, event streams and SQLite. Use when changing cancellation requests, execution ownership or terminal job settlement.
---

# Verify job cancellation

## Launch

From `apps/api`, install dependencies with `uv sync --frozen --extra dev`.
The drive starts the production FastAPI application through its in-process HTTP
transport and the real job manager on one asyncio loop. Each case owns a fresh
SQLite file, synthetic session, handlers and synchronization events. No desktop,
listening port, model, external service or user profile is needed. A compatible
existing virtualenv may supply `python` without changing that environment.

## Doctor

From `apps/api`, run:

```sh
python -c 'from pathlib import Path; import src.main; print(Path(src.main.__file__).resolve()); print(src.main.app.title)'
```

Confirm the printed source belongs to this checkout. The fixture supplies its
own authentication; never use a real desktop token.

## Drive

Set `CANCELLATION_EVIDENCE` to a new directory outside the checkout. From
`apps/api`, run:

```sh
python -m pytest --no-cov -q -o tmp_path_retention_policy=all tests/test_job_cancellation_acceptance.py tests/test_job_cancellation_compatibility.py --basetemp="$CANCELLATION_EVIDENCE/scratch" --junitxml="$CANCELLATION_EVIDENCE/results.xml" > "$CANCELLATION_EVIDENCE/transcript.txt" 2>&1
```

Read the exit code and transcript. Compare the managed-operation reference:

```sh
python -m pytest --no-cov -q tests/test_managed_operations.py -k 'one_physical_worker_queued_stop_and_active_settlement or cooperative_cancel_needs_explicit_executor_canceled_outcome or real_failure_after_cooperative_stop_remains_failed'
```

The handler boundary contains deterministic synthetic work. Cancellation,
cleanup waits, pool ownership, authenticated HTTP, job events and SQLite writes
are production behavior. This does not qualify cancellation of an external
scientific process or a desktop UI.

## Evidence

Keep the transcript, JUnit report, source commit and diff. Before cleanup, copy
the synthetic SQLite files from `scratch` to an evidence `databases` directory.
Keep baseline failures alongside final successes. The feature map covers each
entry point and observable result; a passing HTTP response alone is insufficient.

## Cleanup

Each test releases and awaits its own handler in `finally`, closes its client
and store, and resets its manager. Copy evidence before removing this run's
`scratch` directory. Confirm the reports and database copies survive. Never
kill unrelated processes or delete the evidence directory.
