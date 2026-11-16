# Plates, tube boxes and ordered stacks

## Sub-features

- Create explicit named/grid/tube-box/permanent-well/stack layouts.
- Receive stock into permanent wells without creating movable tube identities.
- Move whole plates while retaining every well identity and local position.
- Push/pop in order, refuse buried-item removal and dispose plates as
  aggregates.

## How to get to it (user POV)

Open Inventory, select a project and choose **Add location**. The **Position
layout** control selects the actual layout model. Select a plate in the tree,
then a well to inspect its contents status. Choose **Receive stock** in the well
drawer when it is declared empty. **Move location** moves the plate; **Dispose
plate** disposes the whole plate and every well. Select a stack to inspect its
occupied order.

## Driving it with Playwright and Electron

With the owned isolated app and earlier workspace fixture, run:

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage layouts --fixture /absolute/evidence/journey/reopen-fixture.json --out /absolute/evidence/layouts
```

The workflow creates a two-position ordered stack, two2×3 fixed-well plates, and
a2×3 tube box. It verifies six permanent well identities, receives25µL intoA1,
confirms the well has no independent Move/Dispose action, pushes two plates, and
refuses removal of the buried plate with exact unchanged state/history. It
removes the top plate, disposes the remaining plate as a whole, and reads25µL
retained as historical disposed stock with all six wells disposed.

Keep original PNG captures and the interaction movie, original
frames/timestamps, source hashes, native state and journal readback. Pure
layout/migration tests separately cover incompatible tube positions, overflow,
occupied destinations, identity collisions, and atomic rollback.

## Gotchas

- Wells belong permanently to a plate. Empty well and empty movable tube are
  different.
- Stack order comes from child placement, with one contiguous occupied prefix.
  No second list stores a competing order.
- Top-only removal describes retrieval order. Recording stock quantity does not
  prove physical access to a buried sample.
- These layouts establish logical compatibility. They do not qualify freezer
  dimensions or vendor equipment fit.
