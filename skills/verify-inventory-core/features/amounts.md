# Stock amounts and measurement units

## Sub-features

- Receive or identify stock with an exact volume, mass, amount of substance or
  whole-item count. An unknown amount retains its declared measurement unit.
- Record a new measurement in the stock's existing dimension. Changing from mass
  to volume requires a separate future workflow; no density is inferred.
- Use, transfer, reserve and fulfill stock with units from its declared
  dimension, preserving decimal strings and whole counts beyond safe integers.
- Keep physical capacity, dead volume, pooling and dilution volume-specific.

## How to get to it (user POV)

Open Inventory and select a writable project. **Receive stock** offers measured
or unknown quantity and a unit. An unidentified container offers **Identify
contents** with the same choices. Select identified stock for **Record
quantity**, **Use stock**, **Transfer or aliquot**, **Reserve quantity** and
**Use reserved stock**. Details and availability show the actual unit, including
the unit of an unknown amount.

## Driving it with Playwright and Electron

Use an exact current v19 fixture captured from the owned native profile. To
refresh an older fixture after native migration without changing inventory, run:

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage refresh-fixture --fixture /absolute/evidence/prior-fixture.json --out /absolute/evidence/current-fixture
```

This reads canonical state from the native owner and requires the original
revision and full history to remain identical. It writes
`inventory-current-fixture.json`; it does not synthesize ancestry or replay any
intent. Then run:

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage amounts --fixture /absolute/evidence/current-fixture/inventory-current-fixture.json --out /absolute/evidence/amounts
```

The helper uses ordinary controls and an existing current scientific record.
Require 1 mg → reserve 0.6 mg → fulfill 0.2 mg → use 100 µg → transfer 0.25 mg.
The original stock must contain 450000 ng, with 400000 ng held and 50000 ng
unreserved; the aliquot must contain 250000 ng. It also receives
900719925474099312345678901 items, reserves 9007199254740993, fulfills 3, uses
10 and transfers 9007199254740993 without rounding. An attempted fractional item
receipt must refuse without a receipt or state change. Incompatible units must
be absent from withdrawal selectors. Unknown mass must persist as unknown ng,
with zero ng held and disabled withdrawals.

Each accepted step writes an exact state/history checkpoint with its completed
step. After a failed capture, preserve the original failure and use
`--stage amounts-resume --fixture /absolute/evidence/amounts/NN-amounts-checkpoint.json`
in a new output directory. Resume requires exact current state/history; it
refuses a stale checkpoint rather than repeating a possibly accepted intent.
Recover an outstanding original operation before resuming if an acknowledgement
was lost.

Stop and restart the owned native application with the same profile, then run
`--stage amounts-reopen --fixture /absolute/evidence/amounts/amounts-reopen-fixture.json`
in a new output directory. Require exact state/history and visible mass, whole
count and unknown-unit parity. Retain the original captures and failed attempts.

Renderer checks exercise real controls and exact submitted command shapes. Their
mocked persistence boundary does not qualify native durability. The real journey
and restart remain unqualified until original captures and native values have
been inspected.

## Gotchas

- Unknown amount is distinct from zero and from unidentified contents.
- Selecting another prefix changes the entered measurement's unit; it does not
  infer a density or molecular weight.
- Physical volume limits cannot establish capacity or dead amount for mass,
  count or molar stock. Pooling and dilution require volume-based stock.
- Existing receive-table, stocktake and Benchling source formats retain their
  explicit volume contracts and original request bytes.
- Supplier ordering, expiry and full stockroom management are separate work.
