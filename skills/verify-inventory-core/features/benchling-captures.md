# Interpreting captured Benchling physical inventory

## Sub-features

Read-only inspection is qualified through actual native HTTP/file SQLite and the
desktop workflow, including a full app restart. The representative synthetic
capture has twelve responses and sixteen source records. The desktop runs kept
every inventory's raw state and journal bytes unchanged. Physical capture
application adds a separate all-or-nothing preview and command workflow. This
boundary is an offline DNAForge capture wrapper around documented Benchling V2
responses, not a Benchling CSV export format, a live tenant connection or a
claim about V3 compatibility.

### Source contracts

Use the published V2
[container](https://docs.benchling.com/docs/api/v2/benchling-api/containers/get-container),
[plate](https://docs.benchling.com/docs/api/v2/benchling-api/plates/get-plate),
[box contents](https://docs.benchling.com/docs/api/v2/benchling-api/boxes/list-box-contents),
[location](https://docs.benchling.com/docs/api/v2/benchling-api/locations/get-location),
[plate schema](https://docs.benchling.com/docs/api/v2/benchling-api/schemas/get-plate-schema)
and
[box schema](https://docs.benchling.com/docs/api/v2/benchling-api/schemas/get-box-schema)
contracts. Preserve each original response body as text, endpoint, query,
declared capture scope and pagination linkage. A wrapper declaration alone does
not establish completeness.

Omitted fields, explicit null, present values and contradictory observations are
different states. Missing contents do not mean empty; missing parent does not
mean root. Fixed wells and removable containers remain different owners. Generic
container parents do not establish grid positions; box contents and plate well
keys supply separate placement evidence.

Quantity supports multiple dimensions. Only supported volume units can become
volume stock. Do not read deprecated volume as necessarily volumetric. Preserve
original JSON number tokens before numeric conversion; zero, null amount, absent
amount, absent units and unsupported units remain distinct. Names never supply
dimensions, freezer specifications or control relationships.

## How to get to it (user POV)

Open the Inventory activity, select the intended project and choose **Inspect
Benchling capture**. Paste the original DNAForge capture text and choose
**Inspect capture**. Review the declared selected-records scope, source field
states, original responses, placement observations and page links. This action
has no receiving or physical import effect. File selection uses the existing
bounded UTF-8 reader; qualify the operating-system picker separately.

## Driving it with native HTTP and Electron

### Physical application

After read-only inspection, open **Interpret physical inventory**. Every source
record needs an explicit disposition. Storage decisions name the local layout,
dimensions and parent/position evidence. Containers distinguish permanent wells
from movable vessels and empty, unobserved, unidentified or identified contents.
An empty interpretation requires both a captured empty contents array and an
explicit captured zero volume. A zero quantity with an identified entity is
stock. Material and quality decisions never come from names or foreign status.

The guided controls retain captured observation references or explicit declared
values and reasons. A human action may copy unique captured facts into visible
controls; it cannot select scientific identities, quality or missing parents.
Keep unsupported or omitted contents explicit. Unrepresented permanent wells
become unobserved; unrepresented box/matrix positions require an explicit
unavailable-position decision. Use the core preview's exact position list.

Preview the immutable combined proposal before applying it. Source, choice,
project or revision changes invalidate it. The existing controller persists the
exact submitted operation for receipt lookup or identical retry after a lost
acknowledgement. Apply commits storage, vessel bindings and contents together.
No-change must disclose that neither a revised source file nor a new receipt is
saved. Current local movement, quantity and contents knowledge remain intact.

Application acceptance must use the representative fixture and genuine current
project materials. Import known-zero stock, empty containers, unidentified
multicontent material and unobserved positions in one operation. Reimport after
movement and use without duplication or replenishment. Later contents reuse an
original empty vessel. Changed source facts show the original target and require
reconciliation. Archive adoption and full restart retain the raw capture,
decisions, source identities, knowledge and original receipts. Preserve the
original recordings and receipts outside the checkout.

From the repository root, use a new evidence directory outside the checkout:

```sh
INVENTORY_BENCHLING_EVIDENCE_DIR=/absolute/evidence/inspection pnpm --dir apps/desktop exec vitest run src/main/inventory-benchling-capture-native-acceptance.test.ts
INVENTORY_BENCHLING_APPLICATION_EVIDENCE_DIR=/absolute/evidence/application pnpm --dir apps/desktop exec vitest run src/main/inventory-benchling-application-native-acceptance.test.ts
node apps/desktop/scripts/inventory-journey.mjs --stage benchling-capture --fixture /absolute/current-owned-inventory-fixture.json --out /absolute/evidence/inspection-desktop
node apps/desktop/scripts/inventory-journey.mjs --stage benchling-apply --fixture /absolute/current-owned-inventory-fixture.json --out /absolute/evidence/application-desktop
```

The native workflow uses actual HTTP, registered-project authority and file
SQLite. It checks original number tokens, current read grants, scope refusal,
malformed sources, absent and present inventories and a read-only reopen. Every
inspection preserves database changes, state, journal and events.

The desktop workflow requires the task-owned background app and a current
fixture containing its actual project, scope, state and history. It drives the
ordinary controls, inspects duplicate keys, source quantities and foreign
metadata, exposes a missing page, edits source to invalidate the result and
reinspects. It compares every profile inventory's raw state and journal bytes
before and after; a new SQLite connection's `total_changes` is not that oracle.
Keep the screenshots, video, raw source, returned inspection and failed
attempts.

Stop only the task app, restart it with the same profile and run:

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage benchling-capture-reopen --fixture /absolute/evidence/desktop/benchling-capture-reopen-fixture.json --out /absolute/evidence/reopen
```

Require the original inventory state/history before and after the repeated
read-only workflow. This does not qualify physical import or a live connection.

### Later physical application acceptance

Use a synthetic fixture derived from the pinned public response shapes, with a
nested location tree, a box containing an empty and occupied tube, a fixed plate
and a removable-tube matrix plate. Include known zero, decimal and unknown
amounts, omitted fields, conflicting duplicate observations and a multi-content
container requiring an explicit disposition.

Inspect unresolved facts before any inventory write. Resolve scientific
identities through the existing migration/registry owner. Declare dimensions,
positions and any facts the capture cannot supply explicitly. Never choose the
first content from a mixture or duplicate the entire container amount for every
entity. Source checkout, archive and permission metadata remain foreign
evidence; they cannot grant local authority or fabricate local historical
actions.

Import once through the existing atomic inventory journal. Preserve exact raw
responses, source IDs, units, original number tokens and every resolution. Empty
movable containers need durable identity correlation even without stock. Move
and consume stock, then reorder capture pages and reimport: current facts must
remain intact without duplicates. Changed source facts require explicit
reconciliation. Export, adopt and reopen; recover the original receipt after a
lost response.

## Gotchas

### Exact numeric boundary

The existing duplicate-key-rejecting JSON reader parses ordinary numbers for its
current callers. The capture boundary additionally needs original numeric tokens
indexed by decoded JSON pointer. Preserve unsafe integers, decimal trailing
zeros and exponents as text. Do not reconstruct them from rounded JavaScript
numbers. Duplicate keys, malformed syntax and excessive nesting must still
refuse; old reader behavior and its custom number callback stay intact.

The reader caps captured responses at 1,024, record observations at 10,000,
merged fields per record at 256, and projected field-observation cells at
100,000 before expansion. The exact reader also caps numeric allocations at
100,000 across all response bodies before constructing another token or pointer
entry. Limit refusals return compact blocked results without partial records.
Complete inspection output must fit the existing 17 MiB inline budget.

An actual running Electron inspection of 100,001 numeric tokens returned a
compact `BENCHLING_NUMBER_LIMIT` refusal and preserved all inventory bytes. That
synthetic stress input is an allocation-boundary control, not a response claimed
to have come from Benchling. A legacy profile copy also replayed all twenty-two
v16 and 117 v11 operations with original receipts and zero SQL changes. No
schema migration was introduced for inspection.

Keep source fixtures, official contract references, original captures, receipts
and failed attempts. Qualification must name the supported capture version and
unsupported fields; representative synthetic evidence does not prove live
Benchling access or historical actions absent from the source.

For physical application restart acceptance, use the generated
`benchling-application-reopen-fixture.json` with
`--stage benchling-apply-reopen`. If a driver fails after its single import
checkpoint, preserve the failed movie and receipt. Confirm that the checkpoint
exactly matches native persisted state and history, then continue with
`--stage benchling-apply-resume` and the generated `imported-fixture.json`. That
continuation never submits the original import again. Later failures require a
new explicitly bounded continuation; do not use an earlier checkpoint or repeat
physical operations.
