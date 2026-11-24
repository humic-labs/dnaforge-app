# Track palettes and restriction enzyme selection

## Sub-features

- Complete-catalog SacI selection, exact renderer sites, reload persistence and
  empty selection.
- Twelve suggested track colors, custom hex input and Reset to defaults.
- Native Track View save and reload with the custom color and actual signal
  bars.

## How to get to it (user POV)

Open pUC19, open Restriction enzymes and search for SacI. Select it, reload and
remove it. Open a signal Track View, expand its track settings and use Color.
Choose a swatch, enter a custom hex value, reset it and save a custom color.
Reload the saved view.

## Driving it with Playwright

Use the parent skill's helper. It creates a native project with the public pUC19
sample package and imports a synthetic two-chromosome reference from outside
the project. The signal track contains ten measured bins.
Require one SacI cut before selection, the selected site in the real renderer,
the same site after reload and no sites after removal. Require twelve swatches,
the unchanged reset blue, the saved custom color after reload and nonzero
rendered signal bars. For each reload, verify that the recorded load ID changed
and that both the page and the shell reported ready. Keep the receipt and all
original captures.

## Gotchas

The app must use its own disposable scenario profile. Native setup is a fixture
precondition; it does not prove the reference-import UI. This small signal does
not qualify large-genome performance. The helper records page errors and failed
enzyme-data or genome requests and rejects them.
