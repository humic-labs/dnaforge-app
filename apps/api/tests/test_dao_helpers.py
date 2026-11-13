"""/101 / L0 — direct DAO tests for the helpers  added to
ControlPlaneStore: `transaction()` context manager + `upsert_external_resource_stub`.

The HARNESS_AUDIT.md identified these as having only INDIRECT coverage —
indirect-only means a refactor that breaks the helper's contract while
keeping the integration tests green is possible. Pin the contract directly
so the helper can never silently regress.
"""

from __future__ import annotations

import sqlite3

import pytest

from src.control_plane.store import ControlPlaneStore


def test_transaction_commits_atomic_batch(tmp_path):
    """Multiple DAO writes inside `with store.transaction():` land as ONE
    commit — visible to a reader only after the block exits successfully."""
    store = ControlPlaneStore(tmp_path / "tx.sqlite3")
    store.initialize()

    sha_a = "a" * 64
    sha_b = "b" * 64

    with store.transaction():
        store.upsert_data_file(sha256=sha_a, byte_size=10, source_provider="rcsb")
        store.upsert_data_file(sha256=sha_b, byte_size=20, source_provider="rcsb")

    raw = sqlite3.connect(store.db_path)
    count = raw.execute("SELECT COUNT(*) FROM data_file").fetchone()[0]
    raw.close()
    assert count == 2
    store.close()


def test_transaction_rolls_back_on_exception(tmp_path):
    """If the user block raises, ROLLBACK unwinds every DAO write. The
    substrate ends up exactly where it started — no torn state."""
    store = ControlPlaneStore(tmp_path / "tx.sqlite3")
    store.initialize()

    sha = "c" * 64

    with pytest.raises(RuntimeError, match="user code blew up"):
        with store.transaction():
            store.upsert_data_file(sha256=sha, byte_size=10, source_provider="rcsb")
            raise RuntimeError("user code blew up")

    raw = sqlite3.connect(store.db_path)
    count = raw.execute("SELECT COUNT(*) FROM data_file").fetchone()[0]
    raw.close()
    assert count == 0
    store.close()


def test_transaction_uses_begin_immediate_not_deferred(tmp_path):
    """BEGIN IMMEDIATE is load-bearing — it eliminates the WAL writer-lock
    upgrade race that DEFERRED would surface as SQLITE_BUSY mid-batch.
    Pin the wire-level statement via sqlite3's trace callback so a refactor
    to `BEGIN` (deferred) is caught at test time, not under production
    contention.
    """
    store = ControlPlaneStore(tmp_path / "tx.sqlite3")
    store.initialize()

    statements: list[str] = []
    store._conn.set_trace_callback(statements.append)
    try:
        with store.transaction():
            pass
    finally:
        store._conn.set_trace_callback(None)

    upper = [s.strip().upper() for s in statements]
    assert any(
        s.startswith("BEGIN IMMEDIATE") for s in upper
    ), f"expected BEGIN IMMEDIATE, traced: {upper}"
    assert any(
        s.startswith("COMMIT") for s in upper
    ), f"expected COMMIT, traced: {upper}"
    assert not any(
        s == "BEGIN" or s.startswith("BEGIN DEFERRED") for s in upper
    ), f"saw a non-IMMEDIATE BEGIN: {upper}"
    store.close()


def test_tx_depth_lifecycle(tmp_path):
    """: replaced the `_in_explicit_tx` flag with `_tx_depth` so
    nested `transaction()` calls compose correctly. Depth increments on
    entry, decrements on exit (both happy and exception paths). Per-method
    `_commit()` calls are no-ops while depth > 0."""
    store = ControlPlaneStore(tmp_path / "tx.sqlite3")
    store.initialize()

    assert store._tx_depth == 0

    with store.transaction():
        assert store._tx_depth == 1

    assert store._tx_depth == 0

    with pytest.raises(ValueError):
        with store.transaction():
            assert store._tx_depth == 1
            raise ValueError("forced")

    assert store._tx_depth == 0
    store.close()


def test_transaction_per_method_commits_become_noops_inside_block(tmp_path):
    """A DAO method that calls `self._commit()` mid-block must NOT end the
    transaction. This is the load-bearing reason for the `_tx_depth`
    counter — without it, a single call to `upsert_data_file` would commit
    the row before the next DAO call ran, breaking atomicity."""
    store = ControlPlaneStore(tmp_path / "tx.sqlite3")
    store.initialize()

    sha = "d" * 64

    with pytest.raises(RuntimeError):
        with store.transaction():
            store.upsert_data_file(sha256=sha, byte_size=10, source_provider="rcsb")
            raise RuntimeError("force rollback")

    raw = sqlite3.connect(store.db_path)
    count = raw.execute("SELECT COUNT(*) FROM data_file").fetchone()[0]
    raw.close()
    assert count == 0, "per-method _commit() ended the tx prematurely"
    store.close()


