# External-Provider Substrate

> **If you are scoping or building anything that calls a third-party bio/compute
> API, you are in the right place — and you almost certainly do NOT need to build
> a new "provider interface", "adapter registry", "circuit breaker", or
> "rate-limiter". They already exist here. Extend, don't reinvent.**

This package (`apps/api/src/external/`) is the **single funnel** for outbound
third-party API calls from DNAForge. Outbound 3rd-party HTTP happens
**exclusively in this sidecar** — never in the Electron main process. The
desktop/renderer reaches every provider through the `/external/*` routes.

Origin:  /  / . Design plan:
`tools/devops/plans/2026-05-02-bioinformatics-db-substrate.md`. Concurrency +
capability-scope design: `../control_plane/EXTERNAL_RESOURCES_CONCURRENCY.md`.

## Layout

```
external/
├── contract.py        Provider plugin contract:
│                        - ExternalProvider  (Protocol — structural typing; implement, don't inherit)
│                        - Capability        (closed enum — the scope vocabulary callers grant)
│                        - ProviderError / ProviderRateLimitError / ProviderTimeoutError  (typed errors)
│                        - ParsedId          (discriminated union: isoform / version / chain aware)
├── service.py         ExternalResourcesService — provider-AGNOSTIC orchestration:
│                        - .register(provider)         → _providers registry
│                        - circuit breaker, rate-limit + backoff
│                        - capability gating (declared scopes ∩ granted scopes)
│                        - idempotent fetch on (provider, external_id)
│                        - provenance logging (external_fetch_log)
├── providers/
│   ├── uniprot.py     UniProtProvider
│   └── rcsb.py        RCSB / PDB provider
├── afdb.py            AlphaFold DB helpers (existence/validate, pLDDT)
├── alphafold_poster.py
├── paper_graph.py     Workspace-scoped paper-source → publication-ID traces:
│                        - normalized PMID / PMCID / DOI identifier nodes
│                        - exact evidence stays on private workspace bindings
│                        - bounded local traversal; no provider fetch
├── log.py             provenance / fetch-log
└── replay.py          deterministic replay for tests
```

HTTP surface lives in `../routes/external.py`: `/external/fetch`,
`/external/uniprot/search`, `/external/uniprot/by-sequence`,
`/external/alphafold/validate`, `/external/rcsb/*`, `/external/structure/bytes`.
All gated by `mcp_auth.check_session` + capability checks.

UCSC's documented JSON API is projected under `/external/ucsc/api/*` through
the existing `UcscProvider`: `findGenome`, every `list/*` resource,
`getData/{sequence,track}`, and `search`. Each route has an endpoint-specific
Pydantic body, while provider dispatch remains a closed enum with a per-endpoint
parameter allowlist. Calls reuse the provider's one-request-per-second budget,
bounded JSON reader, circuit breaker, audit log, capability gate, and public
hub-URL admission. `/list/files` also preserves UCSC's documented
`format=text` representation; the proxy validates the plain-text response and
returns it without forcing it through the JSON reader.

Paper trace routes are also in `../routes/external.py`:
`/external/paper/reference-graph/record` and
`/external/paper/reference-graph/query`. They are local persistence/read APIs,
not providers. Record runs under the service's shared data-access lock and one
SQLite transaction; query is workspace-scoped and bounded to depth 1–2 and at
most 100 nodes. Never move private paper paths, titles, quotes, or locators into
global `external_resource` metadata or `external_resource_xref` rows.

## Adding a provider (the whole job)

1. Implement the `ExternalProvider` Protocol in `providers/<name>.py`
   (`provider_id`, `parse_id`, `fetch`, capability declarations).
2. Declare its scopes against the closed `Capability` enum in `contract.py`.
3. `service.register(MyProvider(...))` at startup (wired in `main.py`).
4. If it needs a new route shape, add it in `../routes/external.py` following the
   existing `_enforce_session` + capability-gate pattern.

You inherit the breaker, rate-limit, capability gating, idempotency, and
provenance logging for free. Do not hand-roll any of those in a feature module.

## What this substrate is NOT (yet)

It is **synchronous request→response** today (fetch a resource, return
bytes/metadata). **Long-running async jobs** — e.g. external protein folding that
takes minutes and must be polled to completion — are net-new *lifecycle on top*
of this substrate (persisted job registry, poll/notify, quota). That work
, the external compute broker) REUSES this provider contract, breaker,
rate-limit, and capability gating; it does not replace them.

Also not here: `../concurrency/job_manager.py` is an **in-memory,
single-process** manager for local sidecar tool calls. It retains at most the
256 most recent terminal job receipts for up to 600 seconds; durable action
results live in the local control plane. It does not persist across restart and
is not a server-side job registry. Don't mistake it for one.
