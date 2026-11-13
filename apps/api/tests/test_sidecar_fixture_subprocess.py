import hashlib
import json
import os
import secrets
import signal
import socket
import sqlite3
import subprocess
import sys
import time
from contextlib import closing, contextmanager
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from src.control_plane import ControlPlaneStore
from tests import test_sidecar_integration as integration

pytestmark = pytest.mark.slow


@dataclass
class OwnedChild:
    process: subprocess.Popen
    database: Path
    stdout: object
    stderr: object


def available_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def process_group_exists(pid):
    try:
        os.killpg(pid, 0)
    except ProcessLookupError:
        return False
    return True


def assert_child_retired(child):
    assert child.process.poll() is not None
    assert not process_group_exists(child.process.pid)
    assert child.stdout.closed
    assert child.stderr.closed


def database_snapshot(path):
    with closing(sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True)) as db:
        state = "\n".join(db.iterdump()).encode()
    return {
        "bytes_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "state_sha256": hashlib.sha256(state).hexdigest(),
    }


def seed_sentinel(path):
    with closing(ControlPlaneStore(path)) as store:
        store.initialize()
        store.ensure_agent_identity(
            "ambient-sentinel-agent",
            scope=["sentinel-only"],
            revoked=True,
            environment_id="ambient-sentinel",
            created_by="sentinel-fixture",
        )
    return database_snapshot(path)


def startup_state(path):
    with closing(sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True)) as db:
        identities = db.execute(
            "SELECT id, scope_json, revoked, environment_id, created_by "
            "FROM agent_identity ORDER BY id"
        ).fetchall()
        owners = db.execute(
            "SELECT runtime_scope FROM managed_operation_owner ORDER BY runtime_scope"
        ).fetchall()
    return {"identities": identities, "runtime_scopes": [row[0] for row in owners]}


@contextmanager
def foreign_listener():
    port = available_port()
    body = f"foreign-listener-{secrets.token_hex(8)}"
    program = "\n".join(
        [
            "import sys",
            "from http.server import BaseHTTPRequestHandler, HTTPServer",
            "class Handler(BaseHTTPRequestHandler):",
            "    def do_GET(self):",
            "        self.send_response(200)",
            "        self.end_headers()",
            "        self.wfile.write(sys.argv[2].encode())",
            "    def log_message(self, *args): pass",
            "HTTPServer(('127.0.0.1', int(sys.argv[1])), Handler).serve_forever()",
        ]
    )
    process = subprocess.Popen(
        [sys.executable, "-c", program, str(port), body],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    url = f"http://127.0.0.1:{port}"
    try:
        deadline = time.monotonic() + 5
        while True:
            assert process.poll() is None
            try:
                if httpx.get(f"{url}/health", timeout=1).text == body:
                    break
            except httpx.ConnectError:
                pass
            if time.monotonic() >= deadline:
                pytest.fail("Synthetic foreign listener did not start")
            time.sleep(0.05)
        yield process, port, url, body
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


@pytest.fixture
def proof(tmp_path):
    root = Path(__file__).resolve().parents[3]
    commit = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=root, text=True
    ).strip()
    expected_commit = os.environ.get("DNAFORGE_SIDECAR_PROOF_COMMIT", commit)
    assert commit == expected_commit
    directory = Path(os.environ.get("DNAFORGE_SIDECAR_PROOF_DIR", tmp_path / "proof"))
    directory.mkdir(parents=True, exist_ok=True)

    def record(case, details):
        (directory / f"{case}.json").write_text(
            json.dumps({"case": case, "commit": commit, "details": details}, indent=2)
            + "\n"
        )

    return record