def test_upsert_external_resource_stub_inserts_when_absent(tmp_path):
    """Stub UPSERT on an empty table inserts a fresh row and returns its id."""
    store = ControlPlaneStore(tmp_path / "stub.sqlite3")
    store.initialize()

    stub_id = store.upsert_external_resource_stub(provider="rcsb", external_id="1RBL")
    assert stub_id

    row = store.get_external_resource(stub_id)
    assert row is not None
    assert row["provider"] == "rcsb"
    assert row["external_id"] == "1RBL"
    assert row["metadata_json"]["_stub"] is True
    store.close()


def test_upsert_external_resource_stub_preserves_real_metadata(tmp_path):
    """**The  review-driven fix.** A regular UPSERT on a row that's
    already been fully fetched would overwrite `metadata_json` with the
    stub's `{"_stub": True}`, silently destroying real provider data on
    the second fetch. The stub helper uses INSERT ... ON CONFLICT DO
    NOTHING so the existing row is preserved untouched.

    Sequence:
      1. Service fetches PDB 1RBL fully → real metadata persisted.
      2. Later service fetches UniProt P00875 → asserts xref to 1RBL →
         calls upsert_external_resource_stub('rcsb', '1RBL') to ensure
         the FK target exists.
      3. The stub call MUST return the existing canonical id and MUST NOT
         touch the existing real metadata.
    """
    store = ControlPlaneStore(tmp_path / "stub.sqlite3")
    store.initialize()

    real_id = store.upsert_external_resource(
        provider="rcsb",
        external_id="1RBL",
        metadata={
            "title": "RuBisCO crystal structure",
            "method": "X-RAY DIFFRACTION",
            "resolution_a": 2.2,
        },
        external_url="https://www.rcsb.org/structure/1RBL",
        license="public-domain",
    )

    stub_id = store.upsert_external_resource_stub(provider="rcsb", external_id="1RBL")

    assert stub_id == real_id

    row = store.get_external_resource(real_id)
    assert row is not None
    assert row["metadata_json"]["title"] == "RuBisCO crystal structure"
    assert row["metadata_json"]["method"] == "X-RAY DIFFRACTION"
    assert row["metadata_json"]["resolution_a"] == 2.2
    assert "_stub" not in row["metadata_json"]
    assert row["external_url"] == "https://www.rcsb.org/structure/1RBL"
    assert row["license"] == "public-domain"
    store.close()


def test_upsert_external_resource_stub_idempotent_repeated_calls(tmp_path):
    """Calling stub UPSERT N times for the same (provider, external_id)
    returns the same canonical id every time and creates exactly one row."""
    store = ControlPlaneStore(tmp_path / "stub.sqlite3")
    store.initialize()

    ids = [
        store.upsert_external_resource_stub(provider="rcsb", external_id="1RBL")
        for _ in range(5)
    ]

    assert len(set(ids)) == 1, f"stub calls returned different ids: {ids}"
    raw = sqlite3.connect(store.db_path)
    count = raw.execute("SELECT COUNT(*) FROM external_resource").fetchone()[0]
    raw.close()
    assert count == 1
    store.close()


