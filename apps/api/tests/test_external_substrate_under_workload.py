""" / L1 — Agent substrate validation under combined workload.

Plan section "Risks": *Agent substrate "merged ≠ proven" — bugs under THIS
workload*. This test mitigates that risk by driving Agent's tables (agent_action,
audit_record, agent_artifact) AND the new external_resource tables concurrently,
then asserting:

  1. Agent reads still meet the p95 budget under combined contention.
  2. No torn reads (audit_record FK to agent_action stays valid).
  3. No SQLITE_BUSY leaks — busy_timeout absorbs all WAL writer-checkpoint races.
  4. The audit graph consumed under load matches the writer's intent (every
     agent_action has a result_json + audit_record).

Workload model:
  - Writer A drives Agent: per "agent task" = 3 writes (action insert,
    audit_record insert, action complete). This represents an agent-driven
    external.fetch MCP call.
  - Writer B drives external_resource: per "fetch" = 4 writes (data_file,
    external_resource, fetch_log, xref). This represents the system fetch path.
  - Readers query both surfaces: list_agent_artifacts + get_external_resource.

The point of running BOTH writers concurrently: catch bugs where a write on
one surface (e.g., a long external_resource UPSERT) interleaves badly with a
Agent write and invalidates an invariant.
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
from tests.fixtures.external_resources import canonical_external_resources

P95_BUDGET_AGENT_READ_MS = 50.0


@dataclass
class CombinedReaderResult:
    agent_read_latencies_ms: list[float] = field(default_factory=list)
    external_read_latencies_ms: list[float] = field(default_factory=list)
    busy_errors: int = 0
    torn_reads: int = 0
    other_errors: list[str] = field(default_factory=list)


def _agent_writer(db_path: Path, tasks: int) -> None:
    """Simulate agent-driven external.fetch via Agent surface.

    Each writer thread opens its own ControlPlaneStore — Python's sqlite3 with
    check_same_thread=False permits multi-thread access to one connection, but
    multiple threads racing on the same .commit() can hit a NULL-return crash
    in the C extension. In production the sidecar uses a single writer thread,
    but to validate the busy_timeout pipeline under genuine multi-writer
    contention, each thread takes its own connection. Both connections write
    to the same WAL — exactly the contention pattern we want to test.
    """
    store = ControlPlaneStore(db_path)
    store.ensure_agent_identity("agent-load", scope=["external-fetch:annotation"])
    for i in range(tasks):
        action_id = store.insert_agent_action(
            agent_identity_id="agent-load",
            tool_name="external.fetch",
            parameters={"provider": "uniprot", "external_id": f"P{i:05d}"},
        )
        store.insert_audit_record(
            action_id=action_id,
            actor_kind="agent",
            actor_identity="agent-load",
            actor_scope=["external-fetch:annotation"],
            side_effects=[{"kind": "external_resource_upsert", "seq": i}],
            capability_check={
                "required": ["external-fetch:annotation"],
                "satisfied": True,
            },
        )
        store.insert_agent_artifact(
            agent_identity_id="agent-load",
            action_id=action_id,
            kind="external",
            name=f"uniprot:P{i:05d}",
            source_uri=f"https://www.uniprot.org/uniprotkb/P{i:05d}/entry",
            mime_type="application/json",
            metadata={"agent_seq": i},
            provenance={"action_id": action_id},
            tags=["agent-fetch"],
        )
        store.complete_agent_action(action_id, result={"ok": True, "seq": i})
    store.close()


def _external_writer(db_path: Path, fetches: int) -> None:
    """Simulate system fetch path that this plan adds.

    Independent ControlPlaneStore connection per the rationale on _agent_writer.
    """
    store = ControlPlaneStore(db_path)
    fixtures = canonical_external_resources()
    for i in range(fetches):
        fx = fixtures[i % len(fixtures)]
        sha = f"{i:064x}"
        store.upsert_data_file(
            sha256=sha,
            byte_size=4096,
            source_provider=fx.provider,
        )
        rid = store.upsert_external_resource(
            provider=fx.provider,
            external_id=fx.external_id,
            metadata={**fx.metadata, "system_seq": i},
            data_file_id=sha,
        )
        store.insert_external_fetch_log(
            provider=fx.provider,
            endpoint=fx.external_url,
            method="GET",
            status_code=200,
            latency_ms=80,
            external_resource_id=rid,
            workspace_id="ws-mixed",
            capability_check={
                "required": ["external-fetch:annotation"],
                "satisfied": True,
            },
        )
    store.close()


def _combined_reader(
    db_path: Path,
    iterations: int,
    result: CombinedReaderResult,
) -> None:
    conn = sqlite3.connect(db_path, check_same_thread=False, timeout=5.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        for i in range(iterations):
            try:
                t0 = time.perf_counter()
                artifacts = conn.execute(
                    "SELECT * FROM agent_artifact ORDER BY created_at DESC LIMIT 20"
                ).fetchall()
                agent_ms = (time.perf_counter() - t0) * 1000.0
                result.agent_read_latencies_ms.append(agent_ms)

                if artifacts:
                    action_ids = [a["action_id"] for a in artifacts if a["action_id"]]
                    if action_ids:
                        placeholders = ",".join("?" * len(action_ids))
                        seen = conn.execute(
                            f"SELECT id FROM agent_action WHERE id IN ({placeholders})",
                            action_ids,
                        ).fetchall()
                        if len(seen) < len(action_ids):
                            result.torn_reads += 1

                fx = canonical_external_resources()[i % 9]
                t0 = time.perf_counter()
                conn.execute(
                    "SELECT * FROM external_resource WHERE provider = ? AND external_id = ?",
                    (fx.provider, fx.external_id),
                ).fetchone()
                ext_ms = (time.perf_counter() - t0) * 1000.0
                result.external_read_latencies_ms.append(ext_ms)
            except sqlite3.OperationalError as exc:
                if "database is locked" in str(exc):
                    result.busy_errors += 1
                else:
                    result.other_errors.append(str(exc))
    finally:
        conn.close()


def _p95(samples: list[float]) -> float:
    if not samples:
        return 0.0
    if len(samples) < 20:
        return max(samples)
    return statistics.quantiles(samples, n=100, method="exclusive")[94]


def test_external_substrate_under_workload(tmp_path):
    db_path = tmp_path / "combined.sqlite3"
    bootstrap = ControlPlaneStore(db_path)
    bootstrap.initialize()
    bootstrap.close()

    agent_tasks = 80
    external_fetches = 60
    reader_iterations = 80
    reader_count = 4

    results = [CombinedReaderResult() for _ in range(reader_count)]
    threads: list[threading.Thread] = []

    threads.append(
        threading.Thread(
            target=_agent_writer,
            args=(db_path, agent_tasks),
            name="agent-writer",
            daemon=True,
        )
    )
    threads.append(
        threading.Thread(
            target=_external_writer,
            args=(db_path, external_fetches),
            name="external-writer",
            daemon=True,
        )
    )
    for i, r in enumerate(results):
        threads.append(
            threading.Thread(
                target=_combined_reader,
                args=(db_path, reader_iterations, r),
                name=f"reader-{i}",
                daemon=True,
            )
        )

    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30.0)
        assert not t.is_alive(), f"thread {t.name} hung — substrate broken under load"

    aggregate = CombinedReaderResult()
    for r in results:
        aggregate.agent_read_latencies_ms.extend(r.agent_read_latencies_ms)
        aggregate.external_read_latencies_ms.extend(r.external_read_latencies_ms)
        aggregate.busy_errors += r.busy_errors
        aggregate.torn_reads += r.torn_reads
        aggregate.other_errors.extend(r.other_errors)

    p95_agent = _p95(aggregate.agent_read_latencies_ms)
    p95_ext = _p95(aggregate.external_read_latencies_ms)
    print(
        f"\nCombined external/agent combined-workload report:"
        f"\n  Agent list_agent_artifact   p95 = {p95_agent:.2f}ms (budget {P95_BUDGET_AGENT_READ_MS}ms)"
        f"\n  external_resource lookup     p95 = {p95_ext:.2f}ms"
        f"\n  agent reads = {len(aggregate.agent_read_latencies_ms)},"
        f" external reads = {len(aggregate.external_read_latencies_ms)}"
        f"\n  busy errors = {aggregate.busy_errors}, torn_reads = {aggregate.torn_reads}"
    )

    assert aggregate.busy_errors == 0, "Agent substrate must not surface SQLITE_BUSY"
    assert aggregate.torn_reads == 0, (
        "WAL snapshot must not return artifact rows whose action_id points at "
        "a non-existent action — that would mean the audit graph is torn"
    )
    assert aggregate.other_errors == [], aggregate.other_errors
    assert (
        p95_agent < P95_BUDGET_AGENT_READ_MS
    ), f"Agent read p95 {p95_agent:.2f}ms exceeds {P95_BUDGET_AGENT_READ_MS}ms budget"

    raw = sqlite3.connect(db_path)
    raw.row_factory = sqlite3.Row
    actions = raw.execute("SELECT * FROM agent_action").fetchall()
    incomplete = [a for a in actions if a["completed_at"] is None]
    assert (
        incomplete == []
    ), f"{len(incomplete)} agent_action rows never received complete_agent_action()"
    audit_action_ids = {
        row["action_id"]
        for row in raw.execute("SELECT action_id FROM audit_record").fetchall()
    }
    action_ids = {a["id"] for a in actions}
    missing_audits = action_ids - audit_action_ids
    assert (
        missing_audits == set()
    ), f"{len(missing_audits)} agent_action rows lack audit_record"
    raw.close()


@pytest.mark.slow
def test_dna82_substrate_holds_under_10x_combined_workload(tmp_path):
    """Production-grade scaled run of the combined workload."""
    db_path = tmp_path / "combined-10x.sqlite3"
    bootstrap = ControlPlaneStore(db_path)
    bootstrap.initialize()
    bootstrap.close()

    threads: list[threading.Thread] = []
    results = [CombinedReaderResult() for _ in range(8)]
    threads.append(
        threading.Thread(
            target=_agent_writer, args=(db_path, 400), name="agent-writer", daemon=True
        )
    )
    threads.append(
        threading.Thread(
            target=_external_writer,
            args=(db_path, 300),
            name="external-writer",
            daemon=True,
        )
    )
    for i, r in enumerate(results):
        threads.append(
            threading.Thread(
                target=_combined_reader,
                args=(db_path, 200, r),
                name=f"reader-{i}",
                daemon=True,
            )
        )
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60.0)
        assert not t.is_alive()

    busy = sum(r.busy_errors for r in results)
    torn = sum(r.torn_reads for r in results)
    agent_lat: list[float] = []
    ext_lat: list[float] = []
    for r in results:
        agent_lat.extend(r.agent_read_latencies_ms)
        ext_lat.extend(r.external_read_latencies_ms)
    p95_agent = _p95(agent_lat)
    p95_ext = _p95(ext_lat)
    print(
        f"\nCombined external/agent combined-workload (10x):"
        f"\n  agent p95 = {p95_agent:.2f}ms, ext p95 = {p95_ext:.2f}ms,"
        f" busy={busy}, torn={torn}"
    )
    assert busy == 0
    assert torn == 0
    assert p95_agent < P95_BUDGET_AGENT_READ_MS
