# Agent structure work on an unselected tab

## Sub-features

- With two structure tabs in one pane, an agent reads the scene, recolors,
  selects residues, focuses the camera and takes screenshots of the tab that is
  not selected. The selected tab never changes.
- The unselected tab renders in a hidden background renderer. `mol_get_state`
  reports it active while that renderer runs; before the first command it is
  `inactive` with a reason that says commands render it in the background and no
  instruction to call `mol_activate_view`.
- When the person selects the tab, its pane shows the agent's edits and the
  background renderer is released.
- At most two background renderers run at once, and each is released after a
  minute without agent commands.

## How to get to it (user POV)

Open two protein structures in the same pane and keep looking at one of them
while an agent asks DNAForge to inspect, recolor and photograph the other.
Select the other tab afterwards to see the agent's result.

## Driving it with Playwright

Launch the app as described in the parent skill, then run:

```sh
node apps/desktop/scripts/unselected-structure-tab-journey.mjs --out "$HOME/DNAForge-proof/unselected-structure"
```

The helper copies four public structure fixtures into a scratch workspace under
the evidence directory and calls the same renderer structure commands the agent
tools use. It requires the commands on the unselected tab to succeed without
changing the selected tab, two differing agent screenshots, one hidden renderer
while the agent works, the agent's color mode after the person selects the tab,
no more than two hidden renderers while three unselected tabs are photographed,
and none after a minute idle. It keeps every capture and `receipt.json`. The run
takes about two minutes because of the idle wait.

## Gotchas

The helper imports renderer modules from the development server, so it needs the
source-mode app, not a packaged build, and a fresh app instance: it finds tabs
by their labels. The hidden renderer draws a fixed 768-pixel square, so
background screenshots have that size rather than the pane's.
