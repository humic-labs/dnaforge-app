# Protocol creation, frozen runs and observed inventory work

## Sub-features

- Create a native Protocol through Files and the generic scientific creation
  owner.
- Edit and Save its steps; Start run uses that saved definition and remains
  disabled while this editor has unsaved or invalid content or a save in flight.
- Recover the original Protocol/Run creation request after an uncertain or
  partial outcome.
- Select Protocol Run explicitly for a separately observed inventory transfer.
  Run creation and inventory preview move no stock.
- Read the saved run definition after later Protocol edits and restart.
- See newly registered Protocols and Runs immediately in Files, including
  creation outside the Files menu.

## User path

In a writable project's Files menu, choose New…→Protocol→Create, then enter a
Protocol title. The ordinary Protocol editor supports step titles/content and
Save. Start run opens a title form using the saved protocol source. An uncertain
creation offers Check original operation and Retry same operation. Those actions
preserve its request identity.

The Run view shows Protocol used from its saved definition. Source-declared
older runs remain explicitly distinguished when no saved definition exists.

Inventory's Record scientific transfer form explicitly selects Notebook page or
Protocol run. Kind, source or physical choices invalidate preview. Existing
Notebook drafts migrate to the Notebook kind. Recorded work retains its original
context and exact stock effects.

## Desktop driver

Capture a currentv24 fixture without changing raw inventory data, preserving the
completed Notebook work and cancelled candidate preview, then run:

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage protocol-run --fixture /absolute/evidence/current-fixture.json --out /absolute/evidence/protocol-run
```

The workflow creates the first real Protocol via Files, edits/Save a step,
starts a real Run and checks the frozen actual definition rather than trusting
an old declared version hash. Every creation/save stage checkpoints its native
identity/source before later assertions. These stages leave inventory unchanged.

Before any new physical action, the driver submits the original recorded
Notebook observation through the explicit V2 native request with a fresh
operation ID. It uses the original retained source hash rather than the
currently edited Notebook hash. The native owner must return no-change with
exact state/history and no new receipt. This step qualifies API compatibility;
it is not represented as a separate human form gesture.

The ordinary form then previews and records one10µL Run-linked manual transfer
into another genuinely empty permanent wellA2. It immediately checkpoints the
accepted inventory change before checking the source60µL/destination10µL
effects. A later independent Protocol edit must leave the Run's saved definition
and retained work source unchanged.

With Files already open, start a separate tracking Run from the later saved
Protocol. Its new row must appear without toggling or refreshing Files. Native
commit notifications invalidate only the affected mounted project's file tree.
This additional tracking record leaves inventory state and history unchanged.

Preserve failures and resume with protocol-run-resume and the latest exact
NN-protocol-run-checkpoint.json. Never repeat a creation under a new request ID
or reapply a completed physical step. After full native restart,
protocol-run-reopen requires exact state/history, original Notebook work,
current Protocol/Run identity, frozen source and original creation recovery.

## Limits

Run creation records an in-progress record. It does not execute equipment, move
stock, complete a biological procedure or establish produced material. Plate
plans, completion, additional context links and hardware execution remain
separate workflows.

## Recorded physical work read

Open an existing Run in Files. Recorded physical work lists the completed manual
transfers originally associated with that Run, separately from its saved Inputs
and Outputs. Amounts, source balances, destination aliquots, recorded principal,
time, reason and vessel locations are historical facts. View saved context reads
the original retained Run and frozen Protocol. Open current Run resolves its
current canonical project identity.

Loading, unavailable, absent inventory and a successful empty list are distinct.
Refresh and matching inventory-change events reload the first page. Next page
replaces at most20 rows; First page resets the cursor. A changed inventory
revision restarts pagination, and late responses cannot appear under another
Run. This read view has no inventory or scientific creation controls.

Reuse a completed currentv24 Protocol Run fixture; do not repeat its transfer:

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage run-recorded-work --fixture /absolute/evidence/protocol-run-reopen-fixture.json --out /absolute/evidence/run-recorded-work
node apps/desktop/scripts/inventory-journey.mjs --stage run-recorded-work-reopen --fixture /absolute/evidence/run-recorded-work/run-recorded-work-reopen-fixture.json --out /absolute/evidence/run-recorded-work-reopen
```

