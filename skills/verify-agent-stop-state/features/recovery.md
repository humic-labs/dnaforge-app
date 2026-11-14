# Recovery

## Sub-features

Legacy record migration, stale stopping recovery, database reopen and repeated
recovery without duplicate terminal events.

## How to get to it (user POV)

Reopen the app after it exited while a Stop request was outstanding. Existing
profiles may also contain completed observations stored as `stop_requested`.

## Driving it with Vitest

Run the skill's Drive command. The migration case seeds legacy records and runs
the real schema initializer twice, with a file reopen between runs. It requires
only status to change: active records become `stopping`, records with a terminal
timestamp become `stop_unconfirmed`. The recovery case constructs the real
manager over a reopened database. It requires one final timestamp, one terminal
event with reason `stop_unconfirmed`, and stable state on another restart.

## Gotchas

Seeded legacy and crash records are deliberate boundary inputs. Schema migration
must not emit new terminal analytics for historical completed records or alter
their original timestamps and content.

The separate versioned migration case opens a schema 47 file through
`ensureSchemaForBuild`, verifies refusal when migration is disallowed, then
upgrades through the existing authorized route and reopens without repairs.
