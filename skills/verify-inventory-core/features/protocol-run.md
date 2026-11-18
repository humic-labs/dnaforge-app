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
