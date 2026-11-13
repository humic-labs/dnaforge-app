""" / L1 — SQLite concurrency load test for the external_resource substrate.

Plan: tools/devops/plans/2026-05-02-bioinformatics-db-substrate.md
Concurrency spec: src/control_plane/EXTERNAL_RESOURCES_CONCURRENCY.md

Validates:
  - WAL mode allows readers to proceed without blocking the writer
  - busy_timeout=5000ms absorbs writer-on-writer contention without surfacing
    SQLITE_BUSY to callers
  - p95 read latency for cache hits  < 50ms (the documented budget)
  - p95 read latency for cache misses < 100ms (the documented budget)
  - 0 SQLITE_BUSY / OperationalError leaks under the simulated 
    resolver-chain workload

Methodology:
  One ControlPlaneStore writer thread + N reader threads, each on its own
  sqlite3 connection against the SAME shared db file. The writer simulates
  's resolver chain (10-50 fetches per file open, 4 inserts per fetch).
  The readers simulate the future renderer L1-cache reconcile-on-read pattern
  (lookup by (provider, external_id) — both hits and misses).

The default test runs in <1s and is a hard gate. A `slow` variant scaled 10×
runs the same assertions for production-grade validation; opt in with
`pytest -m slow`.
"""

from __future__ import annotations

import sqlite3
import statistics
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from src.control_plane.store import ControlPlaneStore
from tests.fixtures.external_resources import (
    canonical_external_resources,
    canonical_xrefs,
)

P95_BUDGET_HIT_MS = 50.0
P95_BUDGET_MISS_MS = 100.0


@dataclass
class ReaderResult:
    hit_latencies_ms: list[float] = field(default_factory=list)
    miss_latencies_ms: list[float] = field(default_factory=list)
    busy_errors: int = 0
    other_errors: list[str] = field(default_factory=list)


def _writer_workload(
    store: ControlPlaneStore,
    fetches_per_file: int,
    files_to_open: int,
    progress_event: threading.Event,
) -> None:
    """Simulate  resolver chain — N file-opens × M fetches × 4 inserts.

    Per fetch:
      1) upsert_data_file
      2) upsert_external_resource (FK to data_file)
      3) insert_external_fetch_log (FK to external_resource)
      4) upsert_external_resource_xref (FK to two external_resource rows)
    """
    fixtures = canonical_external_resources()
    xref_specs = canonical_xrefs()

    seq = 0
    for file_idx in range(files_to_open):
        for fetch_idx in range(fetches_per_file):
            fx = fixtures[seq % len(fixtures)]
            sha = f"{seq:064x}"
            store.upsert_data_file(
                sha256=sha,
                byte_size=10_000 + (seq * 13) % 100_000,
                source_provider=fx.provider,
                source_url=fx.external_url,
                license=fx.license,
                attribution=fx.attribution,
            )
            rid = store.upsert_external_resource(
                provider=fx.provider,
                external_id=fx.external_id,
                metadata={**fx.metadata, "writer_seq": seq},
                external_url=fx.external_url,
                data_file_id=sha,
                version_identifier=f"{fx.version_identifier}#{file_idx}.{fetch_idx}",
                license=fx.license,
                attribution=fx.attribution,
            )
            store.insert_external_fetch_log(
                provider=fx.provider,
                endpoint=fx.external_url,
                method="GET",
                status_code=200,
                latency_ms=85,
                bytes_received=10_000 + (seq * 13) % 100_000,
                cache_hit=False,
                external_resource_id=rid,
                workspace_id=f"ws-load-{file_idx % 4}",
                capability_check={
                    "required": ["external-fetch:annotation"],
                    "satisfied": True,
                },
            )

            xref = xref_specs[seq % len(xref_specs)]
            from_id = store.upsert_external_resource(
                provider=xref.from_provider,
                external_id=xref.from_external_id,
                metadata={"name": xref.from_external_id},
            )
            to_id = store.upsert_external_resource(
                provider=xref.to_provider,
                external_id=xref.to_external_id,
                metadata={"name": xref.to_external_id},
            )
            store.upsert_external_resource_xref(
                from_resource_id=from_id,
                to_resource_id=to_id,
                xref_type=xref.xref_type,
                evidence=xref.evidence,
                source_provider=xref.source_provider,
                confidence=xref.confidence,
                identity=xref.identity,
                coverage=xref.coverage,
            )
            seq += 1

            if seq >= len(fixtures):
                progress_event.set()


