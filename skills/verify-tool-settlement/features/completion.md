# Keep one terminal outcome

## Sub-features

Identical renderer completion reuses the original audit ID. A conflicting
renderer completion or job writer cannot replace a settled result.

## How to get to it (user POV)

Retry a completion notification after a response is lost, then read the job.

## Driving it with pytest

Run `test_duplicate_and_conflicting_completion_preserve_first_outcome` in
`tests/test_tool_settlement.py`. The duplicate returns the same audit ID;
the conflicting route is rejected and a late job write leaves SQLite unchanged.

## Gotchas

An unresolved observation is recoverable and is not a settled failure. The
completion owner can replace it with a real outcome.
