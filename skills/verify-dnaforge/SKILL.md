---
name: verify-dnaforge
description:
  Verify saved read pileups, annotations, track palette edits, catalog-backed
  restriction enzyme selection and agent 3D structure work behind other screens
  or on unselected tabs in an isolated DNAForge desktop development app.
---

# Verify DNAForge desktop workflows

For release and usage analytics notices, follow the
[desktop relaunch checks](features/desktop-notices.md).

Choose the [saved pileup map](features/saved-pileup.md) for read loading,
annotations, zoom transitions and performance. Its source-start command owns
launch, readiness checks and cleanup. Choose the
[covered workspace structure map](features/covered-workspace-structure.md) for
agent structure commands while Home, References or Settings is on screen, and
the [unselected structure tab map](features/unselected-structure-tab.md) for
agent structure commands on a tab the person has not selected, and the
[protein inspection map](features/inspection-structure-tab.md) for unselected
inspection tabs and retained inspection proteins. The sections below describe
the [palette and enzyme journey](features/palettes-and-enzymes.md).

## Launch

Follow the README setup, including the sidecar and native helpers. Set free
ports in `apps/desktop/.env.local`, including `DESKTOP_DEBUG_PORT`. Start one
owned background instance with a fresh temporary profile:

```sh
DNAFORGE_BACKGROUND_WINDOW=1 DNAFORGE_ALLOW_SCENARIO_MUTATION=1 pnpm --dir apps/desktop dev -- --dnaforge-allow-scenario-mutation=1
```

The application creates an isolated temporary profile. Require
`ELECTRON_DEV_READY`. Do not attach to another task's instance.

## Doctor

```sh
node apps/desktop/scripts/palette-enzyme-journey.mjs --doctor --out "$HOME/DNAForge-proof/doctor"
```

This checks the configured renderer, native runtime, exact checkout and isolated
profile. It writes a receipt without changing application state.

## Drive

```sh
node apps/desktop/scripts/palette-enzyme-journey.mjs --out "$HOME/DNAForge-proof/run"
```

The [feature map](features/palettes-and-enzymes.md) defines the acceptance path.

## Evidence

Keep the original PNG captures and `receipt.json` outside the checkout, under
your home directory so the native filesystem owner can open the fixtures. The
helper also retains its native workspace, source fixtures and saved Track View.
It verifies renderer sites and bars, persisted colors and renderer errors.
Fixture setup uses native document and reference commands. Selection, presets,
custom colors, reset and saving use the ordinary controls.

## Cleanup

```sh
pnpm --dir apps/desktop dev -- --stop
```

Stop only the app started for this run. Keep the evidence and its saved
workspace.

## Helpers

`apps/desktop/scripts/palette-enzyme-journey.mjs` attaches through Playwright to
the debug port in the checkout's settings. Run it with Node as shown above.

## Chat pane resizing

With the isolated scenario app running, use
`node apps/desktop/scripts/check-chat-pane-layout.mjs "$HOME/DNAForge-proof/chat-layout"`.
At 260 and 320 px, Attach, the route picker and Send share the first row. Model
controls align with its leading edge on the next row. At 600 px, all controls
fit on one row. The check also drags to the chat minimum, pins history and opens
a new chat at 260 px.
At each size, it checks for overlapping controls, text outside buttons, and an
accessible route picker. Send must stay in view and accept a click when enabled.

For a two-pane preview already open to chat, add `--current` to measure its
existing controls at those three widths and restore the original pane width.
This mode preserves the conversation, route and draft.
