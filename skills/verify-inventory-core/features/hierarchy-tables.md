# Importing storage hierarchies and plate layouts

## Acceptance boundary

Native HTTP and file-backed SQLite acceptance passed shuffled parents, explicit
stack ordinals, generated permanent wells, a separate stock receive stage,
cyclic/late occupied placement refusal, later movement, duplicate prevention,
lost response, archive adoption and restart. A captured real v15 inventory and
v11 source history replayed without changing stored state or journal bytes.

The real desktop imported nine source locations in one operation, including an
explicit existing parent, then received stock into a generated permanent well
and tube box. Moving a box and reimporting shuffled rows preserved its new
placement. Changed source rows blocked. Full desktop restart retained exact
state, source bindings, wells, stocks, stack order, history and export bytes.

Evidence and original captures are under
`/Users/peterciaccia/projects/.agent-evidence/DNA-3198-inventory-hierarchy/20261116/`.
The first desktop attempt retained the successful hierarchy/receive captures and
a driver failure from an ambiguous shelf-path selector. Resuming with the exact
path completed movement and reimport without production changes.

Desktop input used pasted canonical text; native file dialogs and physical
hardware qualification remain unqualified. The workflow imports a declared
hierarchy table into the existing inventory owner. It does not infer equipment
specifications, freezer meaning, plate dimensions, custody, temperature control,
fit qualification or stock from names.

## Natural task

Import shuffled rows defining a freezer, shelf, box, tube box, permanent-well
plate and ordered plate stack. Supply explicit layouts and parent positions. The
importer resolves source-parent references before generating an atomic batch of
the existing storage and stack commands. Permanent wells are created by their
plate owner and retain its deterministic well identities.

Inspect before applying: source IDs, generated physical IDs, exact layouts,
parent relationships, stack order and generated command count. Missing external
parent mappings, cycles, duplicate source IDs, invalid layouts, occupied slots
and noncontiguous stack positions block the proposal with zero effects. A late
invalid placement leaves all proposed locations absent. Oversize atomic batches
refuse without hidden splitting.

Apply once, then receive representative stocks into created wells and tube-box
positions using the existing receive-table stage. Source labels such as A01 do
not silently become A1. Any source-specific position translation is an explicit
adapter decision. Missing quantity is not invented; receive input must
explicitly declare unknown or a measured amount.

Move a created container and reimport reordered hierarchy rows. Existing source
bindings prevent duplication and do not reset current placement. A changed
source layout, name or parent decision blocks for separate reconciliation.
Export, adopt and reopen the inventory; source bindings, physical IDs, permanent
wells, stack order, stocks and original source bytes remain intact. Lose an
apply response and recover the original receipt after a full owner restart.

## Source contract

The strict CSV/TSV columns are `source_id`, `name`, `layout_kind`, `positions`,
`rows`, `columns`, `capacity`, `parent_kind`, `parent_key`, `slot`.

Named layouts require `positions` as an explicit JSON array of distinct position
strings and blank dimensions/capacity. Grid, removable-tube and fixed-well
layouts require explicit positive row/column counts and blank
positions/capacity. Stack layout requires explicit capacity and blank
positions/dimensions; removal is top-only under the existing owner.

Parent kind is root, source or existing. Root requires empty key and slot.
Source references an exact source ID in this table. Existing references an
explicit external-parent mapping. Named/grid placements use exact slot strings.
A stack parent requires an exact positive ordinal, contiguous with the present
stack when adding items. The importer generates explicit push commands rather
than bypassing stack rules or sorting items by input row order.

Stable namespace plus source ID is a lifetime physical correlation. Raw source
bytes remain separate from row identity. Explicit skips need reasons and do not
delete containers; a child cannot silently bind to a skipped unbound parent.

## Evidence

Keep original captures, video, source files, native receipts and failed attempts
outside the checkout. Native file dialogs, equipment dimensions and physical
laboratory arrangements require their own evidence.
