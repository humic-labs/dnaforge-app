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
