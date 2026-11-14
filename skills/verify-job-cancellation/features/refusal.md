# Preserve noncancelable execution

## Sub-features

Both authenticated job routes reject unsupported cancellation. The job manager
also protects the same execution contract for in-process callers.

## How to get to it (user POV)

Request cancellation on a job whose tool does not support it.

## Driving it with pytest

Run `test_noncancelable_request_preserves_execution` for `/jobs` and `/mcp/jobs`.
Expect 409, no cancellation signal, a live owner and its eventual success.

## Gotchas

The caller must own the job. Existing route authorization checks remain part of
the focused compatibility run; this recipe uses synthetic authorized identities.
