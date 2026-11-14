# Reservations and available stock

## Sub-features

- Reserve quantity or a whole container or location without consuming stock.
- Distinguish on-hand, held and unreserved amounts for the current principal.
- Explicitly fulfill, release, cancel or record expiry.
- Preserve the holder and accepted history across a native application restart.

## How to get to it (user POV)

Open Inventory and select a stock row. Details show availability and offer
**Reserve quantity** and **Reserve item**. The Reservations tab shows the
stock's holds and available actions. The workspace's **Reservations** button
lists all holds. Locations offer **Reserve location**. Material operations can
explicitly claim a reservation; an ordinary withdrawal uses unreserved stock.

## Driving it with Playwright and Electron

Start the owned background scenario app with the existing material fixture:

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage reservations --fixture /absolute/evidence/materials/material-reopen-fixture.json --out /absolute/evidence/reservations
```

The helper receives a fresh synthetic 100 µL tube through ordinary controls,
reserves 60 µL with no deadline, and explicitly uses 20 µL of that hold. Require
80 µL on hand, 40 µL held and 40 µL unreserved. The native receipt must record
the same stable principal as the hold and the state's accepted time.

Stop and restart the native application with the original isolated profile:

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage reservation-reopen --fixture /absolute/evidence/reservations/reservation-reopen-fixture.json --out /absolute/evidence/reservation-reopen
```

Require exact state and history parity and the same holder after the process
restart. Release the remainder through the form. Require 80 µL on hand, zero
held, 80 µL unreserved and a durable Released state. Preserve original video,
frames, timestamps, screenshots and native values from both stages.

Focused domain and native checks cover competing holders, known dead volume,
deadline boundaries, recorded expiry, clock rollback, reconciliation shortfalls,
item ancestry, atomic material fulfillment and rejected-write rollback.

## Gotchas

- A local profile identifies this installation's profile, not a verified person.
- Deadlines never silently release holds during a read. Refresh observes the
  current native time; an explicit expiry or release changes allocation.
- A truthful reconciliation can expose a shortfall. It retains both the measured
  amount and outstanding promises while blocking further withdrawal.
- Reservation is planned allocation. Physical checkout and return are separate
  custody work.
