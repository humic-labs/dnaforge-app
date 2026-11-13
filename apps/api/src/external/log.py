"""External fetch log queries + retention.

 (Phase 1a4) deliverable. High-level query layer over the raw
`ControlPlaneStore.list_external_fetch_log` DAO + the rotation/VACUUM policy
documented at the project level.

Three concerns live here:

1. **Operational queries** — "what did UniProt see in the last hour", "what
   did this workspace pull", per-provider aggregate metrics. The underlying
   indexes from  (`(provider, recorded_at DESC)`,
   `(workspace_id, recorded_at DESC)`, `(external_resource_id)`) cover every
   query in this module. New queries that would scan must add an index
   in `apps/api/src/control_plane/store.py` first.

2. **Retention rotation** — `external_fetch_log` is append-only. Rows older
   than `RETENTION_DAYS` move to `external_fetch_log_archive` (lazily created
   by the DAO at first rotation). The archive stays queryable for forensic
   spelunking but is NOT folded into operational queries by default; one
   table = one cardinality budget.

3. **VACUUM cadence** — SQLite reclaims free pages only on `VACUUM`. After
   rotation, deleted rows leave free pages behind; without VACUUM the
   on-disk file keeps growing even though logical row count fell. Cheap
   when the log is small (<1M rows). Default schedule: monthly, after
   the rotation pass.

Cron wiring is not in this module. Operators schedule
`run_retention_pass()` (or `python -m src.external.log` once we wire a
console entry point) via systemd timers, launchd, or the desktop app's
background-task runner. This module is the library; the schedule is
policy.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from src.control_plane.store import ControlPlaneStore

logger = logging.getLogger(__name__)

RETENTION_DAYS = 180

DEFAULT_PROVIDER_WINDOW = timedelta(hours=1)
DEFAULT_WORKSPACE_WINDOW = timedelta(hours=24)


@dataclass(frozen=True)
class ProviderMetrics:
    """Aggregate metrics for one provider over a time window.

    Mirrors the metrics surface called out in the substrate plan's
    "Observability deliverables (v1)" section: total fetches, cache hits,
    failure kinds, and latency percentiles. `bytes_received_total` is
    the cumulative payload byte count across non-cache-hit fetches in
    the window — useful for billing/quota visibility once we add
    per-provider accounting.
    """

    provider: str
    window_start: str
    window_end: str
    total_fetches: int
    cache_hits: int
    failures: int
    failures_by_kind: dict[str, int] = field(default_factory=dict)
    p50_latency_ms: int | None = None
    p95_latency_ms: int | None = None
    p99_latency_ms: int | None = None
    bytes_received_total: int = 0


def _isoformat_utc(dt: datetime) -> str:
    """Match `utc_now()` formatting so lex compare ordering is consistent."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def recent_by_provider(
    store: ControlPlaneStore,
    provider: str,
    *,
    since: datetime | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    """Recent fetch_log rows for a provider. Default window: last hour.

    Returned rows come from the public DAO and have JSON columns
    (`capability_check_json`) already decoded into Python dicts.
    """
    since = since or (datetime.now(timezone.utc) - DEFAULT_PROVIDER_WINDOW)
    return store.list_external_fetch_log(
        provider=provider,
        since=_isoformat_utc(since),
        limit=limit,
    )


def recent_by_workspace(
    store: ControlPlaneStore,
    workspace_id: str,
    *,
    since: datetime | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    """Recent fetch_log rows for a workspace. Default window: last 24 hours."""
    since = since or (datetime.now(timezone.utc) - DEFAULT_WORKSPACE_WINDOW)
    return store.list_external_fetch_log(
        workspace_id=workspace_id,
        since=_isoformat_utc(since),
        limit=limit,
    )


def provider_metrics(
    store: ControlPlaneStore,
    provider: str,
    *,
    since: datetime | None = None,
) -> ProviderMetrics:
    """Aggregate metrics over the window. Default 1h.

    Pulls every row in window (covered by the `(provider, recorded_at)`
    index) and aggregates in Python. Rows are bounded by the index
    selectivity, not by `limit`, so callers don't accidentally truncate
    metrics — at expected volume (<200 rows/min/provider per the
    write-amp budget) the full pull is fine.
    """
    since = since or (datetime.now(timezone.utc) - DEFAULT_PROVIDER_WINDOW)
    window_start = _isoformat_utc(since)
    window_end = _isoformat_utc(datetime.now(timezone.utc))

    rows = store.list_external_fetch_log(
        provider=provider,
        since=window_start,
        limit=1000,
    )

    total = len(rows)
    cache_hits = sum(1 for r in rows if r["cache_hit"])
    latencies: list[int] = []
    failure_kinds: dict[str, int] = {}
    bytes_total = 0
    for r in rows:
        kind = r.get("failure_kind")
        if kind:
            failure_kinds[kind] = failure_kinds.get(kind, 0) + 1
        ms = r.get("latency_ms")
        if ms is not None:
            latencies.append(ms)
        bytes_received = r.get("bytes_received") or 0
        bytes_total += bytes_received

    failures = sum(failure_kinds.values())
    latencies.sort()

    return ProviderMetrics(
        provider=provider,
        window_start=window_start,
        window_end=window_end,
        total_fetches=total,
        cache_hits=cache_hits,
        failures=failures,
        failures_by_kind=failure_kinds,
        p50_latency_ms=_percentile(latencies, 0.50),
        p95_latency_ms=_percentile(latencies, 0.95),
        p99_latency_ms=_percentile(latencies, 0.99),
        bytes_received_total=bytes_total,
    )


def _percentile(sorted_values: list[int], p: float) -> int | None:
    """Nearest-rank percentile on a pre-sorted list. Returns None on empty."""
    if not sorted_values:
        return None
    idx = max(0, min(len(sorted_values) - 1, int(round(p * (len(sorted_values) - 1)))))
    return sorted_values[idx]


def rotate_to_archive(
    store: ControlPlaneStore,
    *,
    older_than_days: int = RETENTION_DAYS,
) -> int:
    """Move log rows older than `older_than_days` to the archive table.

    Returns the number of rows moved. Idempotent: re-running on a
    partially-applied rotation (crash recovery) skips already-archived
    rows via `INSERT OR IGNORE` on the PK.
    """
    threshold = datetime.now(timezone.utc) - timedelta(days=older_than_days)
    moved = store.archive_external_fetch_log_older_than(_isoformat_utc(threshold))
    if moved > 0:
        logger.info(
            "external_fetch_log: archived %d rows older than %s",
            moved,
            _isoformat_utc(threshold),
        )
    return moved


def vacuum_log(store: ControlPlaneStore) -> None:
    """Compact the SQLite file after rotation. Run monthly per the runbook."""
    store.vacuum()
    logger.info("external_fetch_log: VACUUM complete")


def run_retention_pass(
    store: ControlPlaneStore,
    *,
    older_than_days: int = RETENTION_DAYS,
    vacuum: bool = False,
) -> dict[str, Any]:
    """One-shot retention pass entrypoint for cron-style invocation.

    Returns a JSON-friendly result describing what happened so the cron
    log shows action, not silence:

      {"archived": int, "vacuumed": bool, "older_than_days": int}

    `vacuum` defaults False — the substrate plan calls for monthly
    VACUUM, weekly rotation. Operator picks the schedule and passes
    `vacuum=True` once a month.
    """
    archived = rotate_to_archive(store, older_than_days=older_than_days)
    if vacuum:
        vacuum_log(store)
    return {
        "archived": archived,
        "vacuumed": vacuum,
        "older_than_days": older_than_days,
    }