@pytest.fixture
def observed_launch(monkeypatch, tmp_path_factory):
    assert os.environ.get("DNAFORGE_OFFLINE_ANNOTATION") == "1"
    monkeypatch.setattr(integration, "SIDECAR_URL", None)
    monkeypatch.setattr(integration, "SIDECAR_SESSION_TOKEN", secrets.token_urlsafe(32))
    children = []

    def launch(*args, **kwargs):
        database_value = kwargs.get("env", {}).get("DNAFORGE_SIDECAR_DB_PATH")
        assert database_value is not None
        database = Path(database_value).resolve()
        assert database.is_relative_to(tmp_path_factory.getbasetemp().resolve())
        assert database.name == "control-plane.sqlite3"
        create_group = kwargs.get("preexec_fn")
        assert create_group is os.setsid
        process = subprocess.Popen(*args, **kwargs)
        children.append(
            OwnedChild(process, database, kwargs["stdout"], kwargs["stderr"])
        )
        return process

    monkeypatch.setattr(
        integration,
        "subprocess",
        SimpleNamespace(Popen=launch, TimeoutExpired=subprocess.TimeoutExpired),
    )
    try:
        yield children
    finally:
        for child in children:
            if process_group_exists(child.process.pid):
                try:
                    os.killpg(child.process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            child.process.wait(timeout=5)


def select_spawn_port(monkeypatch, port):
    monkeypatch.setattr(integration, "SIDECAR_PORT", port, raising=False)
    monkeypatch.setattr(integration, "BASE_URL", f"http://127.0.0.1:{port}")


def test_sentinel_snapshot_detects_uncheckpointed_wal(tmp_path, proof):
    database = tmp_path / "wal-oracle.sqlite3"
    with closing(sqlite3.connect(database)) as writer:
        assert writer.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"
        writer.execute("PRAGMA wal_autocheckpoint=0")
        writer.execute("CREATE TABLE sentinel (value TEXT NOT NULL)")
        writer.execute("INSERT INTO sentinel VALUES ('original')")
        writer.commit()
        assert writer.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0] == 0
        before = database_snapshot(database)
        writer.execute("UPDATE sentinel SET value = 'committed-in-wal'")
        writer.commit()
        wal_size = Path(f"{database}-wal").stat().st_size
        assert wal_size > 0
        after = database_snapshot(database)
        assert before["bytes_sha256"] == after["bytes_sha256"]
        assert before["state_sha256"] != after["state_sha256"]
    proof(
        "wal-oracle",
        {
            "before": before,
            "after": after,
            "wal_bytes_while_writer_open": wal_size,
            "committed_wal_change_detected": True,
        },
    )


def test_real_sidecars_own_distinct_databases(
    tmp_path, tmp_path_factory, monkeypatch, proof, observed_launch
):
    sentinel = tmp_path / "ambient.sqlite3"
    original = seed_sentinel(sentinel)
    monkeypatch.setenv("DNAFORGE_MCP_AGENT_IDENTITY", "ambient-sentinel-agent")
    monkeypatch.setenv("DNAFORGE_MCP_GRANT_CAPABILITIES", "sentinel-only")
    monkeypatch.setenv("DNAFORGE_GRANT_ENVIRONMENT_ID", "ambient-sentinel")
    monkeypatch.setenv("DNAFORGE_GRANT_CREATED_BY", "sentinel-fixture")
    runs = []
    with foreign_listener() as (foreign, _, foreign_url, foreign_body):
        for inherited in (False, True):
            if inherited:
                monkeypatch.setenv("DNAFORGE_SIDECAR_DB_PATH", str(sentinel))
            else:
                monkeypatch.delenv("DNAFORGE_SIDECAR_DB_PATH", raising=False)
            select_spawn_port(monkeypatch, available_port())
            with closing(integration.sidecar.__wrapped__(tmp_path_factory)) as fixture:
                process = next(fixture)
                child = observed_launch[-1]
                assert process is child.process
                assert os.getpgid(process.pid) == process.pid
                state = startup_state(child.database)
                assert state == {
                    "identities": [
                        (
                            "sidecar-integration-agent",
                            '["*"]',
                            0,
                            "sidecar-integration",
                            "sidecar-integration-test",
                        )
                    ],
                    "runtime_scopes": ["sidecar-integration"],
                }
                response = httpx.get(
                    f"{integration.BASE_URL}/toolbox/status",
                    headers=integration._auth_headers(),
                    timeout=5,
                )
                assert response.status_code == 200
                assert database_snapshot(sentinel) == original
            assert_child_retired(child)
            assert startup_state(child.database)["runtime_scopes"] == []
            assert database_snapshot(sentinel) == original
            assert foreign.poll() is None
            assert httpx.get(f"{foreign_url}/health", timeout=1).text == foreign_body
            runs.append(
                {
                    "ambient_path_set": inherited,
                    "database": str(child.database),
                    "pid": process.pid,
                    "process_group": process.pid,
                    "returncode": process.returncode,
                    "startup": state,
                    "child_reaped": True,
                    "group_retired": True,
                    "logs_closed": True,
                    "foreign_listener_alive": True,
                }
            )
    assert len(observed_launch) == 2
    assert observed_launch[0].database != observed_launch[1].database
    proof(
        "distinct-databases",
        {
            "sentinel_before": original,
            "sentinel_after": database_snapshot(sentinel),
            "runs": runs,
        },
    )