@pytest.mark.parametrize(
    "field,bad_value,description",
    [
        ("status_code", 99, "below HTTP range"),
        ("status_code", 600, "above HTTP range"),
        ("latency_ms", -1, "negative latency"),
        ("bytes_received", -1, "negative bytes"),
        ("cache_hit", 2, "cache_hit not in (0, 1)"),
    ],
)
def test_external_fetch_log_check_constraints(tmp_path, field, bad_value, description):
    """Every numeric CHECK constraint on external_fetch_log rejects out-of-
    bounds values. A maintainer adding a new HTTP/3 status code outside
    [100,599], or surfacing clock-skew negative latencies, hits the schema
    boundary at insert time — not at production read time."""
    store = ControlPlaneStore(tmp_path / "checks.sqlite3")
    store.initialize()

    valid_kwargs = {
        "provider": "uniprot",
        "endpoint": "https://rest.uniprot.org/uniprotkb/P00875.json",
        "method": "GET",
        "capability_check": {
            "required": ["external-fetch:annotation"],
            "satisfied": True,
        },
        "status_code": 200,
        "latency_ms": 85,
        "bytes_received": 1024,
        "cache_hit": False,
    }
    valid_kwargs[field] = bad_value
    if field == "cache_hit":
        with pytest.raises(sqlite3.IntegrityError):
            store._conn.execute(
                """
                INSERT INTO external_fetch_log (
                  id, provider, endpoint, method, status_code, latency_ms,
                  bytes_received, cache_hit, capability_check_json, recorded_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "test-id",
                    "uniprot",
                    "https://x.test",
                    "GET",
                    200,
                    85,
                    1024,
                    bad_value,
                    "{}",
                    "2026-05-02T00:00:00Z",
                ),
            )
    else:
        with pytest.raises(sqlite3.IntegrityError):
            store.insert_external_fetch_log(**valid_kwargs)
    store.close()


@pytest.mark.parametrize(
    "sha256_value,description",
    [
        ("0" * 63, "63 chars too short"),
        ("0" * 65, "65 chars too long"),
        ("", "empty string"),
    ],
)
def test_data_file_sha256_check_constraints(tmp_path, sha256_value, description):
    """`data_file.sha256` MUST be exactly 64 chars. A regression that drops
    the length check would silently allow truncated/malformed cache keys
    to alias unrelated content under one row."""
    store = ControlPlaneStore(tmp_path / "checks.sqlite3")
    store.initialize()
    with pytest.raises(sqlite3.IntegrityError):
        store.upsert_data_file(
            sha256=sha256_value,
            byte_size=1024,
            source_provider="rcsb",
        )
    store.close()


def test_data_file_byte_size_must_be_non_negative(tmp_path):
    """byte_size negative is invalid — corrupted size_bytes would otherwise
    poison disk usage accounting."""
    store = ControlPlaneStore(tmp_path / "checks.sqlite3")
    store.initialize()
    with pytest.raises(sqlite3.IntegrityError):
        store.upsert_data_file(
            sha256="a" * 64,
            byte_size=-1,
            source_provider="rcsb",
        )
    store.close()


def test_transaction_serializes_concurrent_writers(tmp_path):
    """Two threads each open `transaction()` and write a row. Both commits
    succeed without SQLITE_BUSY; both rows are present after both threads
    finish (the lock guarantees one outer transaction at a time)."""
    import threading

    store = ControlPlaneStore(tmp_path / "concurrent.sqlite3")
    store.initialize()

    barrier = threading.Barrier(2)
    errors: list[Exception] = []

    def writer(sha: str) -> None:
        try:
            barrier.wait()
            with store.transaction():
                store.upsert_data_file(sha256=sha, byte_size=10, source_provider="rcsb")
        except Exception as exc:  # noqa: BLE001 — surfaced via errors list
            errors.append(exc)

    sha_a = "a" * 64
    sha_b = "b" * 64
    threads = [
        threading.Thread(target=writer, args=(sha_a,)),
        threading.Thread(target=writer, args=(sha_b,)),
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=5)

    assert errors == [], f"unexpected exceptions: {errors!r}"
    raw = sqlite3.connect(store.db_path)
    found = {row[0] for row in raw.execute("SELECT sha256 FROM data_file")}
    raw.close()
    assert found == {sha_a, sha_b}
    store.close()


def test_transaction_supports_reentrant_same_thread(tmp_path):
    """Helper-of-helper: outer transaction calls a method that itself wraps
    its writes in `with store.transaction():`. Inner block does NOT issue a
    second BEGIN IMMEDIATE (SQLite would reject it). Outer block commits
    once; both writes land atomically."""
    store = ControlPlaneStore(tmp_path / "reentrant.sqlite3")
    store.initialize()

    sha_outer = "1" * 64
    sha_inner = "2" * 64

    def inner() -> None:
        with store.transaction():
            store.upsert_data_file(
                sha256=sha_inner, byte_size=20, source_provider="rcsb"
            )

    with store.transaction():
        store.upsert_data_file(sha256=sha_outer, byte_size=10, source_provider="rcsb")
        inner()

    raw = sqlite3.connect(store.db_path)
    found = {row[0] for row in raw.execute("SELECT sha256 FROM data_file")}
    raw.close()
    assert found == {sha_outer, sha_inner}
    store.close()


def test_reentrant_transaction_rolls_back_outer_on_inner_exception(tmp_path):
    """Inner block raises → exception propagates to outer block → outer's
    ROLLBACK unwinds BOTH writes. Pins the rollback semantics under nesting
    (re-entry must NOT swallow the error mid-stack)."""
    store = ControlPlaneStore(tmp_path / "reentrant_rollback.sqlite3")
    store.initialize()

    def inner() -> None:
        with store.transaction():
            store.upsert_data_file(
                sha256="2" * 64, byte_size=20, source_provider="rcsb"
            )
            raise RuntimeError("inner blew up")

    with pytest.raises(RuntimeError, match="inner blew up"):
        with store.transaction():
            store.upsert_data_file(
                sha256="1" * 64, byte_size=10, source_provider="rcsb"
            )
            inner()

    raw = sqlite3.connect(store.db_path)
    count = raw.execute("SELECT COUNT(*) FROM data_file").fetchone()[0]
    raw.close()
    assert count == 0
    store.close()


def test_commit_suppressed_inside_explicit_transaction(tmp_path):
    """`_commit()` MUST be a no-op while transaction depth > 0 — otherwise
    per-method commits would break the outer block's atomicity. Asserts the
    invariant directly: outside tx, depth=0 and _commit calls through;
    inside tx, depth=1 and _commit returns early."""
    store = ControlPlaneStore(tmp_path / "commit_gate.sqlite3")
    store.initialize()

    assert store._tx_depth == 0
    store._commit()

    with store.transaction():
        assert store._tx_depth == 1
        store._commit()
        store.upsert_data_file(sha256="c" * 64, byte_size=10, source_provider="rcsb")
        with store.transaction():
            assert store._tx_depth == 2

    assert store._tx_depth == 0
    store.close()


def test_upsert_agent_artifact_for_action_rejects_null_action_id(tmp_path):
    """ second-pass review fix: the partial unique index covers
    only `action_id IS NOT NULL`, so a NULL action_id silently loses
    idempotency on retry (every call inserts a fresh row). The defensive
    guard makes the contract enforceable at runtime, not just in the type
    checker. Callers needing action-less artifacts must use
    `insert_agent_artifact` instead."""
    store = ControlPlaneStore(tmp_path / "artifact_guard.sqlite3")
    store.initialize()
    store.ensure_agent_identity("agent-1", scope=["external-fetch:annotation"])
    for bad_value in (None, "", 0, False):
        with pytest.raises(ValueError, match="non-null action_id"):
            store.upsert_agent_artifact_for_action(
                agent_identity_id="agent-1",
                action_id=bad_value,  # type: ignore[arg-type]
                kind="external",
                name="uniprot:P00875",
            )
    store.close()


def test_vacuum_raises_when_called_inside_explicit_transaction(tmp_path):
    """ second-pass review fix: vacuum() previously bypassed the
    tx_lock and tx_depth, so a thread inside transaction() colliding with
    another thread's vacuum_log() would hit SQLite's 'cannot VACUUM from
    within a transaction' error. The guard raises a clear RuntimeError
    when called inside an explicit tx; the lock serializes against
    concurrent transaction() callers."""
    store = ControlPlaneStore(tmp_path / "vacuum_guard.sqlite3")
    store.initialize()
    with store.transaction():
        with pytest.raises(RuntimeError, match="cannot run inside an explicit"):
            store.vacuum()
    store.vacuum()
    store.close()


def test_transaction_lock_preserves_depth_across_threads(tmp_path):
    """Ensure thread A's depth counter never bleeds into thread B's view.
    Even with `check_same_thread=False`, the RLock makes the outer-tx view
    consistent: when B finally enters after A exits, B sees depth=0 (its
    own outer block) and issues a fresh BEGIN IMMEDIATE."""
    import threading

    store = ControlPlaneStore(tmp_path / "depth_isolation.sqlite3")
    store.initialize()

    a_inside = threading.Event()
    a_release = threading.Event()
    observed_depths: list[int] = []

    def thread_a() -> None:
        with store.transaction():
            observed_depths.append(("A_inside", store._tx_depth))
            a_inside.set()
            a_release.wait(timeout=2)
            store.upsert_data_file(
                sha256="a" * 64, byte_size=10, source_provider="rcsb"
            )

    def thread_b() -> None:
        a_inside.wait(timeout=2)
        with store.transaction():
            observed_depths.append(("B_inside", store._tx_depth))
            store.upsert_data_file(
                sha256="b" * 64, byte_size=20, source_provider="rcsb"
            )

    ta = threading.Thread(target=thread_a)
    tb = threading.Thread(target=thread_b)
    ta.start()
    tb.start()
    a_inside.wait(timeout=2)
    a_release.set()
    ta.join(timeout=5)
    tb.join(timeout=5)

    assert ("A_inside", 1) in observed_depths
    assert ("B_inside", 1) in observed_depths
    store.close()
