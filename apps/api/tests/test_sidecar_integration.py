"""Sidecar integration tests — no mocks.

Dual-mode:
  - Default: starts a fresh uvicorn process on port 18321.
  - Live:    set SIDECAR_URL=http://localhost:8000 to test the running sidecar.

Marked as slow since they spin up a server (or wait for one).

Run: cd apps/api && uv run pytest tests/test_sidecar_integration.py -v -m slow
Live: SIDECAR_URL=http://localhost:8000 uv run pytest tests/test_sidecar_integration.py -v -m slow
"""

import os
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import time

import httpx
import pytest

from tests.live_sidecar_preflight import (
    SESSION_TOKEN_AT_TEST_START,
    probe_live_sidecar,
)

SIDECAR_URL = os.environ.get("SIDECAR_URL")
SIDECAR_SESSION_TOKEN = SESSION_TOKEN_AT_TEST_START

if SIDECAR_URL:
    BASE_URL = SIDECAR_URL.rstrip("/")
else:
    SIDECAR_PORT = 18321
    BASE_URL = f"http://127.0.0.1:{SIDECAR_PORT}"
    SIDECAR_SESSION_TOKEN = secrets.token_urlsafe(32)


def _auth_headers() -> dict[str, str]:
    if not SIDECAR_SESSION_TOKEN:
        pytest.fail("Live sidecar integration requires DNAFORGE_MCP_SESSION_TOKEN")
    return {"X-DNAForge-Session": SIDECAR_SESSION_TOKEN}


def _port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def _wait_for_annotation_ready(timeout_s: float = 300.0) -> None:
    deadline = time.monotonic() + timeout_s
    last_cap = None
    last_error = None
    while time.monotonic() < deadline:
        try:
            r = httpx.get(
                f"{BASE_URL}/toolbox/status", headers=_auth_headers(), timeout=5
            )
            if r.status_code == 200:
                capabilities = r.json().get("capabilities", [])
                last_cap = next(
                    (cap for cap in capabilities if cap.get("id") == "annotation"),
                    None,
                )
                components = last_cap.get("components", []) if last_cap else []
                statuses = [comp.get("status") for comp in components]
                if statuses and all(status == "ready" for status in statuses):
                    return
        except httpx.HTTPError as exc:
            last_error = str(exc)
        time.sleep(2)
    pytest.fail(
        "Annotation capability did not become ready before plannotate execution. "
        f"last_capability={last_cap!r} last_error={last_error!r}"
    )


def _read_process_log(log_file) -> str:
    log_file.flush()
    log_file.seek(0)
    return log_file.read().decode(errors="replace")