def test_real_startup_failure_retires_only_owned_child(
    tmp_path, tmp_path_factory, monkeypatch, proof, observed_launch
):
    sentinel = tmp_path / "ambient.sqlite3"
    original = seed_sentinel(sentinel)
    monkeypatch.setenv("DNAFORGE_SIDECAR_DB_PATH", str(sentinel))

    def unusable_database(name):
        root = tmp_path_factory.mktemp(name)
        (root / "control-plane.sqlite3").mkdir()
        return root

    with foreign_listener() as (foreign, _, url, body):
        select_spawn_port(monkeypatch, available_port())
        with pytest.raises(pytest.fail.Exception) as failure:
            with closing(
                integration.sidecar.__wrapped__(
                    SimpleNamespace(mktemp=unusable_database)
                )
            ) as fixture:
                next(fixture)
        diagnostic = str(failure.value)
        sqlite_failure = (
            "sqlite3.OperationalError: unable to open database file" in diagnostic
        )
        fixture_failure = "Sidecar failed to start within 15s" in diagnostic
        assert sqlite_failure
        assert fixture_failure
        assert len(observed_launch) == 1
        child = observed_launch[0]
        assert_child_retired(child)
        assert database_snapshot(sentinel) == original
        assert foreign.poll() is None
        assert httpx.get(f"{url}/health", timeout=1).text == body
    proof(
        "startup-failure",
        {
            "sentinel_before": original,
            "sentinel_after": database_snapshot(sentinel),
            "pid": child.process.pid,
            "returncode": child.process.returncode,
            "diagnostic": "sqlite3.OperationalError: unable to open database file",
            "fixture_reported_failure": fixture_failure,
            "child_reaped": True,
            "group_retired": True,
            "logs_closed": True,
            "foreign_listener_alive": True,
        },
    )


def test_real_foreign_listener_survives_collision_and_attach(
    tmp_path, monkeypatch, proof, observed_launch
):
    sentinel = tmp_path / "ambient.sqlite3"
    original = seed_sentinel(sentinel)
    monkeypatch.setenv("DNAFORGE_SIDECAR_DB_PATH", str(sentinel))
    allocations = []

    def unexpected_storage(name):
        allocations.append(name)
        pytest.fail("External listener must not allocate owned sidecar storage")

    factory = SimpleNamespace(mktemp=unexpected_storage)
    with foreign_listener() as (foreign, port, url, body):
        select_spawn_port(monkeypatch, port)
        with pytest.raises(pytest.skip.Exception, match="already in use"):
            with closing(integration.sidecar.__wrapped__(factory)) as fixture:
                next(fixture)
        assert foreign.poll() is None
        assert httpx.get(f"{url}/health", timeout=1).text == body
        monkeypatch.setattr(integration, "SIDECAR_URL", url)
        with closing(integration.sidecar.__wrapped__(factory)) as fixture:
            assert next(fixture) is None
        assert foreign.poll() is None
        assert httpx.get(f"{url}/health", timeout=1).text == body
        assert database_snapshot(sentinel) == original
        assert not observed_launch
        assert not allocations
    proof(
        "foreign-listener",
        {
            "sentinel_before": original,
            "sentinel_after": database_snapshot(sentinel),
            "foreign_pid": foreign.pid,
            "collision_reported_skip": True,
            "live_attach_completed": True,
            "owned_children": 0,
            "storage_allocations": 0,
            "foreign_listener_alive": True,
        },
    )
