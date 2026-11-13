from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

PACKAGE_SRC = Path(__file__).parents[1] / "src"


def _environment(tmp_path: Path) -> dict[str, str]:
    environment = os.environ.copy()
    environment["HOME"] = str(tmp_path / "isolated-home")
    environment["PYTHONPATH"] = str(PACKAGE_SRC)
    return environment


def _write_config(path: Path) -> None:
    path.write_text("""---
snapgene:
  version: test
  method: blastn
  location: {database_dir}
  priority: 1
  parameters: []
  details:
    default_type: None
    location: Default
    compressed: False
""".format(database_dir=path.parent / "BLAST_dbs"))


def _command(tmp_path: Path, *, output: Path) -> list[str]:
    source = tmp_path / "input.fa"
    source.write_text(">ordinary-file\nACGT\n")
    config = tmp_path / "databases.yml"
    _write_config(config)
    return [
        sys.executable,
        "-m",
        "dnaforge_annotation",
        str(source),
        "--format",
        "json",
        "--output",
        str(output),
        "--data-dir",
        str(tmp_path),
        "--tools-dir",
        str(tmp_path / "tools"),
        "--temp-dir",
        str(tmp_path / "temp"),
        "--database-config",
        str(config),
        "--linear",
    ]


def test_foreground_cli_runs_from_an_isolated_home_without_app_imports(
    tmp_path: Path,
) -> None:
    tools_dir = tmp_path / "tools"
    tools_dir.mkdir()
    blastn = tools_dir / "blastn"
    blastn.write_text("""#!/usr/bin/env python3
import pathlib, sys
args = sys.argv[1:]
output = pathlib.Path(args[args.index('-out') + 1])
output.write_text('1 4 KanR_(3) 1 100 4 ACGT 4 1 4 4 0\\n')
""")
    blastn.chmod(0o755)
    output = tmp_path / "result.json"
    environment = _environment(tmp_path)
    audit = tmp_path / "audit.json"
    command = _command(tmp_path, output=output)
    wrapped = f"""
import json
import sys
from dnaforge_annotation.cli import main

code = main({command[3:]!r})
audit = {{
    "code": code,
    "app_modules": sorted(
        name for name in sys.modules if name == "src" or name.startswith("src.")
    ),
    "bio_modules": sorted(
        name for name in sys.modules if name == "Bio" or name.startswith("Bio.")
    ),
}}
with open({str(audit)!r}, "w") as destination:
    json.dump(audit, destination)
"""

    completed = subprocess.run(
        [sys.executable, "-c", wrapped],
        cwd=tmp_path,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    assert json.loads(audit.read_text()) == {
        "code": 0,
        "app_modules": [],
        "bio_modules": [],
    }
    result = json.loads(output.read_text())
    assert result["sequence_length"] == 4
    assert result["features"][0]["name"] == "KanR"
    assert result["features"][0]["start"] == 1
    assert result["features"][0]["end"] == 4


def test_missing_executable_is_a_failure_and_leaves_no_output(tmp_path: Path) -> None:
    output = tmp_path / "result.json"
    completed = subprocess.run(
        _command(tmp_path, output=output),
        cwd=tmp_path,
        env=_environment(tmp_path),
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode == 3
    assert "missing dependency" in completed.stderr
    assert "blastn" in completed.stderr
    assert not output.exists()


def test_nonzero_tool_exit_is_a_failure_and_leaves_no_output(tmp_path: Path) -> None:
    tools_dir = tmp_path / "tools"
    tools_dir.mkdir()
    blastn = tools_dir / "blastn"
    blastn.write_text("#!/bin/sh\necho 'broken reference index' >&2\nexit 7\n")
    blastn.chmod(0o755)
    output = tmp_path / "result.json"

    completed = subprocess.run(
        _command(tmp_path, output=output),
        cwd=tmp_path,
        env=_environment(tmp_path),
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode == 1
    assert "exit code 7" in completed.stderr
    assert "broken reference index" in completed.stderr
    assert not output.exists()


def test_sigterm_stops_the_owned_child_and_leaves_no_output(tmp_path: Path) -> None:
    tools_dir = tmp_path / "tools"
    tools_dir.mkdir()
    child_pid_file = tmp_path / "child.pid"
    blastn = tools_dir / "blastn"
    blastn.write_text("""#!/usr/bin/env python3
import json, os, pathlib, subprocess, sys, time
grandchild = subprocess.Popen(
    [sys.executable, '-c', 'import time; time.sleep(30)'],
    stdin=subprocess.DEVNULL,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)
pathlib.Path(os.environ['DNAFORGE_TEST_CHILD_PID']).write_text(json.dumps({
    'child': os.getpid(),
    'grandchild': grandchild.pid,
}))
time.sleep(30)
""")
    blastn.chmod(0o755)
    output = tmp_path / "result.json"
    environment = _environment(tmp_path)
    environment["DNAFORGE_TEST_CHILD_PID"] = str(child_pid_file)
    process = subprocess.Popen(
        _command(tmp_path, output=output),
        cwd=tmp_path,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    deadline = time.monotonic() + 5
    while not child_pid_file.exists() and time.monotonic() < deadline:
        time.sleep(0.02)
    assert child_pid_file.exists(), "annotation child did not start"
    child_pids = json.loads(child_pid_file.read_text())

    try:
        process.send_signal(signal.SIGTERM)
        stdout, stderr = process.communicate(timeout=5)

        assert process.returncode == 130, (stdout, stderr)
        assert "interrupted" in stderr
        assert not output.exists()
        for child_pid in child_pids.values():
            with pytest.raises(ProcessLookupError):
                os.kill(child_pid, 0)
    finally:
        for child_pid in child_pids.values():
            try:
                os.kill(child_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
