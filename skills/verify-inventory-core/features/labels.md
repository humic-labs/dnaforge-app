# Existing-code QR labels and SVG export

## Scope

This workflow distinguishes UI preparation, the native file-output owner and the
macOS Save panel. Real scanner, printer, label stock and adhesive performance
need separate actual-device evidence.

The symbol contains an existing exact alias value. Namespace and admitted
project/inventory context remain explicit in the artifact and printed text. No
local project fallback is promoted into a globally portable label identity.

## Sub-features

- Render one bounded QR template for an active physical item-code binding.
- Retain exact alias bytes, namespace, target, source revision and SVG hash.
- Preserve complete quiet zone, media bounds and mandatory human-readable text.
- Refuse unsupported content and overflow without shortening identity.
- Export retained bytes through the existing save dialog and atomic file owner.
- Confirm saved bytes and expose canceled, failed and unconfirmed output.

## How to get to it (user POV)

Open Inventory, inspect an item, then **Codes and labels**. An active code
offers **Create label**. Choose an explicit media profile and prepare the label.
The result says **Rendered** and identifies the exact source code and target. It
does not claim printing, physical attachment or independent hardware scanning.

**Export label SVG** chooses a destination. Canceling has no successful output
state. Successful export requires readback of exactly the retained artifact
bytes. If output cannot be confirmed, retain its artifact and destination for an
explicit check; do not regenerate or imply no file exists.

## Driving the real workflow

Use the owned background scenario profile and a fresh item-code fixture.
Preserve genuine before/after captures, interaction video, native state/history,
exact SVG, rasterized pixels, expected/decoded bytes and source hashes outside
the checkout.

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage labels --fixture /absolute/evidence/item-codes/item-code-reopen-fixture.json --out /absolute/evidence/labels
```

The full stage pauses for native Save-panel cancellation and destination
selection. Use native computer controls for those steps. If the native control
service is unavailable, `--stage labels-preview` exercises the real UI preview
and production label-session owner with real native filesystem ports but an
explicit automation-supplied destination. Its fixture records
`nativeDialogQualified: false`. That mode does not qualify Save-panel
interaction or cancellation; preserve that limit on the ticket rather than
substituting a new production dialog bypass.

Render an existing active code with exact leading zeros/case/spaces. Require
unchanged inventory state and complete history. Check the namespace and complete
tagged target in the artifact. Retired bindings and disposed target preparation
must refuse without mutation; an already rendered immutable artifact stays the
same snapshot when current inventory facts change.

Export through ordinary UI/file-owner controls to a task-owned evidence path.
Read that actual file again, compare its bytes/hash to the retained artifact,
rasterize that saved SVG and decode its pixels with an independent QR reader.
Require exactly the full expected alias bytes. Preserve a corrupted actual
geometry case that cannot pass this comparison. Source payload parsing or an
encoder's return value is not artifact decoding.

Exercise cancellation, a concrete write refusal and retained-artifact output
confirmation. Exercise stale preparation/export results after target or project
changes in focused owner/controller checks. Restart and require exact inventory
state/history/code bindings; repeat preparation and explicit export without
inventing an output history or a new physical item.

Focused native checks separately cover read-only grants, scoped admission,
unknown/retired/disposed bindings, exact encoder-escape-like bytes, bounded
media overflow, zero SQLite changes/events and shared human/agent renderer
behavior.

## Gotchas

- Rendered, saved, printed, attached and code-matched are separate facts.
- A value-only QR symbol does not encode its namespace or global scope.
- A valid 512-character alias need not fit a small label profile.
- A background inventory change does not rewrite old artifact bytes.
- Output-unconfirmed is not proof that no file was written.
- Software media/module profiles do not establish actual printer scaling,
  cold-storage readability or scanner compatibility.
