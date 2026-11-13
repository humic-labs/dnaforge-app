import sqlite3
from pathlib import Path

import pytest

from src.external.persistent_track_cache import PersistentTrackCache


def test_failed_initialization_retires_the_connection_before_retry(
    tmp_path: Path, monkeypatch
):
    cache = PersistentTrackCache(tmp_path / "cache", max_bytes=1024)
    opened: list[sqlite3.Connection] = []
    connect = cache._new_connection
    evict = cache._evict_to_budget
    failed = False

    def record_connection():
        connection = connect()
        opened.append(connection)
        return connection

    def fail_first_initialization(connection):
        nonlocal failed
        if not failed:
            failed = True
            raise sqlite3.OperationalError("fixture initialization failure")
        return evict(connection)

    monkeypatch.setattr(cache, "_new_connection", record_connection)
    monkeypatch.setattr(cache, "_evict_to_budget", fail_first_initialization)
    assert cache.put("source", "generation", 0, b"bytes") is False
    with pytest.raises(sqlite3.ProgrammingError, match="closed"):
        opened[0].execute("SELECT 1")
    assert cache.put("source", "generation", 0, b"bytes") is True
    assert len(opened) == 2
    assert cache.get("source", "generation", 0, 5) == b"bytes"
    cache.close()


def test_close_is_idempotent_and_next_read_reopens_durable_content(
    tmp_path: Path, monkeypatch
):
    cache = PersistentTrackCache(tmp_path / "cache", max_bytes=1024)
    opened: list[sqlite3.Connection] = []
    connect = cache._new_connection

    def record_connection():
        connection = connect()
        opened.append(connection)
        return connection

    monkeypatch.setattr(cache, "_new_connection", record_connection)
    assert cache.put_blob("fixture", "identity", b"bytes") is True
    cache.close()
    cache.close()
    with pytest.raises(sqlite3.ProgrammingError, match="closed"):
        opened[0].execute("SELECT 1")
    assert cache.get_blob("fixture", "identity") == b"bytes"
    assert len(opened) == 2
    cache.close()
