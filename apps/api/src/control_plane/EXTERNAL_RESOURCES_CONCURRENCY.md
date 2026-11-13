# External-resource concurrency and storage contract

This document is the published contract that the substrate's load tests
(`tests/test_external_resources_concurrency.py`,
`tests/test_external_substrate_under_workload.py`) gate against. Drift
either the budget or the implementation — never silently.

## Database engine settings

The control-plane SQLite database is configured at every connection open in
`ControlPlaneStore.__init__`:

| Pragma | Value | Reason |
|---|---|---|
| `journal_mode` | `WAL` | Single-writer / multi-reader concurrency. Required so  audit reads, the renderer L1-cache reconcile-on-read path, and the external-resource service can all run without blocking the writer. WAL is a database-file property — set once, all connections see it. |
| `busy_timeout` | `5000` ms | Writers retry-and-block instead of failing under contention. Absorbs the WAL writer-lock upgrade race that would otherwise surface as `SQLITE_BUSY`. Per-connection. |
| `synchronous` | `NORMAL` | The WAL-recommended pairing. `fsync` happens at checkpoint time, not on every commit — substantially reduces write latency. The tradeoff: under power loss or OS crash, the last few committed transactions can be lost (the database stays internally consistent, but recently-committed audit/fetch rows may not be on disk). For DNAForge's local-first sidecar this is the right call; if a future caller cares about durability of the most recent commit, switch to `synchronous = FULL` for that path. Per-connection. |
| `foreign_keys` | `ON` | FK enforcement (cascade for xref/binding, set null for fetch_log + data_file). Per-connection — must be re-enabled on every reader connection that participates in writes. |

## Operational note: WAL sidecar files

WAL is a sticky database-file property. The first run after this code lands
permanently converts any existing  control-plane database from
rollback-journal mode to WAL mode, producing `*.sqlite3-wal` and
`*.sqlite3-shm` sidecar files alongside the main database. Any backup,
support-export, or copy script that touches the control-plane DB must include
all three files — copying just the `.sqlite3` captures an inconsistent
snapshot because uncommitted-to-main pages live in the WAL. The standard
SQLite-WAL gotcha; documented here so it surfaces during ops review rather
than during an incident.

## Decision: no Alembic for v1

The plan describes the schema additions as an "alembic migration." We chose
**not** to introduce Alembic for v1:

-  already established the additive `CREATE TABLE IF NOT EXISTS` pattern
  in `SCHEMA_SQL`, applied via `executescript` at startup. The new tables follow
  that pattern — fresh installs and existing databases both converge to the
  same state on the next startup.
- Alembic adds a runtime dependency, an `alembic.ini`, an offline/online migration
  workflow, and a separate `alembic upgrade head` step. None of those costs are
  earned by an additive forward-only schema in a desktop sidecar.
- When the substrate gains a destructive migration (column drop, type change,
  data backfill), introducing Alembic at that point is straightforward — a one-
  off "import existing tables under version `0001` and stamp the database" step
  — and the cost is justified by the operation it enables.

The tradeoff is documented here so a future contributor knows why the choice
was deliberate, not accidental.

## Transaction boundaries