def _reader_workload(
    db_path: Path,
    reads: int,
    progress_event: threading.Event,
    result: ReaderResult,
) -> None:
    """Simulate renderer L1-cache reconcile-on-read.

    50/50 split between cache hits (real fixture accessions, very likely to
    exist after the first writer-fetch lands) and cache misses (synthetic
    lookups for accessions the writer never touches — measures the
    not-yet-cached path latency).

    Reads through the DAO method `get_external_resource_by_external_id`, which
    runs `_row_to_dict` JSON deserialization — so the measured latency reflects
    what real callers pay, not raw `SELECT *` numbers.
    """
    fixtures = canonical_external_resources()
    miss_targets = [
        ("uniprot", "Q9_MISS_A"),
        ("uniprot", "Q9_MISS_B"),
        ("rcsb", "ZZZZ"),
        ("alphafold", "AF-Q9_MISS-F1"),
    ]
    if not progress_event.wait(timeout=1.0):
        result.other_errors.append(
            "Writer did not prime the cache-hit fixtures within 1s"
        )
        return
    reader_store = ControlPlaneStore(db_path)
    try:
        for i in range(reads):
            if i % 2 == 0:
                fx = fixtures[i % len(fixtures)]
                provider, external_id = fx.provider, fx.external_id
                kind = "hit"
            else:
                provider, external_id = miss_targets[i % len(miss_targets)]
                kind = "miss"

            t0 = time.perf_counter()
            try:
                row = reader_store.get_external_resource_by_external_id(
                    provider, external_id
                )
            except sqlite3.OperationalError as exc:
                if "database is locked" in str(exc):
                    result.busy_errors += 1
                else:
                    result.other_errors.append(str(exc))
                continue
            elapsed_ms = (time.perf_counter() - t0) * 1000.0
            if kind == "hit":

                if row is not None:
                    result.hit_latencies_ms.append(elapsed_ms)
                else:

                    result.miss_latencies_ms.append(elapsed_ms)
            else:

                assert row is None
                result.miss_latencies_ms.append(elapsed_ms)
    finally:
        reader_store.close()


def _run_concurrent_workload(
    tmp_path: Path,
    *,
    files_to_open: int,
    fetches_per_file: int,
    reader_count: int,
    reads_per_reader: int,
) -> tuple[ReaderResult, ControlPlaneStore]:
    """Spin up writer + readers, run to completion, aggregate results."""
    db_path = tmp_path / "load.sqlite3"
    store = ControlPlaneStore(db_path)
    store.initialize()

    fx = canonical_external_resources()[0]
    store.upsert_external_resource(
        provider=fx.provider,
        external_id=fx.external_id,
        metadata=fx.metadata,
    )

    progress_event = threading.Event()
    aggregate = ReaderResult()
    per_reader_results = [ReaderResult() for _ in range(reader_count)]
    threads: list[threading.Thread] = []

    writer_thread = threading.Thread(
        target=_writer_workload,
        args=(store, fetches_per_file, files_to_open, progress_event),
        name="writer",
        daemon=True,
    )
    threads.append(writer_thread)

    for i in range(reader_count):
        t = threading.Thread(
            target=_reader_workload,
            args=(db_path, reads_per_reader, progress_event, per_reader_results[i]),
            name=f"reader-{i}",
            daemon=True,
        )
        threads.append(t)

    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30.0)
        assert (
            not t.is_alive()
        ), f"thread {t.name} hung past 30s — concurrency budget broken"

    for r in per_reader_results:
        aggregate.hit_latencies_ms.extend(r.hit_latencies_ms)
        aggregate.miss_latencies_ms.extend(r.miss_latencies_ms)
        aggregate.busy_errors += r.busy_errors
        aggregate.other_errors.extend(r.other_errors)

    return aggregate, store


def _p95(samples: list[float]) -> float:
    if not samples:
        return 0.0
    if len(samples) < 20:
        return max(samples)

    cuts = statistics.quantiles(samples, n=100, method="exclusive")
    return cuts[94]


