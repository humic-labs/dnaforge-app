"""The packaged POSIX sidecar must not outlive its Electron owner."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

from src import sidecar_owner_watchdog as watchdog


def test_no_owner_does_not_start_watchdog(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DNAFORGE_SIDECAR_OWNER_PID", raising=False)
    monkeypatch.setattr(
        watchdog.threading, "Thread", lambda **_kwargs: pytest.fail("unexpected thread")
    )
    watchdog.start_owner_watchdog()


@pytest.mark.skipif(
    os.name == "nt", reason="Windows uses the native Job Object guardian"
)
def test_invalid_or_mismatched_owner_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for value in ("oops", "1", "-42"):
        monkeypatch.setenv("DNAFORGE_SIDECAR_OWNER_PID", value)
        with pytest.raises(RuntimeError, match="Invalid DNAFORGE_SIDECAR_OWNER_PID"):
            watchdog.start_owner_watchdog()

    monkeypatch.setenv("DNAFORGE_SIDECAR_OWNER_PID", "12345")
    monkeypatch.setattr(watchdog.os, "getppid", lambda: 54321)
    with pytest.raises(RuntimeError, match="no longer the parent"):
        watchdog.start_owner_watchdog()


@pytest.mark.skipif(
    os.name == "nt", reason="Windows uses the native Job Object guardian"
)
@pytest.mark.parametrize("stderr", ["DEVNULL", "PIPE"])
def test_watchdog_stops_sidecar_after_parent_exits(tmp_path: Path, stderr: str) -> None:
    lock_path = tmp_path / "operation-owner.lock"
    child_program = (
        "import fcntl, sys, time; "
        "from src.sidecar_owner_watchdog import start_owner_watchdog; "
        "lock_file=open(sys.argv[1], 'w+'); "
        "fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB); "
        "start_owner_watchdog(); print('ready', flush=True); "
        "\nwhile True: time.sleep(1)"
    )
    launcher_program = (
        "import os, subprocess, sys; "
        "env=dict(os.environ, DNAFORGE_SIDECAR_OWNER_PID=str(os.getpid())); "
        "child=subprocess.Popen([sys.executable, '-c', sys.argv[1], sys.argv[2]], "
        "env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, "
        f"stderr=subprocess.{stderr}); "
        "assert child.stdout.readline() == b'ready\\n'; "
        "print(child.pid, flush=True)"
    )
    launcher = subprocess.run(
        [sys.executable, "-c", launcher_program, child_program, str(lock_path)],
        capture_output=True,
        text=True,
        check=True,
        timeout=10,
    )
    child_pid = int(launcher.stdout.strip())
    try:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                os.kill(child_pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.1)
        else:
            pytest.fail(f"orphaned sidecar {child_pid} survived its parent")

        import fcntl

        with lock_path.open("r+") as lock_file:
            fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(lock_file, fcntl.LOCK_UN)
    finally:
        try:
            os.kill(child_pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
