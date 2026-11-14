# Recover a completed tool

## Sub-features

Renderer success survives a late transport failure, including bounded audit
projections. A later sidecar can recover the same outcome from SQLite.

## How to get to it (user POV)

Call a renderer tool through the agent tool service, then lose its response.
Read the original job instead of repeating the work.

## Driving it with pytest

Run `test_renderer_success_survives_late_transport_failure` and
`test_bridge_recovers_committed_result_after_lost_response` in
`tests/test_tool_settlement.py` using the skill's drive command.
Expect a completed job and unchanged durable outcome after reopening the store.
`test_legacy_completion_metadata_migrates_once_without_changing_outcomes` in
`tests/test_action_completion.py` also proves old databases migrate once without
changing prior results.

## Gotchas

A projected result is intentionally bounded. Its full response is available
only for live delivery; reopening must preserve the projection, not recreate
discarded data. The harness substitutes the external renderer transport.
