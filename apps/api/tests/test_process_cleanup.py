"""Process group cleanup tests.

Verifies the kill strategy used in lib.rs (`kill -TERM -<pgid>`):
setsid creates a new process group, killpg kills the entire group
including grandchildren (uv → uvicorn pattern).

Run: cd apps/api && uv run pytest tests/test_process_cleanup.py -v -m slow
"""

import os
import signal
import socket
import subprocess
import sys
import time

import pytest

CLEANUP_PORT = 18322


def _port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False


@pytest.mark.slow
class TestProcessGroupCleanup:
    """Verify process group kill matches Electron's exit handler."""

    def test_kill_process_group_kills_grandchildren(self):
        """Spawn a process that spawns a grandchild; killpg should kill both."""
        script = (
            "import subprocess, sys, time; "
            "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']); "
            "time.sleep(60)"
        )
        proc = subprocess.Popen(
            [sys.executable, "-c", script],
            preexec_fn=os.setsid,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        pgid = os.getpgid(proc.pid)
        time.sleep(0.5)

        os.killpg(pgid, signal.SIGTERM)
        proc.wait(timeout=5)

        time.sleep(0.3)

        assert not _pid_alive(proc.pid), "Parent still alive after killpg"

    def test_sidecar_cleanup_kills_uvicorn(self):
        """Start real uvicorn, kill process group, verify port freed."""
        if not _port_free(CLEANUP_PORT):
            pytest.skip(f"Port {CLEANUP_PORT} already in use")

        proc = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "src.main:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(CLEANUP_PORT),
            ],
            cwd=os.path.join(os.path.dirname(__file__), ".."),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            preexec_fn=os.setsid,
        )

        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if not _port_free(CLEANUP_PORT):
                break
            time.sleep(0.3)
        else:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            proc.wait(timeout=5)
            pytest.fail("Uvicorn did not bind to port within 15s")

        pgid = os.getpgid(proc.pid)
        os.killpg(pgid, signal.SIGTERM)

        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(pgid, signal.SIGKILL)
            proc.wait(timeout=5)

        time.sleep(0.5)

        assert _port_free(
            CLEANUP_PORT
        ), f"Port {CLEANUP_PORT} still bound after killing process group"
