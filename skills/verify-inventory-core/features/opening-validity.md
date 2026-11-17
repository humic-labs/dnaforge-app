# Opening observations and validity decisions

## Sub-features

- Record first opening or an initial sealed observation for a stock episode.
- Correct the exact opening observation while retaining its predecessor. Unknown
  opening status is distinct from an observed opening with unknown time.
- Record independent stock or lot validity families, or correct an exact family
  head. Preserve source text and precision separately from the chosen cutoff.
- Inspect native reserve and withdrawal admissions, earliest cutoff and native
  observation time. A timer requests a native refresh; it does not expire stock.

## How to get to it (user POV)

Open Inventory and select a project. Stock details show **Opening and
validity**, with **Record opening**, **Correct opening**, **Add validity rule**
and explicit corrections for applicable rules. **Validity decisions** in the
toolbar can also target a lot without stock. Lot quality and recall decisions
remain separate.

## Driving it with Playwright and Electron

Drive the smallest complete path: receive a fresh stock using an existing
project scientific record; record an after-opening rule with an explicit elapsed
duration; observe the stock sealed at an explicitly entered UTC instant; reserve
while withdrawal is blocked; record its actual first opening with an explicit
known or unknown time. Known opening may enable use; unknown opening time
remains blocked. Record a separate past absolute cutoff and require native
expiry blockers while the physical amount and existing reservation remain
unchanged.

From an exact current v20 native fixture, run:

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage opening --fixture /absolute/evidence/current-fixture.json --out /absolute/evidence/opening
```

The seven accepted operations receive 100 µL, record a stock-owned 1800-second
rule, observe sealed at an explicitly entered native snapshot time, reserve 10
µL, record first opening, use 5 µL, and record an explicit past UTC cutoff.
Require 95 µL on hand and the original 10 µL hold, with both reserve and
withdraw blocked after the past cutoff. The printed month remains source
precision only. Each accepted stage writes `NN-opening-checkpoint.json`. A new
output directory and `--stage opening-resume` require the exact checkpoint
state/history; they never repeat a completed intent. After a full native
restart, `--stage opening-reopen` consumes `opening-reopen-fixture.json` and
requires exact state/history and visible expiry parity.

To observe a real deadline crossing without a stock edit, keep the app running
and use the completed seven-operation fixture:

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage opening-timer --fixture /absolute/evidence/opening/opening-reopen-fixture.json --out /absolute/evidence/timer
```

This corrects only the existing absolute policy head to an explicit native
observation time plus 15 seconds, preserves the original printed month and
source text, and immediately writes `opening-timer-checkpoint.json`. The view
must initially allow reserve/use, then refresh automatically to a native
observation at or beyond the cutoff and disable both. State, quantity,
reservations and complete history must remain exact across that wait; the
correction is the only accepted operation. The helper retains original video
frames before and after the real boundary. It does not change the system clock
or infer expiry in the renderer.

After stopping and restarting the same owned profile, run
`--stage opening-timer-reopen` with `opening-timer-reopen-fixture.json`. Require
exact state/history and visible expired parity. If capture failed after the
correction committed, preserve the original failure and checkpoint; recover that
accepted operation before starting a new intent. A timer checkpoint can be
inspected with the reopen stage once its explicit deadline has passed.

Use an exact current native fixture, original captures, native state/history and
availability. Save a checkpoint after each accepted operation and refuse stale
resume inputs. Do not reconstruct inherited families or derive business status
in the helper. Use the focused native acceptance workflow for inheritance,
correction, adoption and exact cutoff boundaries. A desktop capture of this
small path does not establish every wider interaction; retain the matching
native receipts and actual desktop evidence for each claimed behavior.

## Gotchas

- No printed month or date becomes UTC midnight or month end automatically.
- Cutoff input is an explicit UTC instant. Source precision remains independent.
- Durations are positive whole elapsed milliseconds, seconds, minutes, hours or
  days of exactly 24 hours. Calendar months and years are unsupported.
- An aliquot's own opening cannot restart an inherited source clock.
- A corrected unknown opening status retains its observation head and history.
- A rule correction changes its family only. Another family, stock quarantine or
  lot recall can continue blocking use.
- Read-only users inspect facts and native admissions without mutation controls.