The driver opens the existing work-bearing Run, checks its10µL transfer and
historical70→60µL source balance, reads saved context, refreshes and follows
current-Run navigation. The separate existing tracking Run must return a real
successful empty list. Returning to the first Run and restarting preserve exact
state, history and all current Protocol/Run source snapshots. Native and agent
read-only qualification independently checks unchanged receipts and raw files.

## Additional saved citations

Each recorded-work card has Additional citations. Add saved citation selects an
existing saved Notebook page or Run, a source version and a reason. Preview is
read-only; Add citation saves supporting context independently of the original
work and primary source. View saved citation reads its retained copy; Open
current source resolves its present canonical identity.

Withdraw citation records a separate reasoned correction. Its original reason,
source and identity remain in history. Add citation again is an explicit new
generation pinned to that citation and withdrawal. Ordinary base duplicates
continue returning their original historical record, including after withdrawal;
they never restore it. A changed source needs an explicitly selected new saved
version. The source documents and physical work remain unchanged.

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage scientific-citations --fixture /absolute/evidence/run-recorded-work-reopen-fixture.json --out /absolute/evidence/citations
node apps/desktop/scripts/inventory-journey.mjs --stage scientific-citations-resume --fixture /absolute/evidence/citations/02-withdrawal-accepted-before-assertions-scientific-citations-checkpoint.json --out /absolute/evidence/citations-resume
node apps/desktop/scripts/inventory-journey.mjs --stage scientific-citations-reopen --fixture /absolute/evidence/citations/scientific-citations-reopen-fixture.json --out /absolute/evidence/citations-reopen
```

The first journey uses the existing work and edited saved Notebook. It captures
the native in-memory schema upgrade without writing, checks zero-write preview,
saves one citation, checks duplicate preview, then withdraws it. Every accepted
metadata action checkpoints immediately before later assertions. Resume uses
saved draft/operation identities and the original pending-request coordinator;
it never repeats physical work or invents a replacement accepted request.
Restart preserves exact state/history, retained source and both reasons. Native
qualification separately proves explicit reattachment generations, exact retries
and unchanged old receipts/source-file bytes.

To qualify the ordinary Add citation again control separately, use the exact
completed citation-withdrawal fixture. The source must still have the same saved
pin. The stage previews one explicitly pinned new generation and records it
once, preserving the withdrawn base and its correction:

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage scientific-citations-reattach --fixture /absolute/evidence/citations/scientific-citations-reopen-fixture.json --out /absolute/evidence/citation-reattach
node apps/desktop/scripts/inventory-journey.mjs --stage scientific-citations-reattach-resume --fixture /absolute/evidence/citation-reattach/04-reattach-accepted-before-assertions-scientific-citations-checkpoint.json --out /absolute/evidence/citation-reattach-resume
```

Its pre-submit checkpoint saves the child draft identity and exact predecessor
pins. An interrupted acknowledgement is inspected/retried through the original
pending operation or reconciled by that captured child identity; the driver
never creates another child to repair a later assertion. A base duplicate
preview must still show the original withdrawn citation after the child exists,
with no Add action or extra history. The ordinary citation reopen stage accepts
the explicit child proof and exact next revision, checks the active child and
withdrawn base, and performs no new writes.

## Explicit declarations and ordinary Run values

A clean, saved editable Protocol offers Edit input and output declarations. Add
or explicitly edit keyed input/output declarations, preview and Save
declarations. Existing saved types and keys stay fixed. Unsupported imported
types remain visible/read-only. Upserts preserve omitted rows and raw fields;
there is no deletion, reordering or implicit conversion.

Start run freezes exactly the saved declarations. Its actual arrays remain empty
until the user explicitly records values. Edit recorded values offers Record
value for a frozen declaration, and separate Add input value / Add output value
/ Add measurement for ordinary local entries. Measurements have no invented
Protocol requirement. Supported controls are Text, Number, Yes or no, and
explicit UTC Date and time. Unchosen boolean, invalid numeric/date input, zero,
false and recorded empty text remain distinct. Quantities, records and
attachments are preserved read-only; these entries do not bind a stock or
physical observation and do not complete the Run.

The ordinary Save and purpose editors share one canonical project/entity
operation owner. Check original save and Retry same save use the exact retained
request through native package receipt recovery. Unknown outcomes block a
competing save; source changes and navigation cannot silently replace a draft or
create fresh keys. Native measurement recordedAt is recording time, not an assay
timestamp.

