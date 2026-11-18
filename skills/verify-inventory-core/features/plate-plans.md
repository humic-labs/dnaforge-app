# Reusable plate-plan versions

Inventory → Plate plans opens a local definition editor and a bounded list of
saved versions. New plan creates a distinct family. Source roles describe
logical inputs; ordered transfers name a role, destination coordinate, exact
positive µL amount and label. Saving appends an immutable definition version.
Edit as new version keeps its family. Selecting a saved version is explicit;
there is no automatic latest version.

Open version displays its complete grid and ordered instructions. Unplanned
cells have no instruction. Export printable plan SVG uses the existing native
Save destination, atomic text write and exact readback. Cancellation preserves a
previous confirmed output. Closing a chooser prevents a late destination from
starting a write. A write already begun retains its original artifact and path
for Check saved SVG or Retry same SVG output.

Select an existing physical plate and a stock for each role, then Check
feasibility. Several roles may use one stock; the preview aggregates their whole
demand. It reports native observation time, availability, validity, access,
plate and well constraints. A blocked batch has no projected balances. A
feasible projected remainder may be zero. Source/version edits clear the
binding; inventory changes, focus and a validity deadline require rechecking.
These checks do not reserve inventory or record physical work.

Use an existing inventory fixture and preserve its original physical facts:

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage plate-plans --fixture /absolute/evidence/current-fixture.json --out /absolute/evidence/plate-plans
```

This path saves an8×12 definition with two4µL transfers intoA3 andB1, reads
all96 cells, and exports exact definition SVG bytes. It then saves a2×3 version
in the same family and binds an existing compatible plate. Fresh native
availability must establish an eligible source for the combined8µL demand. A
source whose current native facts show a positive hold and less than8µL
unreserved remains blocked for the combined demand. The driver records these
exact observed facts before choosing it; a source with sufficient unreserved
quantity is not a held-shortfall example. Selecting the8×12 version clears the
former binding and reports the incompatible physical layout. Previewing its
unchanged definition with a new reason returns the original version and original
reason without Save.

The driver checkpoints the stable family and full prepared request before each
save, then checkpoints the accepted native inventory immediately before later
assertions. Preserve failures. Resume with plate-plans-resume and the latest
checkpoint; it confirms the original pending operation rather than creating a
new family. Only two version saves are expected. After a full native restart,
plate-plans-reopen requires exact state/history, both versions and export file
bytes, then performs a fresh read-only binding preview.

The default driver supplies a private destination to the production output
session and exercises real native atomic write/readback. It labels the OS Save
panel unqualified. Add --native-dialogs only when an ordinary Save panel can be
driven; that mode clicks the actual export control and waits for its confirmed
path. Scroll the exact saved grid into view before its static capture; retain a
separate image of the grid itself along with the viewport and interaction video.
Neither mode qualifies a physical printer or plan execution.
