from __future__ import annotations

import sqlite3

import pytest

from src.control_plane import ControlPlaneStore


@pytest.fixture
def ledger(tmp_path):
    store = ControlPlaneStore(tmp_path / "write-intents.sqlite3")
    store.initialize()
    store._conn.execute("CREATE TABLE intent_proof (id TEXT PRIMARY KEY)")
    store._conn.commit()
    try:
        yield store
    finally:
        store.close()


def test_write_intent_is_committed_under_full_sync_before_returning(ledger):
    observer = sqlite3.connect(ledger.db_path)
    try:
        assert ledger._conn.execute("PRAGMA synchronous").fetchone()[0] == 1
        with ledger.durable_transaction():
            assert ledger._conn.execute("PRAGMA synchronous").fetchone()[0] >= 2
            ledger._conn.execute("INSERT INTO intent_proof VALUES ('action-a')")
            assert observer.execute("SELECT id FROM intent_proof").fetchall() == []
        assert observer.execute("SELECT id FROM intent_proof").fetchall() == [
            ("action-a",)
        ]
        assert ledger._conn.execute("PRAGMA synchronous").fetchone()[0] == 1
        assert not ledger._conn.in_transaction
    finally:
        observer.close()


def test_durable_write_failure_rolls_back_and_restores_the_connection(ledger):
    with pytest.raises(RuntimeError, match="write refused"):
        with ledger.durable_transaction():
            ledger._conn.execute("INSERT INTO intent_proof VALUES ('action-a')")
            raise RuntimeError("write refused")
    assert ledger._conn.execute("SELECT id FROM intent_proof").fetchall() == []
    assert ledger._conn.execute("PRAGMA synchronous").fetchone()[0] == 1
    assert not ledger._conn.in_transaction
    with ledger.transaction():
        ledger._conn.execute("INSERT INTO intent_proof VALUES ('ordinary-action')")


def test_an_inner_scope_cannot_claim_an_uncommitted_outer_write_is_durable(ledger):
    with ledger.transaction():
        with pytest.raises(RuntimeError, match="outermost"):
            with ledger.durable_transaction():
                pytest.fail(
                    "A nested durable boundary must never admit a native write."
                )
        assert ledger._conn.in_transaction
        assert ledger._conn.execute("PRAGMA synchronous").fetchone()[0] == 1


def test_a_commit_failure_cannot_acknowledge_the_native_write_intent(ledger):
    ledger._conn.execute(
        "CREATE TABLE intent_child (action_id TEXT REFERENCES intent_proof(id) "
        "DEFERRABLE INITIALLY DEFERRED)"
    )
    with pytest.raises(sqlite3.IntegrityError):
        with ledger.durable_transaction():
            ledger._conn.execute("INSERT INTO intent_child VALUES ('missing-action')")
    assert ledger._conn.execute("SELECT action_id FROM intent_child").fetchall() == []
    assert not ledger._conn.in_transaction
    assert ledger._conn.execute("PRAGMA synchronous").fetchone()[0] == 1


def test_nested_dao_transactions_keep_the_outer_durable_setting(ledger):
    with ledger.durable_transaction():
        with ledger.transaction():
            ledger._conn.execute("INSERT INTO intent_proof VALUES ('nested-dao')")
            assert ledger._conn.execute("PRAGMA synchronous").fetchone()[0] >= 2
        assert ledger._conn.in_transaction
    assert not ledger._conn.in_transaction
    assert ledger._conn.execute("PRAGMA synchronous").fetchone()[0] == 1


def test_durable_boundary_does_not_downgrade_an_existing_stronger_setting(ledger):
    ledger._conn.execute("PRAGMA synchronous = EXTRA")
    with ledger.durable_transaction():
        assert ledger._conn.execute("PRAGMA synchronous").fetchone()[0] == 3
        ledger._conn.execute("INSERT INTO intent_proof VALUES ('stronger-setting')")
    assert ledger._conn.execute("PRAGMA synchronous").fetchone()[0] == 3


def test_document_write_intent_refuses_an_unqualified_journal_mode(ledger):
    ledger._conn.execute("PRAGMA journal_mode = DELETE")
    with pytest.raises(RuntimeError, match="WAL"):
        with ledger.durable_transaction():
            pytest.fail("The native intent path requires the qualified WAL contract.")
    assert not ledger._conn.in_transaction