@pytest.fixture(scope="module")
def sidecar(tmp_path_factory):
    if SIDECAR_URL:
        probe_live_sidecar(BASE_URL, session_token=SIDECAR_SESSION_TOKEN, required=True)
        yield None
        return

    if not _port_free(SIDECAR_PORT):
        pytest.skip(f"Port {SIDECAR_PORT} already in use")

    if os.environ.get("DNAFORGE_OFFLINE_ANNOTATION") == "1":
        from src.annotation.setup import get_annotation_data_dir, validate_databases
        from src.annotation.tools import get_tools_dir, validate_tools

        tool_status = validate_tools(get_tools_dir())
        if not tool_status or not all(tool_status.values()):
            pytest.fail(
                f"Offline integration payload has incomplete tools: {tool_status}"
            )
        if not validate_databases(get_annotation_data_dir()):
            pytest.fail("Offline integration payload has incomplete annotation data")

    storage_root = tmp_path_factory.mktemp("sidecar-integration")
    child_env = os.environ.copy()
    child_env.update(
        {
            "DNAFORGE_SIDECAR_DB_PATH": str(storage_root / "control-plane.sqlite3"),
            "DNAFORGE_MCP_SESSION_TOKEN": _auth_headers()["X-DNAForge-Session"],
            "DNAFORGE_MCP_AGENT_IDENTITY": "sidecar-integration-agent",
            "DNAFORGE_MCP_GRANT_CAPABILITIES": "*",
            "DNAFORGE_GRANT_ENVIRONMENT_ID": "sidecar-integration",
            "DNAFORGE_GRANT_CREATED_BY": "sidecar-integration-test",
            "DNAFORGE_SIDECAR_ENVIRONMENT_ID": "sidecar-integration",
            "DNAFORGE_OPERATION_SCOPE": "sidecar-integration",
            "DNAFORGE_OPERATION_OWNER_ID": "sidecar-integration-human",
            "DNAFORGE_ALLOWED_RENDERER_ORIGIN": "null",
        }
    )
    for name in (
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
    ):
        child_env.pop(name, None)

    with (
        tempfile.TemporaryFile(mode="w+b") as stdout_log,
        tempfile.TemporaryFile(mode="w+b") as stderr_log,
    ):
        proc = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "src.main:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(SIDECAR_PORT),
            ],
            cwd=os.path.join(os.path.dirname(__file__), ".."),
            stdout=stdout_log,
            stderr=stderr_log,
            preexec_fn=os.setsid,
            env=child_env,
        )
        try:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if proc.poll() is not None:
                    break
                try:
                    r = httpx.get(f"{BASE_URL}/health", timeout=2)
                    if r.status_code == 200:
                        break
                except httpx.ConnectError:
                    pass
                time.sleep(0.3)

            if proc.poll() is not None or time.monotonic() >= deadline:
                stdout = _read_process_log(stdout_log)
                stderr = _read_process_log(stderr_log)
                pytest.fail(
                    f"Sidecar failed to start within 15s.\nstdout: {stdout}\nstderr: {stderr}"
                )

            yield proc
        finally:
            if proc.poll() is None:
                try:
                    group_id = os.getpgid(proc.pid)
                    os.killpg(group_id, signal.SIGTERM)
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(group_id, signal.SIGKILL)
                        proc.wait(timeout=5)
                except (ProcessLookupError, OSError):
                    pass


@pytest.mark.slow
class TestSidecarIntegration:
    """Integration tests against a real running sidecar."""

    def test_health_endpoint(self, sidecar):
        r = httpx.get(f"{BASE_URL}/health", timeout=5)
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "healthy"

    def test_readiness_endpoint(self, sidecar):
        r = httpx.get(f"{BASE_URL}/ready", timeout=5)
        assert r.status_code == 200
        data = r.json()
        assert "ready" in data

    def test_toolbox_status(self, sidecar):
        r = httpx.get(f"{BASE_URL}/toolbox/status", headers=_auth_headers(), timeout=5)
        assert r.status_code == 200
        data = r.json()
        assert "capabilities" in data

    def test_services_list(self, sidecar):
        r = httpx.get(f"{BASE_URL}/services/", headers=_auth_headers(), timeout=5)
        assert r.status_code == 200
        data = r.json()
        service_names = [s["name"] for s in data["services"]]
        assert "plannotate_service" in service_names

    def test_unknown_service_404(self, sidecar):
        r = httpx.post(
            f"{BASE_URL}/services/nonexistent/execute",
            headers=_auth_headers(),
            json={},
            timeout=5,
        )
        assert r.status_code == 404

    def test_old_annotation_status_removed(self, sidecar):
        """Old /annotation/status should no longer exist."""
        r = httpx.get(
            f"{BASE_URL}/annotation/status", headers=_auth_headers(), timeout=5
        )
        assert r.status_code == 404

    def test_plannotate_execution(self, sidecar):
        """POST to plannotate with a short sequence — must not return an error.

        This catches 0-byte binaries, stale download URLs, and broken
        annotation pipelines that unit tests with mocks would miss.
        """
        _wait_for_annotation_ready()
        r = httpx.post(
            f"{BASE_URL}/annotation",
            headers=_auth_headers(),
            json={"sequence": "ATCGATCGATCG", "linear": True},
            timeout=30,
        )
        assert r.status_code == 200
        data = r.json()
        assert "error" not in data, f"Plannotate returned error: {data.get('error')}"
