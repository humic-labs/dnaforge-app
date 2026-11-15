# Catalog lifecycle and source-pack updates

## Sub-features

- Retire or restore an exact published type or recipe version with a reason.
- Derive Current/Superseded separately from Available/Retired.
- Preserve installed pins, quantity, custody, holds and physical fit scope.
- Check only selected recipe components and their required ancestors.
- Preview new, identical and conflicting definitions without inventory writes.
- Publish selected new definitions without creating installed equipment.

## How to get to it (user POV)

Open Inventory, choose a project, then **Inventory setup**. Each type and saved
recipe card shows its exact version, publication relationship and selection
state. **Retire version** and **Restore version** open exact-target dialogs with
a required reason. Existing installed items remain inspectable and editable.
Returning from an editor, lifecycle dialog or preview must retain the setup tab
and search query; closing the whole setup session resets that view.

Under **Equipment recipes**, **Preview catalog update** shows model and source
scope, exact installed references and each definition's classification. A
conflicting pack cannot be applied. Select new definitions explicitly, then
**Apply selected definitions**. A preview is not an equipment installation.

## Driving it with Playwright and Electron

Reuse the owned background profile from the physical-configuration journey.

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage catalog --fixture /absolute/evidence/configuration/configuration-reopen-fixture.json --out /absolute/evidence/catalog
```

Require the retired newest version to remain Current with no older default.
Retire an installed container's type, correct its metadata under the same pin,
and require 100 µL and the exact local fit evidence/configuration revision to
remain unchanged. Restore it explicitly.

Retire a recipe without changing its existing installation. Restore the recipe,
then retire its optional rack type. The retired rack and full-arrangement
selection must be disabled; an explicit empty shell remains installable. Restore
the exact rack type, select one rack and require one installed rack and 25 empty
box positions, with no invented boxes or stock.

Compare native `inventory.catalog-update-preview` with the visible preview.
Opening a preview and selecting checkboxes must preserve state/history exactly.
An identical pack must show installed references and have nothing to apply.
Publish a new source pack explicitly and require unchanged installed IDs and
stock. Preserve conflicting manufacturer dimensions as unknown.

Stop and restart the native app with the same profile, then run:

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage catalog-reopen --fixture /absolute/evidence/catalog/catalog-reopen-fixture.json --out /absolute/evidence/catalog-reopen
```

Require exact state/history parity and inspect the retired current version,
restored availability, metadata, quantity, fit and actual selected components.
Keep original videos, frames, timestamps, screenshots and source-bound receipts.

The focused native workflow separately checks refusal and rollback, selected
retired components versus omitted optional components, same-pin metadata edits,
current read-only grants, project scope, zero-write preview of absent inventory,
and lost retirement acknowledgement recovered after later restoration/reopen.
The domain catalog checks cover conflicting IDs, stale revision, detached
previews and unchanged installed references.

## Gotchas

- Retirement of a catalog version does not decommission installed equipment.
- Restoring a recipe does not restore its component types.
- A retired newest version does not reactivate an older default.
- Identical source content does not restore a retired version.
- Any source-pack conflict blocks applying that pack, including partial fit
  assertions that could refer to different local geometry.
- Publication, installation, physical occupancy and hardware qualification are
  separate facts.
