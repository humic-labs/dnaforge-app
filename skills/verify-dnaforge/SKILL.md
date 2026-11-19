---
name: verify-dnaforge
description:
  Verify notebook authoring, saved read pileups, annotations, track palette edits, catalog-backed
  restriction enzyme selection and agent 3D structure work behind other screens
  or on unselected tabs in an isolated DNAForge desktop development app.
---

# Verify DNAForge desktop workflows

Notebook repair claims also use the focused
[notebook verification skill](../verify-notebook-authoring/SKILL.md), which separates
component results from real app acceptance and lists the reported regressions.
For release and usage analytics notices, follow the
[desktop relaunch checks](features/desktop-notices.md).

Choose the [saved pileup map](features/saved-pileup.md) for read loading,
annotations, zoom transitions and performance. Its source-start command owns
launch, readiness checks and cleanup. Choose the
[covered workspace structure map](features/covered-workspace-structure.md) for
agent structure commands while Home, References or Settings is on screen, and
the [unselected structure tab map](features/unselected-structure-tab.md) for
agent structure commands on a tab the person has not selected. The sections
below describe the
[palette and enzyme journey](features/palettes-and-enzymes.md).

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

The [palette and enzyme feature map](features/palettes-and-enzymes.md) defines
that acceptance path. For notebook authoring, follow the
[notebook feature map](features/notebook-authoring.md) in the running app.

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
