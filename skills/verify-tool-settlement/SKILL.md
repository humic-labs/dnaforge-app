---
name: verify-tool-settlement
description: Verify DNAForge sidecar tool completion through authenticated renderer audit routes, job execution and durable SQLite recovery. Use when changing tool completion ownership, transport recovery or result persistence.
---

# Verify tool settlement

## Launch

From `apps/api`, install dependencies with `uv sync --frozen --extra dev`.
The drive below starts the real FastAPI application in its in-process HTTP
harness. Each case owns a temporary SQLite database and fresh job manager;
there is no listening port, desktop window, external service or shared profile.
An existing compatible virtualenv can supply `python` without modifying it.

## Doctor

From `apps/api`, run:

```sh
python -c 'from pathlib import Path; import src.main; print(Path(src.main.__file__).resolve()); print(src.main.app.title)'
```

Confirm the source path belongs to the checkout being verified. The test fixture
provides a synthetic launch session; never supply a real desktop credential.

## Drive

Choose an evidence directory outside the checkout, then run from `apps/api`:

```sh
python -m pytest --no-cov -q -o tmp_path_retention_policy=all tests/test_tool_settlement.py tests/test_action_completion.py --basetemp="$SETTLEMENT_EVIDENCE/scratch" --junitxml="$SETTLEMENT_EVIDENCE/results.xml" > "$SETTLEMENT_EVIDENCE/transcript.txt" 2>&1
```

Read the exit code and transcript. The feature map identifies each observable
contract. This harness dispatches real registered tools and sends authenticated
HTTP requests to `/mcp/renderer-audit`. Only the renderer process and managed
compute execution are substituted at their existing handler boundary; route
validation, job admission, persistence, projection and recovery are real.
This verifies the sidecar contract, not the desktop renderer or scientific
compute results.

## Evidence

Preserve the transcript, JUnit report, source commit (`git rev-parse HEAD`) and
working diff. Copy the synthetic SQLite files from `scratch` into a separate
`databases` evidence subdirectory before cleanup. The cases inspect the committed action, audit IDs and result after
reopening SQLite, as well as the client-visible job snapshot. Preserve baseline
failures alongside successful runs; never replace them with a passing rerun.

## Cleanup

Pytest closes its clients and each fixture closes its own SQLite store. No
server process survives. Remove only this run's `scratch` directory after
capturing failures. Confirm `results.xml` and `transcript.txt` remain readable.
Do not delete the evidence directory.
