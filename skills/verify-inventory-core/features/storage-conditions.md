# Storage-temperature facts and requirements

## Scope

The native and desktop journeys exercise the recorded-fact workflow below. This
software comparison does not establish live monitoring, continuous temperature,
hardware control or overall sample suitability.

## Executable journeys

`apps/desktop/scripts/inventory-journey.mjs` provides `conditions` for a legacy
inventory fixture, `thermal-context` for the captured v10 transition,
`conditions-catalog-recover` for an explicitly captured catalog-selection
continuation, and `conditions-reopen` for exact state/history after restart.
Keep failed attempts and their captured accepted prefixes.

`inventory-native-acceptance.test.ts` drives authenticated loopback HTTP and a
file-backed database, including grant denial, lost acknowledgement and reopen.
`inventory-legacy-profile-acceptance.test.ts` additionally accepts
`INVENTORY_LEGACY_PROFILE_SOURCE`, a local manifest naming an owned database
copy and original profile. It replays the captured legacy journal and retries
every original receipt while checking zero changes to raw stored bytes. Neither
helper establishes physical freezer performance.

## Sub-features

- Keep specified operating range, reported setpoint and installed qualification
  separate from formulation requirements.
- Record exact signed Celsius and inclusive ranges, with explicit unknowns.
- Preserve scoped source claims and explicit withdrawal/conflict evidence.
- Inherit lot requirements or explicitly override stock requirements.
- Derive independent capability, reported-target and qualified-support results.
- Preserve stock, quality, holds, custody and placement when recording facts.
- Keep thermal relationship independent: inherit surroundings, own control, or
  unknown. Evidence changes never change that relationship.

## Driving the real workflow

Use the owned background scenario profile and existing physical inventory.
Choose a stock/container and its storage environment. Record a lot or stock
temperature requirement and an operator-reported target with explicit known or
unknown observation time. Inspect independent results and their source scope.
Never call a target report a measured chamber temperature.

Record source capability and exact-installed qualification with declared
setpoint and assumptions. Require qualification to use the complete envelope,
not overlap alone. Metadata-only edits retain applicability; relevant physical
or setpoint changes make old evidence inapplicable without deleting it.

Record conflicting applicable source claims, then withdraw one with a reason.
Require conflicting/unknown evidence to remain explicit. Lot inheritance,
explicit unknown and a stock requirement are distinct. Moving a whole holder
recomputes context without rewriting descendant quantities or requirements.
Checkout/transit/missing must not inherit a former freezer as current storage.
Declare a controlled inner holder explicitly, then withdraw its only evidence.
It must remain its own environment with unknown comparisons. Explicit Unknown
blocks a supported ancestor; only explicit Inherit restores ancestor context.
New qualifications pin these relationships alongside physical arrangement. Read
and replay a captured v10 profile without rewriting any stored state, request,
receipt or journal row; legacy qualifications retain unrecorded scope.

Record a mismatching reported target without changing quality, quantity, holds
or custody. Follow-up quality decisions remain ordinary explicit commands.
Unknown custom storage remains usable without an acknowledgement gate.

Stop and restart the native app using the same profile. Require exact state,
complete accepted history, sources, pins and assessments. Preserve original
screenshots/video, native values, failed attempts and source-bound receipts.

Focused native/domain checks cover exact negative decimals, inclusive bounds,
explicit freshness policy, unknown observation times, current read-only grants,
scope denial, zero-write absent reads, atomic rollback, trusted recorded
context, lost acknowledgement recovery and frozen historical request/snapshot
bytes.

## Gotchas

- Advertised range, reported target, qualified envelope and a sensor reading
  answer different questions.
- A type/source URL is not installation qualification.
- A passed temperature comparison is not overall material suitability.
- Manual reports do not become live telemetry through read time or timers.
- A mismatch does not silently quarantine stock or release a reservation.
- Material-definition defaults require their own accepted scientific revision;
  the first requirement owner is stock/lot inventory.
