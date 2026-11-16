# Canonical inventory receive tables

## Acceptance boundary

Native HTTP and file-backed SQLite acceptance passed for stale refusal, lost
response recovery, atomic placement refusal, later consumption/movement, archive
adoption across scopes and exact replay after reopen. A captured real profile
containing v11 history and v12 adoption replayed without stored changes.

The real desktop accepted three rows and one explicit skip in one operation,
including two scientific materials, multiline quoted text, leading-zero IDs,
known zero, unknown quantity and an existing permanent well. Actual desktop use
reduced stock from 80 to 70 µL. A reordered reimport stayed unchanged; a revised
quantity was blocked. Full desktop restart preserved exact state, history,
archive bytes and duplicate prevention. Original video, screenshots, raw source,
receipts and failed native driver attempts are retained under
`/Users/peterciaccia/projects/.agent-evidence/DNA-3198-inventory-tables/20261116/`.

Desktop source acceptance used explicit text input. Bounded file bytes and CRLF
preservation have focused checks; native file dialog selection remains
unqualified. The importer accepts the declared DNAForge receive format, not
arbitrary spreadsheets or Benchling headers. Stocktake corrections, changed-row
reconciliation, lots, barcodes, hierarchy creation and staged batches remain
separate workflows.

## Natural task

Receive a CSV or TSV into an existing inventory. Use a stable source namespace
and exact source IDs, including leading zeros. Include quoted text with a
newline, known zero, unknown quantity, two scientific materials, a newly created
tube and an existing empty permanent well. Choose every scientific, location and
existing-vessel binding explicitly. Blank quantities or locations must not be
interpreted as unknown or unplaced.

Inspect the blocked preview before resolving its missing bindings. Prove no
inventory, journal or receipt changed. Resolve the rows and inspect the exact
proposed targets, quantities and command count. A proposal is atomic and fits
the existing 256-command bound; the importer never splits it silently. An
invalid placement late in the proposal must leave every row unapplied.

Change inventory after a ready preview. The old plan must refuse. Preview again,
apply once, lose the response, and recover the same receipt after a full owner
restart. Native acceptance must recheck project, authority, materials and their
fingerprints in the accepting transaction.

Consume or move one imported item. Reorder and re-quote the original source
rows, then preview them again under the same namespace. They must be already
imported without resetting quantity, quality, custody or placement. A changed
source value or changed destination decision must require reconciliation rather
than duplicate stock or overwrite current facts. Skipping a row with a reason
does not delete stock, retire a binding or mark an item missing.

Export and adopt the inventory into an absent destination with explicit
scientific bindings. Verify that raw source text and decisions remain in the
accepted journal, lifetime row bindings map scientific identities correctly, and
unchanged table rows remain already imported under the destination scope. Reopen
the actual desktop and verify exact state and history.

## Source contract

Every declared column occurs exactly once; order may vary. Unknown columns,
wrong row widths, malformed quotes and duplicate source IDs refuse. The columns
are `source_id`, `name`, `material_key`, `quantity_kind`, `quantity`, `unit`,
`quality`, `vessel_kind`, `vessel_key`, `location_key` and `slot`.

`known` quantity requires a decimal and supported unit. `unknown` requires both
value and unit to be empty. `new` vessel requires a name and an explicitly
resolved location key; `existing` requires an explicitly resolved vessel key and
empty name/location fields. Source keys preserve spaces, case and zeros. Raw
UTF-8 text is retained separately from normalized row facts. Row order, quoting
and a leading byte-order mark do not change source identity.

## Evidence

Preserve original before/after captures and video, failed attempts, exact native
receipts and readbacks outside the checkout. Native file dialogs and physical
sample handling need their own evidence; text input and software file bytes do
not establish those boundaries.
