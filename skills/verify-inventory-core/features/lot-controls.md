# Lot assessment and recalls

## Sub-features

- Create a managed lot in one operation, beginning with an explicit unassessed
  decision. Existing legacy lots can begin management through a reasoned action.
- Record local release, quarantine or rejection separately from stock quality.
- Record multiple independent recalls and explicitly withdraw an exact recall.
- Inspect inherited lot constraints, local or imported actors, and every active
  recall without changing physical quantity or custody.

## How to get to it (user POV)

Open Inventory and choose a project. **Add lot** creates a managed, unassessed
lot. **Lot quality and recalls** opens all lots, including those without stock.
Choose a lot to inspect its assessment and recall history or record a reasoned
action. Stock details show the contributing lots and why material cannot be
reserved or used. Read-only projects permit inspection without mutation.

## Driving it with Playwright and Electron

This workflow is under construction. Use the owned native profile, an exact
current v19 fixture and an already-published scientific record. Refresh an older
fixture through the read-only native owner:

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage refresh-fixture --fixture /absolute/evidence/prior-fixture.json --out /absolute/evidence/current-fixture
node apps/desktop/scripts/inventory-journey.mjs --stage lots --fixture /absolute/evidence/current-fixture/inventory-current-fixture.json --out /absolute/evidence/lots
```

Refresh refuses a changed revision or any changed history. It retains native
canonical fields directly; it does not reconstruct old ancestry. Through
ordinary controls, create a managed lot, receive material from it, observe an
unassessed block and explicitly release the lot. Verify release does not clear
an independent stock quarantine. Create an aliquot and preparation, then recall
the original lot. Require inherited recall blockers, unchanged on-hand quantity
and unchanged existing reservations. Record a second recall and withdraw the
first; the remaining recall must still block use. Explicitly withdraw the
remaining recall and verify assessment and stock quarantine remain independent.

Capture native accepted requests, state, availability and original media after
each committed stage. Save exact checkpoints for bounded resume. Reopen the
native process and require exact state/history, assessment actors, recall
lifecycles and inherited blockers. Imported release is evidence and requires a
local reassessment; it cannot silently authorize withdrawal. Parent archive
acceptance exercises adoption and retained foreign actors separately.

The helper writes `NN-lot-checkpoint.json` after every accepted operation.
Resume with `--stage lots-resume` and the exact checkpoint in a new output
directory; current state and history must match. It never repeats a possibly
accepted intent with a new identifier. The final `lot-reopen-fixture.json` feeds
`--stage lots-reopen` after a complete native restart. The 18-operation path
retains 80 µL in the original tube, 20 µL in its aliquot, 10 µL in the
preparation and the original 60 µL reservation throughout both recalls and their
separate withdrawals. Final local releases do not erase the withdrawn facts.

Renderer checks drive real controls and assert exact command batches while
mocking native persistence. They do not establish durable or imported behavior.
The desktop and restart paths remain unqualified until their original captures
and native values have been inspected.

## Gotchas

- Source supplier quality text is evidence, not a local release decision.
- A lot release changes neither stock quarantine nor active recalls.
- Withdrawing one recall changes only that recorded recall.
- Receiving, measurement, movement and safety observations remain possible while
  use is blocked. Physical stock remains on hand.
- Reassociation adds constraints; it cannot erase a prior affected lot.
- Legacy ancestry can be incomplete. The view must disclose that coverage.
- Opening and expiry are separate work; this workflow does not claim them.
