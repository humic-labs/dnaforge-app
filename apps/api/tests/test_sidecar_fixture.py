import signal
import subprocess
from contextlib import closing
from pathlib import Path
from unittest.mock import Mock

import httpx
import pytest

from tests import test_sidecar_integration as integration


@pytest.fixture
def launch(monkeypatch):
    monkeypatch.setattr(integration, "SIDECAR_URL", None)
    monkeypatch.setattr(integration, "SIDECAR_PORT", 18321, raising=False)
    monkeypatch.setattr(integration, "BASE_URL", "http://127.0.0.1:18321")
    monkeypatch.setattr(integration, "SIDECAR_SESSION_TOKEN", "synthetic-session")
    monkeypatch.setenv("DNAFORGE_OFFLINE_ANNOTATION", "0")
    monkeypatch.setattr(integration, "_port_free", lambda _port: True)
    monkeypatch.setattr(
        integration.httpx, "get", lambda *_args, **_kwargs: httpx.Response(200)
    )
    process = Mock(pid=24680)
    process.poll.return_value = None
    popen = Mock(return_value=process)
    monkeypatch.setattr(integration.subprocess, "Popen", popen)
    monkeypatch.setattr(integration.os, "getpgid", lambda pid: pid)
    killpg = Mock()
    monkeypatch.setattr(integration.os, "killpg", killpg)
    return popen, process, killpg


@pytest.mark.parametrize("inherited_database", [False, True])
def test_spawn_owns_unique_database(
    tmp_path, tmp_path_factory, monkeypatch, launch, inherited_database
):
    sentinel = tmp_path / "ambient.sqlite3"
    sentinel.write_bytes(b"ambient database must remain untouched")
    if inherited_database:
        monkeypatch.setenv("DNAFORGE_SIDECAR_DB_PATH", str(sentinel))
    else:
        monkeypatch.delenv("DNAFORGE_SIDECAR_DB_PATH", raising=False)
    popen, process, _ = launch
    paths = []
    for _ in range(2):
        with closing(integration.sidecar.__wrapped__(tmp_path_factory)) as fixture:
            assert next(fixture) is process
            child_env = popen.call_args.kwargs["env"]
            database_path = child_env.get("DNAFORGE_SIDECAR_DB_PATH")
            assert database_path is not None
            path = Path(database_path)
            assert path.is_relative_to(tmp_path_factory.getbasetemp())
            assert path.parent.is_dir()
            assert path != sentinel
            paths.append(path)
    assert paths[0] != paths[1]
    assert sentinel.read_bytes() == b"ambient database must remain untouched"


def test_spawn_replaces_ambient_authority(tmp_path_factory, monkeypatch, launch):
    synthetic = {
        "DNAFORGE_MCP_AGENT_IDENTITY": "sidecar-integration-agent",
        "DNAFORGE_MCP_GRANT_CAPABILITIES": "*",
        "DNAFORGE_GRANT_ENVIRONMENT_ID": "sidecar-integration",
        "DNAFORGE_GRANT_CREATED_BY": "sidecar-integration-test",
        "DNAFORGE_SIDECAR_ENVIRONMENT_ID": "sidecar-integration",
        "DNAFORGE_OPERATION_SCOPE": "sidecar-integration",
        "DNAFORGE_OPERATION_OWNER_ID": "sidecar-integration-human",
        "DNAFORGE_ALLOWED_RENDERER_ORIGIN": "null",
    }
    removed = (
        "DNAFORGE_HUMAN_OPERATION_TOKEN",
        "DNAFORGE_OPERATION_URL",
        "DNAFORGE_RENDERER_BRIDGE_URL",
        "DNAFORGE_RENDERER_BRIDGE_TOKEN",
        "DNAFORGE_NATIVE_DOCUMENT_URL",
        "DNAFORGE_NATIVE_DOCUMENT_TOKEN",
        "DNAFORGE_NATIVE_DOCUMENT_OWNER_ID",
        "DNAFORGE_MCP_HTTP_INTERNAL_PORT",
        "DNAFORGE_MCP_HTTP_ALLOWED_HOSTS_FILE",
        "DNAFORGE_SIDECAR_OWNER_PID",
        "DNAFORGE_SIDECAR_SESSION_GENERATION",
    )
    for name in (*synthetic, *removed, "DNAFORGE_MCP_SESSION_TOKEN"):
        monkeypatch.setenv(name, "ambient-value")
    monkeypatch.setenv("WAYPOINT_DATA_DIR", "/synthetic/annotation-data")
    monkeypatch.setenv("WAYPOINT_BINARIES_PATH", "/synthetic/annotation-tools")
    popen, _, _ = launch
    with closing(integration.sidecar.__wrapped__(tmp_path_factory)) as fixture:
        next(fixture)
        child_env = popen.call_args.kwargs["env"]
        assert {name: child_env.get(name) for name in synthetic} == synthetic
        assert all(name not in child_env for name in removed)
        assert child_env["DNAFORGE_MCP_SESSION_TOKEN"] == "synthetic-session"
        assert child_env["WAYPOINT_DATA_DIR"] == "/synthetic/annotation-data"
        assert child_env["WAYPOINT_BINARIES_PATH"] == "/synthetic/annotation-tools"
        assert child_env["DNAFORGE_OFFLINE_ANNOTATION"] == "0"
        assert integration.os.environ["DNAFORGE_MCP_AGENT_IDENTITY"] == "ambient-value"


