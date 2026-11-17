# Actual delivery receiving

## Sub-features

- Retain an original text document or explicitly scoped text excerpt with the
  actual delivery identity. Supplier, packaging batch and component batch remain
  separate facts.
- Choose every component's physical disposition. Identified material requires a
  current scientific identity, an explicit supplier-lot decision, amount basis,
  local stock quality and destination. A new supplier lot awaits local
  assessment.
- Preview the entire immutable admission and receive it in one existing native
  transaction. A repeated delivery identity cannot replenish current stock.
- Inspect original received amounts beside current remaining amounts and read
  retained source text through the native document owner.

## User path

Open Inventory, select the project and choose **Receive delivery**. Keep the
actual Delivery ID when presenting the same arrival again. The generated local
ID persists with the recovery draft; it is independent of supplier lot, order
and operation IDs. It cannot detect one physical delivery deliberately entered
under another ID.

Enter the observed scope, retain the original text and choose full-document or
excerpt coverage explicitly. Each listed component has one disposition:
identified material, unidentified physical vial, unobserved physical contents,
observed missing, or evidence only. A label alone does not create a vessel.
Optional package grouping records historical arrival grouping, not placement.

For identified material, select a current scientific material and a new managed
supplier lot, an existing matching lot with a mapping reason, or explicit
unattributed provenance. A new lot uses the known Supplier and Component batch
facts directly. Unknown supplier/batch must remain unknown rather than a
fabricated lot. Enter a measured amount or an unknown amount with its supported
unit, separate amount reason, local stock quality/reason and explicit location.
Supplier QC text cannot release a lot or stock.

**Preview complete delivery** changes nothing. A ready preview shows the entire
plan before **Receive delivery atomically**. Editing any draft field invalidates
that preview. An uncertain acknowledgement uses the existing saved-operation
recovery; changing an operation or delivery ID is not recovery.

## Desktop driver

Capture an exact current native v21 state/history fixture with the read-only
`refresh-fixture` stage, then run:

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage arrival --fixture /absolute/evidence/current-fixture.json --out /absolute/evidence/arrival
```

The first workflow retains a synthetic supplier excerpt, receives 1 mg into a
new managed/unassessed lot, explicitly releases that lot, then uses 100 µg. It
must show 1000000 ng originally received beside 900000 ng currently remaining.
Re-presenting the persisted delivery must preview already-recorded, disable
receiving and leave state/history unchanged. Native retained-document readback
must return the exact original entered text.

Each accepted step immediately writes `NN-arrival-checkpoint.json`. Preserve
failed captures and resume in a new directory with `--stage arrival-resume` and
the exact checkpoint. State/history must match before the helper proceeds; it
never repeats a completed intent. After a full native restart,
`--stage arrival-reopen` consumes `arrival-reopen-fixture.json` and requires
exact state/history, original/current amount parity and original document
readback.

For a second actual delivery, keep the app running and use the completed first
fixture with `--stage arrival-components`. It records one new package containing
an identified 2 mg reagent and a physical unidentified companion vial in exactly
one additional operation. Packaging and reagent component batch IDs must stay
distinct. The companion has an explicit unidentified contents observation and no
fabricated stock record. All prior stock/history remains exact. The second
delivery also previews no-change on repetition; both original documents remain
readable, with the first arrival still showing 1 mg originally received and
900000 ng currently remaining.

This phase writes an immediate `01-arrival-components-checkpoint.json` after
acceptance. A failed capture uses `--stage arrival-components-resume` with that
exact checkpoint; it cannot repeat the second receipt. A final full native
restart uses `--stage arrival-components-reopen` with
`arrival-components-reopen-fixture.json` and proves both arrivals together. Do
not use the earlier three-operation revision assertion after the fourth receipt.

Supplier claim controls and binary document selection need their corresponding
real workflow evidence before being described as qualified. Focused renderer
checks prove only form/session contracts; native HTTP/SQLite and actual desktop
evidence establish persistence and recovery.
