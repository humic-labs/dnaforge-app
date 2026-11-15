# Physical types and equipment configurations

## Sub-features

- Define reusable physical types with shared scalar fields and child policies.
- Pin installed items and recipes to immutable versions.
- Edit one installed arrangement without changing other instances.
- Distinguish logical permission, known incompatibility and unknown fit.
- Record scoped evidence and physical observations separately from stock facts.
- Instantiate selected source-backed components without inventing boxes or
  stock.

## How to get to it (user POV)

Open Inventory and choose **Inventory setup**. **Types** defines reusable
locations and containers. **Equipment recipes** lists saved arrangements and the
manufacturer catalog. **Use type** creates an instance. **Add equipment** lets
the operator select actual installed components; it starts with an empty shell.

Select a location, container or stock to inspect **Installed arrangement**.
**Edit installed arrangement**, **Record dimensions** and **Record fit
evidence** are separate commands. Current type and recipe versions, additional
fields, dimensions, occupancy and fit evidence appear alongside their source
basis.

## Driving it with Playwright and Electron

Use the owned background scenario profile and existing material fixture:

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage configuration --fixture /absolute/evidence/materials/material-reopen-fixture.json --out /absolute/evidence/configuration
```

Define a container type with a required text field and a choice field, then a
parent type allowing that logical child type. Create two parent instances and
stock in one typed container. Missing required metadata must leave native state
unchanged. Publish a new definition version and require existing pins unchanged.
Customize one instance and require the other instance and definitions unchanged.
Keep unknown fit visible; record an explicit mounting orientation and synthetic
local evidence, then require a descriptive metadata edit to preserve its scope.

Choose the TSX60086 rack 920090 arrangement and explicitly select its full
configuration. Require 24 racks and 600 empty box positions, with no additional
boxes, vessels or stock. Separately select only two 920091 racks and require 30
installed box positions while retaining the distinct 360-position catalog
maximum. Sources, model/configuration and installed pins must survive restart.

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage configuration-reopen --fixture /absolute/evidence/configuration/configuration-reopen-fixture.json --out /absolute/evidence/configuration-reopen
```

Require exact state and accepted-history parity after the native process
restarts. Inspect visible instance pins, metadata, unknown versus applicable
fit, source references and the actual installed component counts. Keep original
screenshots, movies, frames, timestamps, native values and failed attempts.
Dimension units must retain their case: `mm` is millimeters; display styling
must not render it as `Mm`.

Focused native and domain checks separately cover logical/geometry refusals,
unavailable positions, immutable wells, exact units, stale evidence, truthful
measurements exposing existing misfit, lost installation responses and legacy
request/snapshot compatibility. The catalog read is project-scoped and never
creates inventory state. Catalog failure must not block ordinary stock reads.

## Gotchas

- A source-backed recipe is one configuration, not the sum of alternatives.
- Catalog capacity, configured positions and actual occupancy are distinct.
- A nominal two-inch label does not establish exact box dimensions.
- Unknown fit remains usable; successful placement never proves compatibility.
- Manufacturer support is distinct from a physical check of an installed unit.
- Synthetic acceptance evidence does not qualify physical laboratory hardware.
- Physical mounting orientation never renames logical wells or positions.
- Temperature constraints and broader occupied-layout reconciliation remain
  separate scoped work until their workflows are proved.
