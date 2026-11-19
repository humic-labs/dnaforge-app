# Resizing the split sequence viewer

## Sub-features

Check the initial position of the stadium, the width of the lower map after a
window resize, and the position of the map when the divider moves.

## How to get to it (user POV)

Open pUC19 in Files. Use the stacked view with the wrapped sequence above the
map and the stadium shape selected. Start with the default camera and a fresh
document view.

## Driving it with Playwright

Use the parent skill's isolated desktop launch. Run the journey from the
repository root with a fresh output directory.

```sh
node apps/desktop/scripts/split-plasmid-map-journey.mjs --out "$HOME/DNAForge-proof/split-map"
```

Compare the lower map with the available width under the sequence and the
actual height from the divider to the bottom of the pane.

1. Capture the opening view. Check that the canvas fits the lower pane and
   that the overview stadium is visible and centered within it.
2. Narrow and widen the native window. Check both panes and the drawn map at
   each width.
3. Drag the divider marked `sequence-minimap-resize-handle` up and down.
   Check the canvas and stadium during the drag and after releasing it.
4. Resize the native window again after releasing the divider. Check against
   the width of the upper sequence pane. Restore the original window size.

Keep the screenshots, recording and measured bounds for each step with the
tested revision. Follow the parent skill's cleanup instructions.

## Gotchas

The lower pane and its canvas can agree on a stale width. Measure the upper
pane independently. A file with saved zoom, shape or pane settings can reopen
at a different camera position from the default overview.
