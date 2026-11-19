# Agent structure work on protein inspections

## Sub-features

- An agent reads the scene of, and photographs, a protein inspection tab that is
  not selected in its pane. The selected tab never changes.
- An inspection tab shows one protein and retains the others it inspected
  before. An agent reads, photographs and edits a retained protein without
  changing the displayed protein; the edit is kept with that protein.
- When the person shows the retained protein again, its view has the agent's
  edit.
- Before the first command, `mol_get_state` reports these views `inactive` with
  a reason that says commands render them in the background, and no instruction
  to call `mol_activate_view`.

## How to get to it (user POV)

Open a sequence, inspect the protein of one coding region, then inspect a second
coding region of the same sequence, and keep another tab selected in the
inspection pane while an agent works on the first protein.

## Driving it with Playwright

Launch the app as described in the parent skill, then run:

```sh
node apps/desktop/scripts/inspection-structure-agent-journey.mjs --out "$HOME/DNAForge-proof/inspection-structure"
```

The helper applies the `structure-thrl` development scenario, opens the thrL
inspection through `mol_open_drawer` and the inspection opener, opens a page tab
over it, and calls the agent structure commands on the unselected inspection. It
then inspects the second coding region, works on the retained thrL protein,
recolors it, inspects thrL again and requires the recolored scene. It keeps
every capture and `receipt.json`.

## Gotchas

The scenario needs the scenario mutation flag from the parent skill's launch
command, a ready sidecar and network access to the AlphaFold database for
UniProt P0AD86. The helper finds tabs by state, so start from a fresh app
instance. Background views draw a fixed 768-pixel square.
