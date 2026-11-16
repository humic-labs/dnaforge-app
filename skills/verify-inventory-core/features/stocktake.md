# Stocktake observations and corrections

## Acceptance boundary

Native HTTP and file-backed SQLite acceptance passed for record-only and later
application, quantities below active holds, checked-out custody, missing/found,
late permanent-well refusal, lost response, archive adoption and exact restart
recovery. A captured v13 table inventory and v11 source history replayed with no
stored state or journal changes.

The real desktop retained a 60 µL hold while accepting a 40 µL measurement,
preserved checked-out custody and recorded a separate unapplied observation.
Later application, missing/found at an explicit new destination and subsequent
use left 63 µL with the same hold. Reimport did not repeat corrections. An
invalid permanent-well correction refused the whole proposal. Full desktop
restart retained exact state, history, archive bytes and duplicate prevention.
An incomplete reason kept its correction field visible and applying disabled.

Original video, screenshots, failed attempts, source files and receipts are
under
`/Users/peterciaccia/projects/.agent-evidence/DNA-3198-inventory-stocktake/20261116/`.
Desktop input used explicit pasted text; native file dialog selection remains
unqualified. Software observations do not establish physical sample handling.

The workflow consumes a declared stocktake format with explicit subjects and
decisions. It does not interpret a changed receive register as a measurement,
infer missing stock from omitted rows, release holds or correct a plate through
one of its permanent wells.

## Natural task

Create a hold on known stock. Import an explicit quantity observation below the
held amount. Inspect a preview showing the measurement, current quantity,
remaining hold and resulting allocation shortfall. Apply it once. Verify the
measured quantity changed, while custody and the exact hold remained intact.

Record a quantity observation without applying it. Verify its immutable facts
and source time are retained while stock quantity and custody are unchanged.
Later apply that recorded observation explicitly. Reusing its identity after
consumption must not repeat the correction. Repeated physical measurements need
new observation identities.

Report an explicit physical item missing, then locate it at an explicitly
selected valid destination using a separate observation. Preserve quantities,
holds, responsibility and location history. Observe a permanent well's stock
quantity independently; refuse an attempt to give that well independent custody.
An item observation names the item itself rather than silently choosing an
ancestor.

Block unresolved subjects, row decisions, destinations, conflicting observation
identities and stale target revisions with zero effects. Preserve exact source
bytes. The whole proposal uses the existing atomic journal and command bound. An
invalid late correction leaves every observation and correction unapplied.

Lose the acknowledgement, fully restart the owner and recover its original
receipt. Reimport the observations without repeating corrections. Export, adopt
and reopen the inventory; immutable observations and application actors retain
source attribution, while imported people gain no acting authority.

## Source contract

The strict CSV/TSV columns are `observation_id`, `subject_key`, `observed_at`,
`quantity_kind`, `quantity`, `unit`, `presence`, `location_key`, `slot`,
`reason`. Every column occurs exactly once. Unknown columns, malformed quotes,
wrong row widths and duplicate observation identities refuse.

Quantity observations explicitly target stock. They use known or unknown
quantity and `presence=not-observed`, with empty location fields. Presence
observations explicitly target a physical item. They use
`quantity_kind=not-observed`, empty quantity/unit and `presence=missing` or
`found`. Found observations resolve an explicit destination. Missing
observations have empty location fields. Reasons are required.

Source time is `unknown` or an exact UTC ISO timestamp with milliseconds. It is
separate from trusted native recording time. The stable namespace and
observation ID identify a measurement; source hashes and row numbers do not.
Explicit row decisions are record only, apply the observed correction, or skip
with a reason.

## Evidence

Keep original captures, video, receipts, failed attempts and source artifacts
outside the checkout. Software observation records do not establish that anyone
physically measured, found or handled a laboratory sample.
