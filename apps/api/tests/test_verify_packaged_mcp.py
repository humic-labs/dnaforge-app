import sqlite3
from contextlib import closing
from datetime import datetime, timezone

import pytest

from scripts import verify_packaged_mcp


class _RecordingConnection:
    def __init__(self) -> None:
        self.executions: list[tuple[str, tuple[str, str]]] = []
        self.committed = False
        self.closed = False
        self.rowcount = 1

    def execute(self, sql: str, parameters: tuple[str, str]) -> "_RecordingConnection":
        self.executions.append((sql, parameters))
        return self

    def commit(self) -> None:
        self.committed = True

    def close(self) -> None:
        self.closed = True


def test_expire_agent_identity_closes_sqlite_before_temp_cleanup(
    monkeypatch, tmp_path
) -> None:
    connection = _RecordingConnection()
    monkeypatch.setattr(
        verify_packaged_mcp.sqlite3,
        "connect",
        lambda _path: connection,
    )

    verify_packaged_mcp._expire_agent_identity(
        tmp_path / "control-plane.sqlite3",
        "packaged-mcp-expired-agent",
    )

    assert connection.committed is True
    assert connection.closed is True
    assert len(connection.executions) == 1
    sql, parameters = connection.executions[0]
    assert sql == "UPDATE agent_identity SET expires_at = ? WHERE id = ?"
    expired_at, identity = parameters
    assert identity == "packaged-mcp-expired-agent"
    assert datetime.fromisoformat(expired_at) < datetime.now(timezone.utc)


def test_expire_agent_identity_updates_exact_real_sqlite_row(tmp_path) -> None:
    db_path = tmp_path / "control-plane.sqlite3"
    with closing(sqlite3.connect(db_path)) as connection:
        connection.execute(
            "CREATE TABLE agent_identity (id TEXT PRIMARY KEY, expires_at TEXT)"
        )
        connection.execute(
            "INSERT INTO agent_identity (id, expires_at) VALUES (?, ?)",
            ("packaged-mcp-expired-agent", "2099-01-01T00:00:00+00:00"),
        )
        connection.commit()

    verify_packaged_mcp._expire_agent_identity(
        db_path,
        "packaged-mcp-expired-agent",
    )

    with closing(sqlite3.connect(db_path)) as connection:
        row = connection.execute("SELECT id, expires_at FROM agent_identity").fetchone()
    assert row is not None
    identity, expired_at = row
    assert identity == "packaged-mcp-expired-agent"
    assert datetime.fromisoformat(expired_at) < datetime.now(timezone.utc)
    db_path.unlink()
    assert db_path.exists() is False


def test_expire_agent_identity_rejects_missing_row(tmp_path) -> None:
    db_path = tmp_path / "control-plane.sqlite3"
    with closing(sqlite3.connect(db_path)) as connection:
        connection.execute(
            "CREATE TABLE agent_identity (id TEXT PRIMARY KEY, expires_at TEXT)"
        )
        connection.commit()

    with pytest.raises(
        verify_packaged_mcp.ProbeFailure,
        match="expected one agent_identity row",
    ):
        verify_packaged_mcp._expire_agent_identity(db_path, "missing-agent")
