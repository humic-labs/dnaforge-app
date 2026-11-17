# Request cancellation and observe cleanup

## Sub-features

Delayed cleanup remains active, repeated stop requests do not interrupt cleanup
again, and canceling a queued job never invokes its handler.

## How to get to it (user POV)

Delete `/jobs/{job_id}` or `/mcp/jobs/{job_id}`, then read the same job and its
events. A 204 response acknowledges the request; it does not prove cleanup.

## Driving it with pytest

Run `test_cancel_waits_for_cleanup_and_emits_one_terminal_event` for both routes
and `test_cancel_before_runner_entry_never_starts_handler` in the acceptance
file. While cleanup waits, the owner and pool slot remain live and SQLite has
no completed outcome. After acknowledgment, exactly one terminal stream event
and one durable canceled outcome appear.
`test_human_collection_keeps_stopping_job_active` and
`test_cancel_pool_waiter_never_enters_its_handler` in the compatibility file
cover the human job collection and a canceled pool waiter.

## Gotchas

Legacy clients recognize `queued` and `running` as active wire states. The
explicit internal `stopping` phase projects to `status: running` with
`cancelRequested: true`; that field disappears after settlement. It is derived
from the phase, not independently writable request state.
