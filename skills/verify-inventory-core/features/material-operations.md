# Lots and material operations

## Sub-features

- Record a supplier lot or internal preparation separately from scientific
  identity.
- Receive physical stock from a selected lot and explicitly attribute existing
  stock.
- Transfer to a new aliquot or compatible existing stock.
- Pool tracked contributions and dilute with a tracked diluent.
- Record known or unknown capacity and dead volume; retain immutable
  contribution history.

## How to get to it (user POV)

Open Inventory and choose a project. Use **Add lot** to record a batch.
**Receive stock** offers batches of the selected material. Select a stock row
for **Assign lot**, **Transfer or aliquot**, **Pool stocks**, **Dilute stock**,
**Container limits**, and **Record preparation**.

## Driving it with Playwright and Electron

Use the owned scenario profile and fixture retained by the initial workspace
journey. Run from the repository root:

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage materials --fixture /absolute/evidence/journey/reopen-fixture.json --out /absolute/evidence/materials
```

The helper drives supplier-lot creation, lot-specific receive, limits, a working
aliquot, pooling, and tracked water dilution through the visible forms. Newly
created lots, preparations and pool/dilution outputs start managed and
Unassessed; the current helper records explicit reasons and local release
decisions before later withdrawals. Original captures from earlier schemas keep
their earlier semantics and source hashes. Scientific reagent setup uses the
existing native Registry contract. Require supplier100 µL → aliquot20/source80;
pool5+15 → pooled20/source15/source65; dilute10+water30 →
diluted40/pool10/water70. Inspect the native state, immutable contribution
snapshots, accepted history and original video.

If a run fails after the verified pooling checkpoint, retain its receipt and
original captures. `--resume` requires the exact captured65/15/20 amounts and
continues with reagent setup and dilution. It does not rerun earlier mutations
or turn the failed recording into a passing uninterrupted journey.

Stop and reopen the owned application with the same isolated profile, then run:

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage material-reopen --fixture /absolute/evidence/materials/material-reopen-fixture.json --out /absolute/evidence/material-reopen
```

Require exact state and history parity. Keep original screenshots, screencast
frames, timestamps and both failed and successful receipts outside the checkout.

For explicit preparation and attribution recovery, use `--stage lineage` with
the material fixture. It requires creating a preparation without a volume debit,
changing one stock's lot without rewriting an aliquot, and refusing an
incompatible transfer with unchanged state and history.

## Gotchas

- Independent unattributed stocks are distinct origins. An aliquot inherits its
  actual root; missing metadata never establishes batch compatibility.
- Later attribution does not rewrite earlier aliquots or contribution snapshots.
- A preparation records source identity; its creation does not imply that
  material was consumed.
- Pool and dilution output identity is explicit. Diluent is tracked stock.
- Unknown capacity/dead volume remains explicit. Quantity arithmetic does not
  establish physical fit or pipetting feasibility.
- Pooling and dilution record exact volumes. Their composition calculations
  remain distinct from generic mass, count and molar stock balances.

## Exact amount arithmetic

The portable arithmetic boundary distinguishes volume, mass, amount of substance
and whole-item counts. Run `inventory-amount.test.ts` from the domain-services
package. Require exact same-dimension conversion, refusal of cross-dimension
arithmetic even at zero, whole counts beyond JavaScript's safe integer range,
explicit units for empty sums, bounded input/output and unchanged legacy volume
results. Activity labels without a shared assay definition are unsupported.

Arithmetic support alone does not establish stockroom receiving support. See
[stock amount workflows](amounts.md) for the generic receiving, transfer and
reservation path and its current qualification status. Mixing and physical
capacity remain volume-specific. Package counts never supply a content
measurement by inference.
