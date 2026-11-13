""" / L0 — `external_fetch_log` query module + retention.

Tests the public surface of `apps/api/src/external/log.py`: operational
queries, ProviderMetrics aggregation, rotation to archive, VACUUM, and
the cron-style retention pass.

Uses the ControlPlaneStore directly with real provider names (`uniprot`,
`alphafold`, `rcsb`) — no synthetic providers, per project policy on
fixtures.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone

from src.control_plane.store import ControlPlaneStore
from src.external import log as logmod


def _store(tmp_path) -> ControlPlaneStore:
    s = ControlPlaneStore(tmp_path / "sidecar.sqlite3")
    s.initialize()
    return s


def _isoformat_utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _seed_log_row(
    store: ControlPlaneStore,
    *,
    provider: str = "uniprot",
    workspace_id: str | None = None,
    recorded_at: datetime | None = None,
    cache_hit: bool = False,
    failure_kind: str | None = None,
    latency_ms: int | None = None,
    bytes_received: int | None = None,
    status_code: int | None = 200,
    external_resource_id: str | None = None,
) -> str:
    """Insert one fetch_log row, optionally back-dating recorded_at."""
    log_id = store.insert_external_fetch_log(
        provider=provider,
        endpoint="https://rest.uniprot.org/uniprotkb/P00875.json",
        method="GET",
        capability_check={"granted": ["external-fetch:annotation"]},
        workspace_id=workspace_id,
        status_code=status_code,
        latency_ms=latency_ms,
        bytes_received=bytes_received,
        cache_hit=cache_hit,
        external_resource_id=external_resource_id,
        failure_kind=failure_kind,
    )
    if recorded_at is not None:
        store._conn.execute(
            "UPDATE external_fetch_log SET recorded_at = ? WHERE id = ?",
            (_isoformat_utc(recorded_at), log_id),
        )
        store._conn.commit()
    return log_id


def test_recent_by_provider_returns_only_in_window(tmp_path):
    s = _store(tmp_path)
    now = datetime.now(timezone.utc)
    fresh = _seed_log_row(s, provider="uniprot", recorded_at=now - timedelta(minutes=5))
    stale = _seed_log_row(s, provider="uniprot", recorded_at=now - timedelta(hours=2))

    rows = logmod.recent_by_provider(s, "uniprot")
    ids = {r["id"] for r in rows}
    assert fresh in ids
    assert stale not in ids
    s.close()


def test_recent_by_provider_filters_by_provider_name(tmp_path):
    s = _store(tmp_path)
    now = datetime.now(timezone.utc)
    uniprot_id = _seed_log_row(s, provider="uniprot", recorded_at=now)
    rcsb_id = _seed_log_row(s, provider="rcsb", recorded_at=now)

    rows = logmod.recent_by_provider(s, "uniprot")
    ids = {r["id"] for r in rows}
    assert uniprot_id in ids
    assert rcsb_id not in ids
    s.close()


def test_recent_by_provider_custom_since(tmp_path):
    s = _store(tmp_path)
    now = datetime.now(timezone.utc)
    fresh = _seed_log_row(s, recorded_at=now - timedelta(minutes=2))
    older_but_in_window = _seed_log_row(s, recorded_at=now - timedelta(hours=3))
    truly_stale = _seed_log_row(s, recorded_at=now - timedelta(days=2))

    rows = logmod.recent_by_provider(
        s,
        "uniprot",
        since=now - timedelta(hours=4),
    )
    ids = {r["id"] for r in rows}
    assert fresh in ids
    assert older_but_in_window in ids
    assert truly_stale not in ids
    s.close()


def test_recent_by_workspace_default_window_24h(tmp_path):
    s = _store(tmp_path)
    now = datetime.now(timezone.utc)
    in_win = _seed_log_row(
        s, workspace_id="ws-a", recorded_at=now - timedelta(hours=12)
    )
    out_win = _seed_log_row(
        s, workspace_id="ws-a", recorded_at=now - timedelta(hours=48)
    )

    rows = logmod.recent_by_workspace(s, "ws-a")
    ids = {r["id"] for r in rows}
    assert in_win in ids
    assert out_win not in ids
    s.close()


def test_recent_by_workspace_does_not_leak_across_workspaces(tmp_path):
    s = _store(tmp_path)
    now = datetime.now(timezone.utc)
    a = _seed_log_row(s, workspace_id="ws-a", recorded_at=now)
    b = _seed_log_row(s, workspace_id="ws-b", recorded_at=now)

    rows_a = logmod.recent_by_workspace(s, "ws-a")
    ids_a = {r["id"] for r in rows_a}
    assert a in ids_a
    assert b not in ids_a
    s.close()


def test_capability_check_json_is_decoded(tmp_path):
    s = _store(tmp_path)
    _seed_log_row(s, recorded_at=datetime.now(timezone.utc))
    rows = logmod.recent_by_provider(s, "uniprot")
    assert rows, "expected at least one row"
    assert isinstance(rows[0]["capability_check_json"], dict)
    assert rows[0]["capability_check_json"]["granted"] == ["external-fetch:annotation"]
    s.close()


def test_provider_metrics_counts_total_cache_hits_failures(tmp_path):
    s = _store(tmp_path)
    now = datetime.now(timezone.utc)
    _seed_log_row(s, recorded_at=now, cache_hit=False, latency_ms=100)
    _seed_log_row(s, recorded_at=now, cache_hit=True, latency_ms=2)
    _seed_log_row(
        s,
        recorded_at=now,
        cache_hit=False,
        latency_ms=500,
        failure_kind="provider_error",
        status_code=502,
    )

    m = logmod.provider_metrics(s, "uniprot")
    assert m.provider == "uniprot"
    assert m.total_fetches == 3
    assert m.cache_hits == 1
    assert m.failures == 1
    assert m.failures_by_kind == {"provider_error": 1}
    s.close()


def test_provider_metrics_percentile_latency(tmp_path):
    s = _store(tmp_path)
    now = datetime.now(timezone.utc)
    for ms in [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 1000]:
        _seed_log_row(s, recorded_at=now, latency_ms=ms)

    m = logmod.provider_metrics(s, "uniprot")
    assert m.p50_latency_ms == 60
    assert m.p95_latency_ms == 1000
    s.close()


def test_provider_metrics_empty_window_returns_none_percentiles(tmp_path):
    s = _store(tmp_path)
    m = logmod.provider_metrics(s, "uniprot")
    assert m.total_fetches == 0
    assert m.p50_latency_ms is None
    assert m.p95_latency_ms is None
    assert m.p99_latency_ms is None
    assert m.failures_by_kind == {}
    s.close()


def test_provider_metrics_bytes_received_total(tmp_path):
    s = _store(tmp_path)
    now = datetime.now(timezone.utc)
    _seed_log_row(s, recorded_at=now, bytes_received=1024)
    _seed_log_row(s, recorded_at=now, bytes_received=2048)
    _seed_log_row(s, recorded_at=now, bytes_received=None)
    m = logmod.provider_metrics(s, "uniprot")
    assert m.bytes_received_total == 3072
    s.close()


def test_provider_metrics_window_excludes_stale(tmp_path):
    s = _store(tmp_path)
    now = datetime.now(timezone.utc)
    _seed_log_row(s, recorded_at=now)
    _seed_log_row(s, recorded_at=now - timedelta(hours=2))
    m = logmod.provider_metrics(s, "uniprot")
    assert m.total_fetches == 1
    s.close()


def test_archive_table_created_lazily_on_first_rotation(tmp_path):
    s = _store(tmp_path)
    raw = sqlite3.connect(s.db_path)
    initial_tables = {
        row[0]
        for row in raw.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    assert "external_fetch_log_archive" not in initial_tables
    raw.close()

    logmod.rotate_to_archive(s)

    raw = sqlite3.connect(s.db_path)
    after_tables = {
        row[0]
        for row in raw.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    assert "external_fetch_log_archive" in after_tables
    raw.close()
    s.close()


def test_rotate_moves_only_old_rows(tmp_path):
    s = _store(tmp_path)
    now = datetime.now(timezone.utc)
    fresh = _seed_log_row(s, recorded_at=now - timedelta(days=10))
    stale = _seed_log_row(s, recorded_at=now - timedelta(days=200))

    moved = logmod.rotate_to_archive(s)
    assert moved == 1

    main_rows = s.list_external_fetch_log()
    main_ids = {r["id"] for r in main_rows}
    assert fresh in main_ids
    assert stale not in main_ids

    raw = sqlite3.connect(s.db_path)
    archive_ids = {
        row[0] for row in raw.execute("SELECT id FROM external_fetch_log_archive")
    }
    assert stale in archive_ids
    assert fresh not in archive_ids
    raw.close()
    s.close()


def test_rotate_idempotent_on_double_run(tmp_path):
    s = _store(tmp_path)
    now = datetime.now(timezone.utc)
    _seed_log_row(s, recorded_at=now - timedelta(days=200))

    first = logmod.rotate_to_archive(s)
    second = logmod.rotate_to_archive(s)
    assert first == 1
    assert second == 0
    s.close()


def test_archive_indexes_present_after_first_rotation(tmp_path):
    s = _store(tmp_path)
    logmod.rotate_to_archive(s)
    raw = sqlite3.connect(s.db_path)
    indexes = {
        row[0]
        for row in raw.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'"
        )
    }
    assert "external_fetch_log_archive_provider" in indexes
    assert "external_fetch_log_archive_workspace" in indexes
    raw.close()
    s.close()


def test_archive_preserves_capability_check_json_and_metadata(tmp_path):
    s = _store(tmp_path)
    now = datetime.now(timezone.utc)
    log_id = _seed_log_row(
        s,
        recorded_at=now - timedelta(days=200),
        latency_ms=42,
        bytes_received=1234,
        status_code=200,
    )
    logmod.rotate_to_archive(s)

    raw = sqlite3.connect(s.db_path)
    raw.row_factory = sqlite3.Row
    row = raw.execute(
        "SELECT * FROM external_fetch_log_archive WHERE id = ?", (log_id,)
    ).fetchone()
    assert row is not None
    assert row["latency_ms"] == 42
    assert row["bytes_received"] == 1234
    assert row["status_code"] == 200
    assert "external-fetch:annotation" in row["capability_check_json"]
    assert row["archived_at"] is not None
    raw.close()
    s.close()


def test_vacuum_does_not_crash(tmp_path):
    s = _store(tmp_path)
    now = datetime.now(timezone.utc)
    _seed_log_row(s, recorded_at=now)
    logmod.vacuum_log(s)
    rows = logmod.recent_by_provider(s, "uniprot")
    assert len(rows) == 1
    s.close()


def test_run_retention_pass_returns_summary(tmp_path):
    s = _store(tmp_path)
    now = datetime.now(timezone.utc)
    _seed_log_row(s, recorded_at=now - timedelta(days=200))
    _seed_log_row(s, recorded_at=now - timedelta(days=50))

    summary = logmod.run_retention_pass(s, vacuum=False)
    assert summary == {
        "archived": 1,
        "vacuumed": False,
        "older_than_days": logmod.RETENTION_DAYS,
    }
    s.close()


def test_run_retention_pass_with_vacuum_runs_both(tmp_path):
    s = _store(tmp_path)
    now = datetime.now(timezone.utc)
    _seed_log_row(s, recorded_at=now - timedelta(days=200))

    summary = logmod.run_retention_pass(s, vacuum=True)
    assert summary["vacuumed"] is True
    assert summary["archived"] == 1
    s.close()


def test_run_retention_pass_custom_older_than(tmp_path):
    s = _store(tmp_path)
    now = datetime.now(timezone.utc)
    _seed_log_row(s, recorded_at=now - timedelta(days=10))

    summary = logmod.run_retention_pass(s, older_than_days=7, vacuum=False)
    assert summary["archived"] == 1
    assert summary["older_than_days"] == 7
    s.close()


def test_archive_rows_excluded_from_operational_queries(tmp_path):
    """One-table-per-cardinality-budget: post-archive, recent_by_provider only
    reads the hot table."""
    s = _store(tmp_path)
    now = datetime.now(timezone.utc)
    _seed_log_row(s, recorded_at=now - timedelta(days=200))
    _seed_log_row(s, recorded_at=now - timedelta(minutes=5))

    logmod.rotate_to_archive(s)

    rows = logmod.recent_by_provider(s, "uniprot", since=now - timedelta(days=365))
    assert len(rows) == 1
