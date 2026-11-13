"""The frozen sidecar entry point also exposes the ordinary Jobs command."""

import json
import os
import subprocess
import sys
from pathlib import Path


def source_environment(entry: Path) -> dict[str, str]:
    return {
        **os.environ,
        "PYTHONPATH": str(entry.parents[2] / "packages" / "annotation" / "src"),
    }


def test_jobs_mode_runs_from_an_unrelated_directory_without_starting_a_server(tmp_path):
    entry = Path(__file__).resolve().parents[1] / "run_server.py"
    registry = tmp_path / "unused runtime registry"
    result = subprocess.run(
        [sys.executable, str(entry), "--jobs", "runtimes", "--json"],
        cwd=tmp_path,
        env={
            **source_environment(entry),
            "DNAFORGE_OPERATION_RUNTIME_DIR": str(registry),
        },
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {"runtimes": []}
    assert not registry.exists(), "Discovery must not create a runtime or registry"


def test_jobs_mode_forwards_arguments_and_exit_status(monkeypatch):
    import run_server
    from src import managed_operations_cli

    received = []
    arguments = ["--connection", "/a path/runtime.json", "stop", "run-id", "--json"]

    def execute(args):
        received.append(args)
        return 2

    monkeypatch.setattr(managed_operations_cli, "main", execute)
    monkeypatch.setattr(sys, "argv", ["waypoint-api", "--jobs", *arguments])
    assert run_server.main() == 2
    assert received == [arguments]


def test_jobs_help_exposes_explicit_runtime_start_without_launching_it(tmp_path):
    entry = Path(__file__).resolve().parents[1] / "run_server.py"
    result = subprocess.run(
        [sys.executable, str(entry), "--jobs", "serve", "--help"],
        cwd=tmp_path,
        env=source_environment(entry),
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr
    assert "runtime_config" in result.stdout
    assert "--db" in result.stdout