Use the exact completed manual-plan fixture without repeating its inventory
operation:

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage run-values --fixture /absolute/evidence/plate-plan-observation-reopen-fixture.json --out /absolute/evidence/run-values
```

The real Files path creates a NEW Protocol, adds a required Text input and
Number output, explicitly saves declarations and starts a NEW Run. It records
text, numeric0, a local booleanfalse measurement and a local canonical UTC date
measurement in one values save. Unchosen boolean and an impossible date must
leave Save disabled before valid input is provided. A later Protocol LABEL edit
must leave the older frozen Run declarations/actuals intact.

Each create/edit/start/save request is checkpointed before submission; its
native ready result is checkpointed immediately before later assertions. Keep
failures and use run-values-resume with the latest exact checkpoint. After full
native restart run-values-reopen requires exact saved sources, keys, typed
values and frozen pin. Inventory99/all216 old operations and all older source
files remain unchanged; the NEW Protocol/Run files and native catalog/receipts
are intentional additions. Capture visible declaration/value controls and
outcomes with their sections scrolled into view, plus interaction video. This
workflow does not qualify exact physical-result attribution or a real assay.

## Saved Run values and recorded physical subjects

A clean saved Run offers **Saved values and recorded subjects** → **Associate
saved value**. Choose an exact saved field, a recorded plate-plan use, its
historical source or resulting aliquot, and a reason. Native candidates supply
the saved source and complete row pins. Preview changes no stock or metadata;
**Add association** saves only the assertion that this value describes this
subject. It does not establish consumption, production or scientific acceptance.

The detail separates the original saved value and original retained Run source
from a fresh comparison with the current Run. A normal typed value edit must
invalidate that comparison without requiring an inventory revision. Withdrawal
keeps original facts and reasons. Restoring matching source content never
reactivates a withdrawn assertion. **Associate again or correct** explicitly
creates a successor pinned to its attribution and withdrawal, within the same
Run file and field.

Inventory's **Saved value associations** lists unfiltered history, including
imported associations. It offers original evidence and source-free withdrawal
without requiring a currently available Run. Foreign sources are never resolved
through a local identifier suffix. Creation and correction stay on the clean
local Run; this history does not add a global Run chooser.

Use `run-value-attributions` with the exact completed typed-value fixture. The
ordinary workflow associates its numeric0 output with the older recorded A3
aliquot4µL, edits0→1 through the existing typed editor, observes old0/current1,
withdraws, restores0, verifies the base stays withdrawn and a fresh equivalent
base preview offers no Save, then explicitly adds a successor. Inventory
revisions100/101/102 contain only those three metadata changes; old216 journal
entries, physical state, other values and measurement recording times stay
exact. File edits have their separate native purpose receipts. Exact restored
source bytes are asserted only after reading them from the actual native owner.

Every file or inventory request is checkpointed before submission and its
accepted result immediately afterward. Preserve failures. Resume with
`run-value-attributions-resume` and the latest exact checkpoint; retain a live
prepared editor/request instead of regenerating identity or field keys. After a
full restart, `run-value-attributions-reopen` reads both generations, retained
source and unfiltered history without repeating accepted actions. Scroll each
claimed original/current/status section into view and preserve static images and
the interaction video.

## Explicit versioned-design setup prerequisite

An existing saved Run shows **Versioned designs** for its owning project. **Set
up versioned designs** explicitly creates the initial accepted identity history
through the existing scientific submission owner. It accepts no legacy files,
creates no DNA or stock and leaves inventory unchanged. A catalog head alone is
**accepted, publication unconfirmed**; **Finish setup** explicitly uses the
existing write-capable reconciliation owner. An unknown acknowledgement retains
its exact original request and offers **Retry same setup**, which may complete
that original acceptance. It never rebases an empty request onto a newer
accepted head.

Use `design-setup` with the exact completed attribution fixture. The ordinary
pointer path captures the setup request before submission and the accepted
result immediately afterward, verifies an empty scientific list plus delivered
format1 identity map, and retries the same operation. Files → New… → DNA
sequences → Create then creates one full empty managed package. Type explicit
short synthetic bases in the real sequence editor and use its ordinary Save;
read the exact accepted nonempty DNA revision and same-project material
projection. The existing native editor inspection is read-only proof of the
actual typed draft, never a setter or shortcut around those controls.

Retry the original setup again after the DNA advances the accepted head. The
original receipt version remains original while current head/design/format2 map
remain newer. Inventory102, all219 existing global journal entries, physical
state and old26 project files remain exact; the new scientific map/design,
accepted history and ordinary project-data publication are intentional
additions. Existing legacy objects keep their individual owners rather than
becoming implicitly accepted by this setup.

Preserve original media and checkpoints. `design-setup-resume` reuses the exact
retained setup request and reconciles a created design by its already captured
name/resource; it never creates another identity after uncertainty or appends
the same bases twice. After a full native restart, `design-setup-reopen` retries
only the original setup and reads the exact accepted design/current map. It
performs no new creation, sequence edit or inventory action. Capture static
states scrolled into view plus real pointer/typing video. This prerequisite does
not qualify physical DNA production, product identity verification or release.

## New local artifacts after versioned-design setup

Use `new-artifact-continuity` with the exact qualified design-setup fixture. The
maintained journey derives a current unaccepted local DNA target from the
project's actual material/catalog facts, opens it normally, selects its first20
bases through the real sequence controls and chooses **Create Forward Primer
→**. The existing drawer's **Save Primer** creates one complete file-backed
primer with that binding. It does not enroll or rewrite the older target.

The already acknowledged optional `relatedRecord` field belongs to the real
strain schema; this journey never repeats its schema Save. Files → New… →
Strains → Create uses **Choose Related record** and the existing Registry picker
to select that exact existing local DNA. The form preserves the complete native
relationship value and pins its actually loaded schema ID/revision before
**Create strain**. The saved artifact retains its schema snapshot, structured
field and schema-field `references` link. It does not turn that Registry link
into biological ancestry or accepted scientific evidence.

Checkpoint the original visible input, target/source hash, live creation ID and
actual schema pins before each Save. Read/checkpoint the original source file
and native projection IDs immediately before later assertions. Preserve the live
form/recovery input if a result is uncertain; read the original output path
before retrying and never create a replacement name/identity for a screenshot.
`new-artifact-continuity-resume` reconciles already written original artifacts;
`new-artifact-continuity-reopen` reads the same IDs/full files/relationships
after restart without creating either artifact again.

Inventory102/all219 existing global requests/receipts, old physical facts, the
selected older DNA source and the accepted24-base design/revision remain exact.
The two new artifact files and their normal Registry/catalog/binding/history
projections and derived exports are intentional data changes; this does not
claim zero SQL or all32 project files unchanged. Capture the selected link
itself and Attached primer row scrolled into view, with genuine pointer
interaction video. Normal readback/restart proof does not claim an actual
lost-acknowledgement injection; focused existing-owner file/SQLite tests qualify
that separate boundary.

### Completed manual production

From a clean saved Run, use **Record completed production** to select an
existing accepted nonempty DNA design, existing input stocks and explicit
amounts, an empty output vessel, a measured output amount, batch name,
preparation method and reason. Choose the completed manual outcome and preview.
The preview must show the exact design, saved Run, every input before/after,
measured product and initial unassessed batch/quarantined stock. Cancel leaves
inventory unchanged. Refreshing or paging design candidates preserves the
explicitly selected revision; a later saved Run change requires an explicit
source choice and a new preview.

Record only an already completed preparation. One accepted report consumes its
specified inputs and creates one prepared managed batch and quarantined stock in
one inventory revision. It does not create a DNA design, change a Run, infer
quantities from Run values, release the product or operate equipment. A partial
or uncertain physical outcome cannot be recorded through this form.

An uncertain acknowledgement keeps the original report and request. Use
**Confirm original production report** or **Retry original production request**.
A matching committed receipt and an exact already-recorded business result are
separate outcomes; neither permits a second debit. A fresh duplicate with no new
operation receipt is resolved only by the exact original production and choices.
Missing evidence remains uncertain.

Use **Recorded productions** on the Run or **Saved productions** in Inventory
for bounded history, exact original stock/batch facts and **View saved
production sources**. Retained accepted DNA and Run sources remain historical
after later source edits or removal. Current navigation is separate and
unavailable for foreign history. First/Next pages replace the displayed rows;
unavailable reads must not appear as empty history.

Qualify the first form through an ordinary preview-and-Cancel pilot before
adding an accepted-report journey. Preserve genuine visible
Ready/initial-quality captures and native before/after state; then checkpoint
the exact report identity/request before recording and the accepted result
immediately afterward. Restart and duplicate checks repeat no physical report.
Lower-layer acknowledgement fault injection is distinct from normal desktop
acceptance.