def test_concurrency_load_meets_p95_budgets_under_dna98_workload(tmp_path):
    aggregate, store = _run_concurrent_workload(
        tmp_path,
        files_to_open=4,
        fetches_per_file=12,
        reader_count=4,
        reads_per_reader=80,
    )

    assert (
        aggregate.busy_errors == 0
    ), f"busy_timeout=5000ms must absorb all SQLITE_BUSY; got {aggregate.busy_errors}"
    assert (
        aggregate.other_errors == []
    ), f"unexpected reader errors: {aggregate.other_errors}"

    assert len(aggregate.hit_latencies_ms) >= 30, (
        f"too few hit samples ({len(aggregate.hit_latencies_ms)}) — "
        "test parameters likely tuned wrong"
    )
    assert (
        len(aggregate.miss_latencies_ms) >= 30
    ), f"too few miss samples ({len(aggregate.miss_latencies_ms)})"

    p95_hit = _p95(aggregate.hit_latencies_ms)
    p95_miss = _p95(aggregate.miss_latencies_ms)
    print(
        f"\nDNA-100 concurrency report:"
        f"\n  hit p95  = {p95_hit:.2f}ms (budget {P95_BUDGET_HIT_MS}ms)"
        f"\n  miss p95 = {p95_miss:.2f}ms (budget {P95_BUDGET_MISS_MS}ms)"
        f"\n  hits = {len(aggregate.hit_latencies_ms)}, "
        f"misses = {len(aggregate.miss_latencies_ms)}"
        f"\n  busy = {aggregate.busy_errors}"
    )

    assert (
        p95_hit < P95_BUDGET_HIT_MS
    ), f"p95 cache-hit latency {p95_hit:.2f}ms exceeds {P95_BUDGET_HIT_MS}ms budget"
    assert (
        p95_miss < P95_BUDGET_MISS_MS
    ), f"p95 cache-miss latency {p95_miss:.2f}ms exceeds {P95_BUDGET_MISS_MS}ms budget"

    raw = sqlite3.connect(store.db_path)
    er_count = raw.execute("SELECT COUNT(*) FROM external_resource").fetchone()[0]
    log_count = raw.execute("SELECT COUNT(*) FROM external_fetch_log").fetchone()[0]
    df_count = raw.execute("SELECT COUNT(*) FROM data_file").fetchone()[0]
    raw.close()
    assert er_count >= 9
    assert log_count >= 48
    assert df_count >= 48
    store.close()


@pytest.mark.slow
def test_concurrency_load_holds_under_10x_workload(tmp_path):
    """10× the default workload — proves the budget holds at production volume."""
    aggregate, store = _run_concurrent_workload(
        tmp_path,
        files_to_open=10,
        fetches_per_file=50,
        reader_count=8,
        reads_per_reader=200,
    )
    assert aggregate.busy_errors == 0
    assert aggregate.other_errors == []
    p95_hit = _p95(aggregate.hit_latencies_ms)
    p95_miss = _p95(aggregate.miss_latencies_ms)
    print(
        f"\nDNA-100 concurrency report (10x):"
        f"\n  hit p95  = {p95_hit:.2f}ms"
        f"\n  miss p95 = {p95_miss:.2f}ms"
    )
    assert p95_hit < P95_BUDGET_HIT_MS
    assert p95_miss < P95_BUDGET_MISS_MS
    store.close()


def test_per_fetch_write_amplification_is_within_documented_budget(tmp_path):
    db_path = tmp_path / "amp.sqlite3"
    store = ControlPlaneStore(db_path)
    store.initialize()

    raw = sqlite3.connect(db_path)
    before = sum(
        raw.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        for t in (
            "data_file",
            "external_resource",
            "external_resource_xref",
            "external_fetch_log",
        )
    )

    sha = "f" * 64
    store.upsert_data_file(sha256=sha, byte_size=1024, source_provider="rcsb")
    rid_uniprot = store.upsert_external_resource(
        provider="uniprot",
        external_id="P00875",
        metadata={"name": "RuBisCO"},
    )
    rid_pdb = store.upsert_external_resource(
        provider="rcsb",
        external_id="1RBL",
        metadata={"title": "RuBisCO crystal"},
        data_file_id=sha,
    )
    store.insert_external_fetch_log(
        provider="rcsb",
        endpoint="https://files.rcsb.org/download/1RBL.cif",
        method="GET",
        external_resource_id=rid_pdb,
        capability_check={"required": ["external-fetch:structure"], "satisfied": True},
    )
    store.upsert_external_resource_xref(
        from_resource_id=rid_uniprot,
        to_resource_id=rid_pdb,
        xref_type="has_structure",
        evidence="asserted",
        source_provider="uniprot",
    )

    after = sum(
        raw.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        for t in (
            "data_file",
            "external_resource",
            "external_resource_xref",
            "external_fetch_log",
        )
    )
    raw.close()
    inserted = after - before

    assert inserted == 5, f"expected 5 row inserts, got {inserted}"
    store.close()
