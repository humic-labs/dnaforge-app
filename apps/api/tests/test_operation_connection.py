import json
import os
import stat
import subprocess
import sys

from src.operation_connection import (
    process_alive,
    prune_dead_operation_connections,
    publish_operation_connection,
    retire_operation_connection,
)


def test_connection_is_private_and_retirement_cannot_remove_a_successor(tmp_path):
    path = tmp_path / "runtime" / "connection.json"
    publish_operation_connection(
        path,
        url="http://127.0.0.1:8004",
        session_token="session",
        operation_token="human",
        scope_id="scope",
        owner_id="local-human",
        owner_instance="first",
        mcp_stdio=True,
    )
    body = json.loads(path.read_text())
    assert body["owner_instance"] == "first"
    assert body["operation_token"] == "human"
    assert body["mcp_stdio"] is True
    if os.name != "nt":
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
    publish_operation_connection(
        path,
        url="http://127.0.0.1:8004",
        session_token="next-session",
        operation_token="next-human",
        scope_id="scope",
        owner_id="local-human",
        owner_instance="second",
        mcp_stdio=True,
    )
    retire_operation_connection(path, owner_instance="first")
    assert json.loads(path.read_text())["owner_instance"] == "second"
    retire_operation_connection(path, owner_instance="second")
    assert not path.exists()


def _dead_pid() -> int:
    child = subprocess.Popen([sys.executable, "-c", "pass"])
    child.wait()
    return child.pid


def _receipt(directory, name, **fields):
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{name}.connection.json"
    path.write_text(json.dumps({"version": 1, **fields}))
    path.chmod(0o600)
    return path


def test_process_alive_distinguishes_running_and_exited_processes():
    assert process_alive(os.getpid())
    assert not process_alive(_dead_pid())
    assert not process_alive(0)


def test_prune_removes_only_receipts_whose_process_is_gone(tmp_path):
    dead = _receipt(tmp_path, "dead", pid=_dead_pid())
    live = _receipt(tmp_path, "live", pid=os.getpid())
    legacy = _receipt(tmp_path, "legacy")
    prune_dead_operation_connections(tmp_path)
    assert not dead.exists()
    assert live.exists()
    assert legacy.exists()


def test_prune_spares_a_successor_that_replaced_the_receipt(tmp_path, monkeypatch):
    path = _receipt(tmp_path, "runtime", pid=_dead_pid())

    def successor_publishes(pid):
        replacement = tmp_path / "replacement"
        replacement.write_text(json.dumps({"version": 1, "pid": os.getpid()}))
        os.replace(replacement, path)
        return False

    monkeypatch.setattr("src.operation_connection.process_alive", successor_publishes)
    prune_dead_operation_connections(tmp_path)
    assert json.loads(path.read_text())["pid"] == os.getpid()


def test_publishing_a_runtime_prunes_crashed_predecessors(tmp_path):
    crashed = _receipt(tmp_path, "crashed", pid=_dead_pid())
    publish_operation_connection(
        tmp_path / "current.connection.json",
        url="http://127.0.0.1:8004",
        session_token="session",
        operation_token="human",
        scope_id="scope",
        owner_id="local-human",
        owner_instance="first",
    )
    assert not crashed.exists()
    assert (tmp_path / "current.connection.json").exists()
