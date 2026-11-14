# Composition and exact concentrations

## Sub-features

- Record explicit homogeneous composition and measured or unmeasured analytes.
- Normalize compatible mass/volume and amount/volume units independently.
- Calculate exact weighted concentration with explicit output mixing.
- Preserve recurring fractions and unknown reasons while editing another
  analyte.
- Inspect immutable composition facts retained with lot contributions.

## How to get to it (user POV)

Open Inventory, choose a project and select a stock row. **Record composition**
offers Unknown or Homogeneous composition. Add registered analytes and choose
Measured or Unmeasured for each. Existing exact values remain unchanged until
**Replace measurement N**. Pool, dilution and transfer into existing stock offer
an explicit **Result mixing** choice.

## Driving it with Playwright and Electron

With the owned scenario app and material workflow fixture:

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage composition --fixture /absolute/evidence/materials/material-reopen-fixture.json --out /absolute/evidence/composition
```

The helper records source DNA1ng/µL and explicitly records DNA0ng/µL in the
tracked water fixture. It dilutes1µL sample with2µL diluent under an explicit
Homogeneous result choice. Require output3µL and the exact canonical
concentration1/3ng/µL. Edit another analyte and require the original fraction
unchanged. Record a new source measurement9ng/µL and require the dilution's
captured source fact remains1ng/µL and the output remains1/3ng/µL.

Stop and reopen the owned native app with the same isolated profile, then run:

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage composition-reopen --fixture /absolute/evidence/composition/composition-reopen-fixture.json --out /absolute/evidence/composition-reopen
```

Require exact native state and accepted-history parity, visible1/3ng/µL and
unchanged contribution facts. Keep original movies, frames, timestamps,
screenshots and receipts. The helper module is
`apps/desktop/scripts/journeys/inventory-composition.mjs`.

Focused domain checks separately cover input-order independence, large supported
ratios, bounded final values, missing measurements, incompatible mass/molar
units, invalid mixing states, and atomic rollback. Frozen v1/v2/v3 migrations
preserve original request bytes and digests; new measurements do not rewrite old
input snapshots.

## Gotchas

- A missing analyte measurement is unknown, never an implicit zero.
- Homogeneous output is an explicit assumption, not inferred from names or the
  word dilution.
- Molar and mass concentrations require an explicit molecular-weight conversion
  outside this slice.
- Stored and preserved concentrations are reduced exact ratios. Displaying or
  editing a different analyte never rounds those values.
- Legacy commands without a mixing field keep their original shape and produce
  explicit unknown mixed composition. A new aliquot inherits source composition.