The DAO is commit-each (matches 's pattern). Service-layer batching
belongs to DNA-XXa2; this section names the boundaries DNA-XXa2 must enforce.

| Write path | Boundary | Insert count |
|---|---|---|
| **Provider fetch (system, indexer, or  resolver chain)** | One `BEGIN IMMEDIATE` … `COMMIT` block | 4–5 inserts: `data_file` + `external_resource` + `external_fetch_log` + `external_resource_xref` (when discovered) + `external_resource_binding` (when bound to workspace) |
| ** resolver chain (per CDS)** | One `BEGIN IMMEDIATE` … `COMMIT` per CDS resolution | Variable (1 fetch per UniProt accession per CDS, AFDB resolution per accession) |
| **Agent-driven `external.fetch` MCP call** | 's existing `audit_record` insert is in its own transaction  contract). The new `external_resource` writes are in a separate transaction. | : 3 inserts (action, audit_record, completion). New substrate: 4–5 as above. The two transactions can interleave on the WAL — the audit graph remains consistent because each transaction is internally atomic. |
| **Cache invalidation (DNA-XXa3, deferred)** | One transaction per IPC batch | One `external_resource` UPDATE + one `external_fetch_log` insert |

`BEGIN IMMEDIATE` is mandatory for batched writes because Python's `sqlite3`
driver issues a `BEGIN DEFERRED` by default. Under WAL with concurrent
writers, that produces a window between the first `INSERT` and a later
`UPDATE`/`INSERT` where another writer can overtake the lock and force this
transaction to retry — surfacing as `SQLITE_BUSY` even though the
`busy_timeout` is set, because by then the transaction is already partway
through. `BEGIN IMMEDIATE` claims the writer lock at the open of the
transaction, eliminating the race.

## Write-amplification budget

Estimates measured by `tests/test_external_resources_concurrency.py::test_per_fetch_write_amplification_is_within_documented_budget`:

| Workflow | Inserts per call |
|---|---|
| Agent-driven `external.fetch` (UniProt entry, no xref) | 3: `data_file` + `external_resource` + `external_fetch_log` |
| Agent-driven `external.fetch` (UniProt entry → 1 PDB xref discovered) | 5: as above + 1 `external_resource` (PDB) + 1 `external_resource_xref` |
|  resolver chain (per CDS, ~3 accessions × 2 hops avg) | 6–10 |
| Background indexer (deferred to follow-up plan) | TBD |

**Steady-state estimate for v1:**
-  resolver chain runs on file open (≤1 / minute typical user behavior).
- 10–50 fetches per file open × 5 inserts ≈ 50–250 inserts per file open.
- Power user opening 60 files / day → ~12K inserts / day.
- Annual: ~4M inserts. SQLite handles ~1B rows comfortably.

**Conclusion:** v1 is comfortable on SQLite for years. The ceiling that matters
is the deferred indexer (Phase 3) — it will scan every protein-coding feature
in the workspace, multiplying writes by 10×–100×. That ceiling is the trigger
for filing the follow-up plan's concurrency revalidation.

## Read-latency budget

Both budgets are gated by
`tests/test_external_resources_concurrency.py::test_concurrency_load_meets_p95_budgets_under_dna98_workload`.
Drift either side without revising this doc and the test fails.

| Read | p95 budget |
|---|---|
| `/external/fetch` cache hit (lookup by `(provider, external_id)`) | < 50 ms |
| `/external/fetch` cache miss (lookup → external HTTP → persist; SQLite portion only) | < 100 ms |
|  audit read (`list_agent_artifact`) under combined external +  workload | < 50 ms |

**Empirical results from the gating tests** (Apple Silicon dev machine,
deterministic in-memory `tmp_path` SQLite). Reads route through the DAO
(`get_external_resource_by_external_id`), so JSON-column deserialization via
`_row_to_dict` is included in the measured latency — these are honest
end-to-end caller numbers, not raw `SELECT *` floors:

- Default workload: hit p95 ≈ 0.3 ms, miss p95 ≈ 0.1 ms.
- 10× workload (`@pytest.mark.slow`): hit p95 ≈ 1.1 ms, miss p95 ≈ 0.4 ms.
-  + external combined:  read p95 ≈ 1.1 ms; 10× scaled ≈ 15 ms.

The headroom is two orders of magnitude. The budget intentionally allows for
slower production hardware and a busier workspace. If a regression eats more
than ~5× of that headroom on dev hardware, treat it as a real regression — the
prod ratio will be tighter.

## Per-workspace privacy

- `external_resource` is **globally scoped per provider**: UniProt P0AD86 is
  one row across all workspaces (the same protein doesn't differ between
  projects).
- `external_resource_binding` carries `workspace_id`. Every binding query in
  the DAO requires a `workspace_id`. Listing-without-workspace is
  intentionally not exposed — there is no "list all bindings" surface.
- The privacy invariant: a private internal accession in workspace A never
  appears in a binding query for workspace B. Validated by
  `test_binding_workspace_scoping_isolates_private_internal_ids`.

## Retention policy (`external_fetch_log`)

- Default: 6 months. Rotate to a sibling `external_fetch_log_archive` table
  (or hot-cold split) when the workspace exceeds the configured size cap.
- `VACUUM` runs monthly (lazy — only when the database has grown by ≥20%
  since the last vacuum). WAL mode requires explicit `PRAGMA wal_checkpoint(TRUNCATE)`
  on a similar cadence to keep the WAL file from growing unboundedly. Both
  are deferred to the deferred Phase 3 plan; v1 produces low enough write
  volume to not need them.

The retention policy aligns with 's `audit_record` retention. Coordinate
with the  owner if either side changes.

##  substrate validation

The plan explicitly calls out the *merged ≠ proven* risk:  was on `dev`
when this plan was drafted, but had not yet been load-tested under THIS
plan's combined workload. The dedicated test file
`tests/test_external_substrate_under_workload.py` mitigates that risk.
It runs  writes (action / audit / artifact) and external-resource
writes against the same WAL pipeline, drives readers across both surfaces,
and asserts:

- 0 `SQLITE_BUSY` leaks (busy_timeout absorbs everything).
- 0 torn reads — no WAL snapshot returns an `agent_artifact` row whose
  `action_id` points at a non-existent `agent_action`.
- Every `agent_action` issued by the test reaches `complete_agent_action`
  AND has a matching `audit_record`.
-  read p95 stays inside the 50 ms budget under combined contention.

If  ever surfaces a concurrency bug under this plan's workload, file
fixes back to the  owner before continuing. That obligation is
canonical.

## Capability vocabulary 

The closed set of scopes a provider may declare and a caller may grant lives
in `apps/api/src/external/contract.py::Capability`. Wire format is the
string value (used in `audit_record.capability_check_json` and
`external_fetch_log.capability_check_json` so existing dashboards keep working).

| Capability | Wire value | Granted to | Required by |
|---|---|---|---|
| Annotation fetch | `external-fetch:annotation` | Agents holding read scope on biology DBs; renderer's L1 cache reconcile path | Every provider's `fetch()` for entry metadata (UniProt, NCBI eUtils, RCSB header lookups, etc.). |
| Cross-reference resolution | `external-fetch:xref-resolution` | Same callers as annotation; cheap | Providers that resolve xrefs from a parsed id (UniProt → PDB / RefSeq / GeneID, NCBI accession → UniProt, etc.). |
| Structure file download | `external-fetch:structure` | Renderer when streaming structure bytes; deferred bioinfo-client path | Higher-cost blob fetch (mmCIF/PDB, 50–500 KB). Separate from annotation so cheap callers aren't charged for bytes. |
| Homology search | `external-fetch:homology-search` | Renderer sequence-to-structure lookup and agents with explicit sequence-search consent | RCSB polymer entity sequence search; future BLAST/similarity-search providers. |
| Bulk dataset download | `external-fetch:bulk-download` | Explicit user-approved local data management flows | Large resumable data-asset downloads (BAM/BAI/CSI, BigWig, reference bundles). Separate from `structure` because these are high-bandwidth/high-disk operations with progress, integrity, cache, and eviction state. |

**Enforcement model.** The service layer (`src/external/service.py`) checks
the exact capability required by the operation before invoking a provider.
Entry metadata fetches require `external-fetch:annotation`; structure bytes
require `external-fetch:structure`; sequence-similarity submissions require
`external-fetch:homology-search`; large local data-asset downloads require
`external-fetch:bulk-download`. A miss raises `CapabilityDenied` and the
route returns HTTP 403 — fast-fail before any network call. The full
enforcement semantics (who grants what, plugin-declared scopes, user approval
flows) are owned by the deferred plugin-packaging plan.

**Renderer fetch broker alignment.** The broker plan (`tools/devops/plans/
2026-04-30-renderer-fetch-broker.md`) shares this vocabulary. When the
broker lands, capability strings declared on this side are the SAME strings
the broker checks at the renderer→sidecar IPC boundary — one vocabulary,
two consumers. Adding a new capability requires updating both planes in
the same PR.

## License and attribution flow 

The plan's Legal + licensing section requires every cached row to carry its
provider's license + attribution. The flow is:

1. Provider declares constants on the class (`UniProtProvider.LICENSE = "CC-BY-4.0"`,
   `UniProtProvider.ATTRIBUTION = "UniProt Consortium ..."`).
2. `provider.fetch()` returns `FetchResult(license=..., attribution=...)`.
3. The service writes those values onto `external_resource.license` /
   `external_resource.attribution` AND `data_file.license` /
   `data_file.attribution` in the same transaction.
4. UI surfaces `attribution` wherever cached data is displayed (deferred
   to  — the renderer migration onto this substrate).

A regression test at
`apps/api/tests/test_external_resources_service.py::test_license_and_attribution_round_trip_through_persistence`
pins step 1→3. UI surfacing (step 4) is gated by the renderer-side L3 specs
that ship with .

## What changes if the budget breaks

1. Run the full test suite to find which budget broke first.
2. Re-derive write amplification from
   `test_per_fetch_write_amplification_is_within_documented_budget`.
3. Profile the offending write path with `EXPLAIN QUERY PLAN`.
4. If the right answer is to revise the budget (e.g., a new schema column
   added cost), revise this doc in the same PR as the implementation change.
   The published contract must always match the code.
