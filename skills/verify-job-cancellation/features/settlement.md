# Preserve the actual completion

## Sub-features

A handler that completes despite a stop request remains successful. Failed
cleanup remains a failure. Losing renderer transport remains unresolved until
the renderer owner reports the actual result.

## How to get to it (user POV)

Request stop while a tool is finishing, then inspect the job's retained result.

## Driving it with pytest

Run `test_completion_wins_a_racing_cancel_request`,
`test_cleanup_failure_is_retained_after_cancel_request` and
`test_transport_cancellation_keeps_renderer_outcome_unresolved`.
Use the skill's managed-operation comparison to verify the same principle:
request intent never replaces actual settlement.

## Gotchas

The legacy job owner is an asyncio handler. External engine cancellation has
its own owner; stopping observation does not establish that its work stopped.