def test_external_attach_does_not_allocate_or_spawn(
    tmp_path_factory, monkeypatch, launch
):
    popen, _, killpg = launch
    monkeypatch.setattr(integration, "SIDECAR_URL", "http://external.invalid")
    monkeypatch.setattr(integration, "BASE_URL", "http://external.invalid")
    monkeypatch.setenv("DNAFORGE_SIDECAR_DB_PATH", "/external/owned.sqlite3")
    factory = Mock(spec=tmp_path_factory)
    with closing(integration.sidecar.__wrapped__(factory)) as fixture:
        assert next(fixture) is None
    popen.assert_not_called()
    factory.mktemp.assert_not_called()
    killpg.assert_not_called()
    assert (
        integration.os.environ["DNAFORGE_SIDECAR_DB_PATH"] == "/external/owned.sqlite3"
    )


def test_occupied_port_does_not_spawn_or_signal(tmp_path_factory, monkeypatch, launch):
    popen, _, killpg = launch
    monkeypatch.setattr(integration, "_port_free", lambda _port: False)
    with pytest.raises(pytest.skip.Exception, match="already in use"):
        next(integration.sidecar.__wrapped__(tmp_path_factory))
    popen.assert_not_called()
    killpg.assert_not_called()


def test_teardown_closes_logs_and_waits_for_owned_process(tmp_path_factory, launch):
    popen, process, killpg = launch
    with closing(integration.sidecar.__wrapped__(tmp_path_factory)) as fixture:
        next(fixture)
    killpg.assert_called_once_with(process.pid, signal.SIGTERM)
    process.wait.assert_called_once_with(timeout=5)
    assert popen.call_args.kwargs["stdout"].closed
    assert popen.call_args.kwargs["stderr"].closed


def test_startup_failure_preserves_diagnostics_and_closes_logs(
    tmp_path_factory, launch
):
    popen, process, _ = launch
    process.poll.return_value = 1

    def failed_process(*_args, **kwargs):
        kwargs["stderr"].write(b"synthetic startup failure")
        return process

    popen.side_effect = failed_process
    with pytest.raises(pytest.fail.Exception, match="synthetic startup failure"):
        next(integration.sidecar.__wrapped__(tmp_path_factory))
    assert popen.call_args.kwargs["stdout"].closed
    assert popen.call_args.kwargs["stderr"].closed


def test_startup_timeout_reaps_owned_process(tmp_path_factory, monkeypatch, launch):
    popen, process, killpg = launch
    monkeypatch.setattr(integration.time, "monotonic", Mock(side_effect=[0, 16, 16]))
    with pytest.raises(pytest.fail.Exception, match="failed to start within 15s"):
        next(integration.sidecar.__wrapped__(tmp_path_factory))
    killpg.assert_called_once_with(process.pid, signal.SIGTERM)
    process.wait.assert_called_once_with(timeout=5)
    assert popen.call_args.kwargs["stdout"].closed
    assert popen.call_args.kwargs["stderr"].closed


def test_launch_exception_closes_logs(tmp_path_factory, launch):
    popen, _, killpg = launch
    popen.side_effect = OSError("synthetic launch failure")
    with pytest.raises(OSError, match="synthetic launch failure"):
        next(integration.sidecar.__wrapped__(tmp_path_factory))
    assert popen.call_args.kwargs["stdout"].closed
    assert popen.call_args.kwargs["stderr"].closed
    killpg.assert_not_called()


def test_teardown_kills_owned_process_after_timeout(tmp_path_factory, launch):
    _, process, killpg = launch
    process.wait.side_effect = [subprocess.TimeoutExpired("uvicorn", 5), 0]
    with closing(integration.sidecar.__wrapped__(tmp_path_factory)) as fixture:
        next(fixture)
    assert [call.args for call in killpg.call_args_list] == [
        (process.pid, signal.SIGTERM),
        (process.pid, signal.SIGKILL),
    ]
    assert process.wait.call_count == 2
