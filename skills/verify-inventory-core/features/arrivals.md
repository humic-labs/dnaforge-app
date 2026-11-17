# Actual delivery receiving

## Sub-features

- Retain exact original PDF, text, CSV or JSON documents with explicit full or
  excerpt coverage and the actual delivery identity. Supplier, packaging batch
  and component batch remain separate facts.
- Cite supplier quantity, quality, identifier and date statements against their
  original document and delivery, package or component subject. Supplier
  evidence remains separate from local stock quality, lot assessment and
  validity.
- Choose every component's physical disposition. Identified material requires a
  current scientific identity, an explicit supplier-lot decision, amount basis,
  local stock quality and destination. A new supplier lot awaits local
  assessment.
- Preview the entire immutable admission and receive it in one existing native
  transaction. A repeated delivery identity cannot replenish current stock.
- Inspect original received amounts beside current remaining amounts and read
  retained original bytes through the native document owner.

## User path

Open Inventory, select the project and choose **Receive delivery**. Keep the
actual Delivery ID when presenting the same arrival again. The generated local
ID persists with the recovery draft; it is independent of supplier lot, order
and operation IDs. It cannot detect one physical delivery deliberately entered
under another ID.

Enter the observed scope, paste exact original text or select an original file,
and choose full-document or excerpt coverage explicitly. Each listed component
has one disposition: identified material, unidentified physical vial, unobserved
physical contents, observed missing, or evidence only. A label alone does not
create a vessel. Optional package grouping records historical arrival grouping,
not placement.

For identified material, select a current scientific material and a new managed
supplier lot, an existing matching lot with a mapping reason, or explicit
unattributed provenance. A new lot uses the known Supplier and Component batch
facts directly. Unknown supplier/batch must remain unknown rather than a
fabricated lot. Enter a measured, supplier-declared or unknown amount with its
supported unit, separate amount reason, local stock quality/reason and explicit
location. A supplier-declared amount selects an existing quantity statement for
that same component. The native preview requires exact supported-unit equality.
An unsupported supplier activity unit remains evidence and cannot become a mass
or volume conversion. Supplier quality text cannot release a lot or stock.

**Add supplier statement** records an explicit subject, document, quotation and
statement type. PDF citations require a page and region and remain visibly
operator-cited; they do not assert text extraction. Text citations use the exact
selected occurrence and UTF-8 byte positions. JSON citations retain their source
pointer and original number spelling. Changing a document invalidates its old
statement links and the delivery preview.

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

## PDF evidence desktop driver

Use an exact current v22 state/history fixture from the owned arrival and
stockroom profile. Keep its previously saved text delivery draft intact, then
run:

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage arrival-evidence --fixture /absolute/evidence/current-fixture.json --out /absolute/evidence/pdf-arrival
```

Before starting a new delivery, the driver observes the existing text delivery
ID, exact source text and second-component label through ordinary controls.
These facts must survive the saved-draft version migration without receiving
that delivery again.

The new delivery selects a small synthetic PDF through the standard renderer
file input. It records full-document coverage, separate packaging and component
batches, and component-specific supplier quantity, quality and date statements
with operator-cited PDF regions. The received 2 mg amount uses the matching
supplier quantity statement. Supplier quality and dates create no local release,
opening or validity decision. The new managed lot must remain unassessed until a
separate local release action. After that action, using 100 µg must leave
2000000 ng originally received beside 1900000 ng currently remaining.

The original PDF is preserved in the evidence directory. Native document
readback must match its exact bytes and hash. Re-presenting the persisted
delivery must preview no-change, disable receiving, preserve current stock and
leave state/history unchanged. Recorded supplier quotations and their PDF
citation classification remain visible.

Each accepted action writes `NN-arrival-evidence-checkpoint.json` as soon as its
native revision is observed, before later UI assertions or captures. Preserve
failed attempts and use `--stage arrival-evidence-resume` with that exact
checkpoint in a new output directory. It refuses state/history drift and never
repeats an accepted action. After a full native restart,
`--stage arrival-evidence-reopen` uses `arrival-evidence-reopen-fixture.json`
and requires exact saved state/history and retained binary readback without a
new inventory action.

This workflow qualifies standard renderer file-input selection, not interaction
with an operating-system file chooser. It does not establish PDF extraction,
OCR, live supplier fetching or automatic expiry interpretation. Browser recovery
storage may reject a file below the native whole-request limit; that failure
must block preview and submission rather than bypass saved-operation recovery.
Focused renderer checks establish form/session contracts only. Claims about
binary persistence and restart need their actual desktop receipts.

## Exact text and JSON evidence

Continue from the exact completed PDF fixture with
`--stage arrival-evidence-text`. The driver selects a UTF-8 text file containing
a multibyte character, CRLF line endings and two occurrences of `1 mg`. It
selects the second occurrence through the ordinary read-only source text area.
Native recorded evidence must point to that exact original UTF-8 byte range;
normalized text-area line endings cannot shift the recorded range to another
occurrence.

A second original JSON file contains numeric `1.00` and a component batch. A
quantity statement at `/amount` must preserve `1.00` as its source spelling; an
identifier statement at `/batch` must retain the exact component-batch value.
All three statements name the same explicit component. Its supplier quantity
basis selects the text statement. Receiving the two-document delivery creates
one new 1 mg stock and an unassessed managed lot in one operation. Earlier PDF
stock remains 1900000 ng, with its independent local release unchanged.

The exact original text and JSON bytes are preserved beside the receipt and read
back through the native document owner. Both have exact-text-selection
verification; the earlier PDF retains operator-cited-region verification.
Repeated preview is no-change. `--stage arrival-evidence-text-resume` uses an
exact `NN-arrival-evidence-text-checkpoint.json` and cannot repeat the saved
delivery. The final `arrival-evidence-reopen-fixture.json` preserves both
phases.

After a full native restart, `--stage arrival-evidence-reopen` with that latest
fixture checks exact state/history, all three original documents and both
arrivals' independent current amounts. If the later stockroom correction phase
has completed, pass its latest fixture retaining
`stockroomCorrectionsJourney.completedStep=6`. The restart checks immutable
arrival facts independently from those explicitly recorded later matching/rule
changes; neither phase's original revision is rewritten.
