# Agent structure work behind another screen

## Sub-features

- An agent opens a workspace coordinate file while Home covers the workspace;
  the viewer becomes active without anyone returning to Files.
- Scene readback, a color change and agent screenshots work while covered, and
  the edit changes the rendered image.
- Home, References and Settings never paint the running structure.
- Returning to Files shows the same structure view with the same camera.

## How to get to it (user POV)

Leave the app on Home, References or Settings, with its window behind other
windows, while an agent asks DNAForge to open and edit a protein structure.
Return to Files afterwards to see the agent's result.

## Driving it with Playwright

Launch the app as described in the parent skill, then run:

```sh
node apps/desktop/scripts/covered-workspace-structure-journey.mjs --out "$HOME/DNAForge-proof/covered-structure"
```

The helper copies the public 1A8O fixture into a scratch workspace under the
evidence directory and calls the same renderer structure commands the agent
tools use. It requires the viewer to become active within ten seconds while
covered, a successful scene read, color change and two differing agent
screenshots, no painted structure canvas on the three covering screens, and the
same active view and camera on Files. It keeps every capture and `receipt.json`.

## Gotchas

The helper imports renderer modules from the development server, so it needs the
source-mode app, not a packaged build. Start the app with
`DNAFORGE_BACKGROUND_WINDOW=1` so the window stays behind other windows; a
passing run therefore also covers a background window. Agent work on a structure
tab that is not selected is covered by the
[unselected structure tab map](unselected-structure-tab.md).
