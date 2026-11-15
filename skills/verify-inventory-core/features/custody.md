# Physical custody

## Sub-features

- Inventory an empty container independently of scientific stock.
- Check out and return a container, box or plate through explicit commands.
- Distinguish in transit, missing and unplaced inventory.
- Derive descendant custody from its controlling aggregate.
- Preserve immutable last-known observations and current slot occupancy.

## How to get to it (user POV)

Open Inventory. Add container creates a physical vessel without stock. Select a
stock, empty container or storage location to inspect its custody. Check out,
Return, Start transfer, Record arrival, Report missing and Record location are
separate actions. A permanent well acts through its plate.

## Driving it with Playwright and Electron

With the owned background scenario app and an existing material fixture:

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage custody --fixture /absolute/evidence/materials/material-reopen-fixture.json --out /absolute/evidence/custody
```

Create a parent with two slots and a box holding an empty vessel and measured
stock. Check out the box. Require its old slot to become free, exact descendant
identities, quantities and local positions, and inherited custody in both
container and stock views. Reuse the old slot, then return the box to another
valid position. Record missing and locate without changing quantity or holds.
Start a transfer; intended destination remains separate from current occupancy.
Include permanent-well plate custody without independent well moves.

Stop and restart the native application using the same isolated profile:

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage custody-reopen --fixture /absolute/evidence/custody/custody-reopen-fixture.json --out /absolute/evidence/custody-reopen
```

Require exact state and accepted-history parity, stable holder and inherited
custody. Record arrival at an explicit valid destination and return the plate.
Inspect native values alongside the visible result. Preserve original movies,
frames, timestamps, screenshots and receipts from both stages.

Focused native and domain proof must separately cover occupied-destination
refusal without mutation, ordinary-move custody bypass, own and foreign material
access, reservation preservation, fixed-well constraints, stack-top departures,
missing-middle reindex, receipt recovery and historical replay compatibility.

## Gotchas

- Last known is historical information. It never occupies the old slot.
- A child's local position inside a checked-out box is not a current freezer
  address. Effective custody comes from the shared domain projection.
- Reporting missing records an observation. It neither disposes stock nor
  changes a measured amount to zero.
- Missing and in-transit stock cannot be physically withdrawn or filled.
- A return names its actual destination. Original slots and intended transfer
  destinations are hints, never implicit reservations.
- A profile and agent identity are recorded principals, not names of verified
  human custodians.
