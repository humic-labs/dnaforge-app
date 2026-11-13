from __future__ import annotations

import asyncio
import os
import sys
import threading
from types import MappingProxyType

import pytest

from src.tools.alignment import (
    AlignmentCanceled,
    MafftRuntime,
    read_mafft_version,
    resolve_mafft_runtime,
    run_mafft,
)


async def _wait_for_path(path, timeout: float = 2.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if path.exists():
            return
        await asyncio.sleep(0.01)
    raise AssertionError(f"Timed out waiting for {path}")


@pytest.mark.skipif(sys.platform == "win32", reason="Uvicorn uses uvloop on POSIX")
def test_frozen_environment_starts_a_real_subprocess_under_uvloop():
    import uvloop

    runtime = MafftRuntime(sys.executable, MappingProxyType(dict(os.environ)))
    with asyncio.Runner(loop_factory=uvloop.new_event_loop) as runner:
        stdout, stderr = runner.run(
            run_mafft(
                ["mafft", "-c", "print('owned subprocess started')"],
                timeout_seconds=5,
                runtime=runtime,
            )
        )
    assert stdout.strip() == "owned subprocess started"
    assert stderr == ""


@pytest.mark.asyncio
@pytest.mark.skipif(os.name == "nt", reason="POSIX process-group proof")
async def test_mafft_cancellation_terminates_the_owned_process_group(tmp_path):
    child_started = tmp_path / "child-started"
    child_stopped = tmp_path / "child-stopped"
    parent_script = tmp_path / "parent.py"
    child_script = tmp_path / "child.py"
    child_script.write_text(
        "\n".join(
            [
                "import signal",
                "import sys",
                "import time",
                "from pathlib import Path",
                "started = Path(sys.argv[1])",
                "stopped = Path(sys.argv[2])",
                "def stop(_signal, _frame):",
                "    stopped.write_text('stopped')",
                "    raise SystemExit(0)",
                "signal.signal(signal.SIGTERM, stop)",
                "started.write_text('started')",
                "time.sleep(60)",
            ]
        )
    )
    parent_script.write_text(
        "\n".join(
            [
                "import subprocess",
                "import sys",
                "import time",
                "subprocess.Popen([sys.executable, sys.argv[1], sys.argv[2], sys.argv[3]])",
                "time.sleep(60)",
            ]
        )
    )
    cancel = threading.Event()
    task = asyncio.create_task(
        run_mafft(
            [
                sys.executable,
                str(parent_script),
                str(child_script),
                str(child_started),
                str(child_stopped),
            ],
            timeout_seconds=30,
            cancel_event=cancel,
        )
    )

    await _wait_for_path(child_started)
    cancel.set()
    with pytest.raises(AlignmentCanceled):
        await asyncio.wait_for(task, timeout=3)
    await _wait_for_path(child_stopped)


@pytest.mark.asyncio
@pytest.mark.skipif(os.name == "nt", reason="POSIX process-group proof")
async def test_mafft_timeout_terminates_the_owned_process_group(tmp_path):
    stopped = tmp_path / "stopped"
    script = tmp_path / "wait.py"
    script.write_text(
        "\n".join(
            [
                "import signal",
                "import sys",
                "import time",
                "from pathlib import Path",
                "def stop(_signal, _frame):",
                "    Path(sys.argv[1]).write_text('stopped')",
                "    raise SystemExit(0)",
                "signal.signal(signal.SIGTERM, stop)",
                "time.sleep(60)",
            ]
        )
    )

    with pytest.raises(asyncio.TimeoutError):
        await run_mafft(
            [sys.executable, str(script), str(stopped)], timeout_seconds=0.1
        )
    await _wait_for_path(stopped)


@pytest.mark.asyncio
@pytest.mark.skipif(os.name == "nt", reason="POSIX process-group proof")
async def test_caller_cancellation_terminates_the_owned_process_group(tmp_path):
    started = tmp_path / "started"
    stopped = tmp_path / "stopped"
    script = tmp_path / "wait.py"
    script.write_text(
        "\n".join(
            [
                "import signal",
                "import sys",
                "import time",
                "from pathlib import Path",
                "def stop(_signal, _frame):",
                "    Path(sys.argv[2]).write_text('stopped')",
                "    raise SystemExit(0)",
                "signal.signal(signal.SIGTERM, stop)",
                "Path(sys.argv[1]).write_text('started')",
                "time.sleep(60)",
            ]
        )
    )
    task = asyncio.create_task(
        run_mafft(
            [sys.executable, str(script), str(started), str(stopped)],
            timeout_seconds=30,
        )
    )

    await _wait_for_path(started)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await _wait_for_path(stopped)


@pytest.mark.asyncio
async def test_subprocess_ceiling_does_not_shorten_capacity_wait(tmp_path, monkeypatch):
    capacity = threading.BoundedSemaphore(1)
    capacity.acquire()
    monkeypatch.setattr("src.tools.alignment._mafft_capacity", capacity)
    marker = tmp_path / "admitted"
    task = asyncio.create_task(
        run_mafft(
            [
                sys.executable,
                "-c",
                "import pathlib,sys;pathlib.Path(sys.argv[1]).write_text('started');print('ok')",
                str(marker),
            ],
            timeout_seconds=5,
            subprocess_timeout_seconds=0.5,
        )
    )
    try:
        await asyncio.sleep(0.7)
        assert not task.done()
        assert not marker.exists()
    finally:
        capacity.release()
    stdout, _stderr = await task
    assert stdout.strip() == "ok"
    assert marker.read_text() == "started"


@pytest.mark.asyncio
async def test_version_and_alignment_use_one_frozen_launcher_and_binaries(
    tmp_path, monkeypatch
):
    launcher = tmp_path / "mafftdir" / "bin" / "mafft"
    binaries = tmp_path / "mafftdir" / "libexec"
    binaries.mkdir(parents=True)
    (binaries / "version").write_text("unit-test fixture")
    monkeypatch.setattr("src.tools.alignment._find_mafft", lambda: str(launcher))
    runtime = resolve_mafft_runtime()
    assert runtime.environment["MAFFT_BINARIES"] == str(binaries)
    monkeypatch.setenv("MAFFT_BINARIES", "/changed-after-resolution")

    def must_not_resolve_again():
        raise AssertionError("A managed operation must keep its resolved engine")

    monkeypatch.setattr("src.tools.alignment._find_mafft", must_not_resolve_again)
    calls = []

    class ControlledProcess:
        returncode = 0

        async def communicate(self):
            return b"v7.526 (2024/Apr/26)\n", b""

    async def create_process(*args, **kwargs):
        calls.append((args, kwargs["env"]))
        return ControlledProcess()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", create_process)
    deadline = asyncio.get_running_loop().time() + 5
    assert (
        await read_mafft_version(
            runtime, deadline=deadline, cancel_event=threading.Event()
        )
        == "v7.526 (2024/Apr/26)"
    )
    await run_mafft(
        ["mafft", "--quiet", "owned-input.fasta"],
        timeout_seconds=5,
        runtime=runtime,
        deadline=deadline,
    )
    assert [args for args, _env in calls] == [
        (str(launcher), "--version"),
        (str(launcher), "--quiet", "owned-input.fasta"),
    ]
    assert all(env["MAFFT_BINARIES"] == str(binaries) for _args, env in calls)


@pytest.mark.asyncio
async def test_total_request_budget_expires_before_capacity_admission(
    tmp_path, monkeypatch
):
    capacity = threading.BoundedSemaphore(1)
    capacity.acquire()
    monkeypatch.setattr("src.tools.alignment._mafft_capacity", capacity)
    marker = tmp_path / "must-not-start"
    try:
        with pytest.raises(asyncio.TimeoutError):
            await run_mafft(
                [
                    sys.executable,
                    "-c",
                    "import pathlib,sys;pathlib.Path(sys.argv[1]).touch()",
                    str(marker),
                ],
                timeout_seconds=0.1,
                subprocess_timeout_seconds=5,
            )
        assert not marker.exists()
    finally:
        capacity.release()
