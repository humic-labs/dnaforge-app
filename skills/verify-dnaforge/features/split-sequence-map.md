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
cp test-fixtures/sequences/circular/pUC19.gb "$session_dir/workspace/"
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

### Switching sequence and map views

Open Files in the isolated project. Run the orientation journey with the same
session and a fresh output directory. It closes the disposable session’s tabs
and opens the seeded pUC19 through Files.

```sh
node apps/desktop/scripts/split-orientation-journey.mjs \
  --session "$session_dir" --out "$session_dir/switch-captures"
```

Start with the map alone and click the stacked split. The journey also drives every
composition button that changes the view from sequence alone, map alone, and
all four split placements. Compare the first displayed frames with the settled
sequence rows and map tracks. The receipt records pane and bitmap dimensions,
bases per row, backbone bounds, and click-to-presentation times. Keep the
original frames and timing data. Pass `--first` to isolate the map-to-stacked case.

### First side-by-side click after opening a map-only file

Open Files on the disposable pUC19 project and run the cold side-by-side journey.
It reopens the file in its saved map-only view, then clicks Side by side as its first
layout action. The native recording checks the visible base glyphs in the left
pane separately from the circle's horizontal center in the right pane. The
receipt includes the time from pointer-down and click to each result. Preserve
the original frames, settled reference screenshot, and receipt together.

```bash
node apps/desktop/scripts/cold-side-by-side-journey.mjs --session "$session_dir" --out "$session_dir/cold-side-by-side"
```

### Continuous resizing and frame pacing

With Files open in the same disposable project, run the native resizing journey against a fresh output directory. It drives a 1.5-second drag in each direction, resizes the native window in both dimensions, and drags the separator between the sequence and an adjacent HTML document in both split directions.

```sh
node apps/desktop/scripts/sequence-resize-performance.mjs \
  --session "$session_dir" --out "$session_dir/resize-timing"
```

Each gesture schedules 90 input updates at a target of 60 Hz. Use `--input-hz 120` for 180 updates at twice the target presentation rate. Compare the actual input intervals with complete frame intervals and the minimum complete presentations in any one-second window. The receipt records the estimated display refresh rate from Chromium’s refresh outcomes and the cadence of presented frames during each gesture, reported partial or dropped frames, and the number of distinct size observations. Inspect the timeline and exact dimensions inside each phase directory. For a separate screen recording, repeat with `--video` and a different output directory. Each phase retains its original frames and `video.ffconcat` with their capture times. `--profile` collects JavaScript CPU samples for diagnosis. Use the ordinary run for frame pacing.

## Gotchas

The lower pane and its canvas can agree on a stale width. Measure the upper
pane independently. A file with saved zoom, shape or pane settings can reopen
at a different camera position from the default overview.
