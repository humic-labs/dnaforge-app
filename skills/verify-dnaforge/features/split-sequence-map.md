# Resizing the split sequence viewer

## Sub-features

Check the initial position of the stadium, the width of the lower map after a
window resize, and the position of the map when the divider moves.

## How to get to it (user POV)

Open pUC19 in Files. Use the stacked view with the wrapped sequence above the
map and the stadium shape selected. Start with the default camera and a fresh
document view.

## Driving it with Playwright

Use the parent skill's setup with a free renderer and debug port. Start the
desktop against a fresh profile and workspace from the repository root.

```sh
session_dir=$(mktemp -d "$HOME/split-map.XXXXXX")
git init -q "$session_dir/workspace"
ELECTRON_CLI_ARGS=$(node -p 'JSON.stringify(["--user-data-dir=" + process.argv[1] + "/profile", "--workspace=" + process.argv[1] + "/workspace"])' "$session_dir") \
  DNAFORGE_BACKGROUND_WINDOW=1 pnpm --dir apps/desktop dev
```

Open Files in that window. In a second terminal, use the same session path
and a fresh output directory. The journey opens a new copy of pUC19.

```sh
node apps/desktop/scripts/split-plasmid-map-journey.mjs \
  --session "$session_dir" --out "$session_dir/captures"
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

### Switching the split direction

Open Files in the isolated project. Run the orientation journey with the same
session and a fresh output directory. It closes the disposable session’s tabs
and opens a fresh copy of pUC19 through Files.

```sh
node apps/desktop/scripts/split-orientation-journey.mjs \
  --session "$session_dir" --out "$session_dir/switch-captures"
```

Each click switches the wrapped sequence and map between stacked and side-by-side.
Compare the first displayed frames against the settled destination. Check the
wrap canvas dimensions, bases per row, and the drawn map size and position in
both directions. Keep the compositor captures and input-relative measurements.

## Gotchas

The lower pane and its canvas can agree on a stale width. Measure the upper
pane independently. A file with saved zoom, shape or pane settings can reopen
at a different camera position from the default overview.
