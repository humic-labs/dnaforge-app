"""A foreground runtime owns work after each short-lived client disconnects."""

from __future__ import annotations

import json
import os
import signal
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

import pytest
from dnaforge_annotation.contract import AnnotationExecutables, AnnotationRuntime

from src import managed_operations_server
from src.control_plane import ControlPlaneStore
from src.managed_operations import MANAGED_OPERATION_SYSTEM
from src.managed_operations_server import resolve_database_path, validate_runtime_name
from src.operation_kinds import (
    ALIGNMENT_COVERAGE_PREPARATION_OPERATION_KIND,
    ALIGNMENT_INDEX_PREPARATION_OPERATION_KIND,
    ANNOTATION_OPERATION_KIND,
    ANNOTATION_PROVISIONING_OPERATION_KIND,
    FASTQ_PREPROCESSING_OPERATION_KIND,
    GENOME_INDEXING_OPERATION_KIND,
    MULTIPLE_SEQUENCE_ALIGNMENT_OPERATION_KIND,
    NGS_READ_ANALYSIS_OPERATION_KIND,
    PAIRWISE_SESSION_ALIGNMENT_OPERATION_KIND,
    PRIMER_LIBRARY_SEARCH_OPERATION_KIND,
    TRACK_REGISTRATION_OPERATION_KIND,
    VARIANT_SOURCE_PREPARATION_OPERATION_KIND,
)

API_ROOT = Path(__file__).parents[1]
REPOSITORY_ROOT = Path(__file__).parents[3]
ANNOTATION_SOURCE = REPOSITORY_ROOT / "packages" / "annotation" / "src"


def eventually(predicate, *, timeout: float = 10) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError("condition did not become true")


def run_cli(
    environment: dict[str, str],
    connection: Path,
    *arguments: str,
    expected_returncode: int = 0,
) -> dict:
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "src.managed_operations_cli",
            "--connection",
            str(connection),
            *arguments,
            "--json",
        ],
        cwd=connection.parent,
        env=environment,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert completed.returncode == expected_returncode, completed.stderr
    return json.loads(completed.stdout)


@pytest.mark.asyncio
async def test_foreground_server_binds_the_compiled_operation_system(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    captured_bindings = None

    class RecordingSystem:
        def bind_executors(self, bindings):
            nonlocal captured_bindings
            captured_bindings = dict(bindings)
            return MANAGED_OPERATION_SYSTEM.bind_executors(bindings)

    monkeypatch.setattr(
        managed_operations_server,
        "MANAGED_OPERATION_SYSTEM",
        RecordingSystem(),
        raising=False,
    )
    store = ControlPlaneStore(tmp_path / "control.sqlite3")
    store.initialize()
    runtime = AnnotationRuntime(
        data_dir=tmp_path,
        executables=AnnotationExecutables(
            blastn=tmp_path / "blastn",
            diamond=tmp_path / "diamond",
            cmscan=tmp_path / "cmscan",
        ),
    )
    service = managed_operations_server._managed_service(
        store,
        scope_id="foreground-registration-test",
        runtime=runtime,
    )
    try:
        assert captured_bindings is not None
        assert set(captured_bindings) == {
            ALIGNMENT_COVERAGE_PREPARATION_OPERATION_KIND.key,
            ALIGNMENT_INDEX_PREPARATION_OPERATION_KIND.key,
            ANNOTATION_OPERATION_KIND.key,
            ANNOTATION_PROVISIONING_OPERATION_KIND.key,
            FASTQ_PREPROCESSING_OPERATION_KIND.key,
            GENOME_INDEXING_OPERATION_KIND.key,
            MULTIPLE_SEQUENCE_ALIGNMENT_OPERATION_KIND.key,
            NGS_READ_ANALYSIS_OPERATION_KIND.key,
            PAIRWISE_SESSION_ALIGNMENT_OPERATION_KIND.key,
            PRIMER_LIBRARY_SEARCH_OPERATION_KIND.key,
            TRACK_REGISTRATION_OPERATION_KIND.key,
            VARIANT_SOURCE_PREPARATION_OPERATION_KIND.key,
        }
        assert service.kind_descriptors() == MANAGED_OPERATION_SYSTEM.descriptors
    finally:
        await service.aclose()
        store.close()


@pytest.mark.skipif(
    os.name == "nt", reason="SIGTERM shutdown assertion is POSIX-specific"
)
def test_foreground_server_retains_work_across_cli_disconnect_and_shutdown(
    tmp_path: Path,
) -> None:
    registry = tmp_path / "registry"
    state = tmp_path / "synthetic-engine"
    tools = tmp_path / "tools"
    data = tmp_path / "data"
    temporary = tmp_path / "temporary"
    for directory in (registry, state, tools, data, temporary, data / "BLAST_dbs"):
        directory.mkdir(parents=True, exist_ok=True)

    blastn = tools / "blastn"
    blastn.write_text("""#!/usr/bin/env python3
import os
import pathlib
import sys
import time

state = pathlib.Path(os.environ["DNAFORGE_TEST_MANAGED_ENGINE_STATE"])
counter = state / "counter"
invocation = int(counter.read_text()) + 1 if counter.exists() else 1
counter.write_text(str(invocation))
(state / f"started-{invocation}").write_text(str(os.getpid()))
release = state / f"release-{invocation}"
while not release.exists():
    time.sleep(0.02)
arguments = sys.argv[1:]
output = pathlib.Path(arguments[arguments.index("-out") + 1])
output.write_text("1 4 KanR_(3) 1 100 4 ACGT 4 1 4 4 0\\n")
""")
    blastn.chmod(0o755)
    databases = data / "databases.yml"
    databases.write_text(f"""---
snapgene:
  version: test
  method: blastn
  location: {data / "BLAST_dbs"}
  priority: 1
  parameters: []
  details:
    default_type: None
    location: Default
    compressed: False
""")
    runtime_config = tmp_path / "annotation-runtime.json"
    runtime_config.write_text(
        json.dumps(
            {
                "data_dir": str(data),
                "executables": {
                    "blastn": str(blastn),
                    "diamond": str(tools / "diamond"),
                    "cmscan": str(tools / "cmscan"),
                },
                "temp_dir": str(temporary),
                "threads": 1,
                "database_config": str(databases),
            }
        )
    )
    source = tmp_path / "input.fasta"
    source.write_text(">ordinary-file\nACGT\n")
    database = tmp_path / "managed.sqlite3"
    environment = os.environ.copy()
    environment.update(
        {
            "PYTHONPATH": os.pathsep.join((str(API_ROOT), str(ANNOTATION_SOURCE))),
            "DNAFORGE_OPERATION_RUNTIME_DIR": str(registry),
            "DNAFORGE_TEST_MANAGED_ENGINE_STATE": str(state),
            "DNAFORGE_MCP_SESSION_TOKEN": "inherited-session-must-not-be-used",
            "DNAFORGE_HUMAN_OPERATION_TOKEN": "inherited-human-must-not-be-used",
        }
    )
    server_log = (tmp_path / "server.log").open("w+")
    server = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "src.managed_operations_server",
            "foreground-test",
            str(runtime_config),
            "--db",
            str(database),
            "--port",
            "0",
        ],
        cwd=tmp_path,
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=server_log,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:

        def published_connection() -> Path | None:
            candidates = list(registry.glob("*.connection.json"))
            return candidates[0] if len(candidates) == 1 else None

        eventually(
            lambda: published_connection() is not None or server.poll() is not None
        )
        connection = published_connection()
        if connection is None:
            server_log.seek(0)
            raise AssertionError(server_log.read())
        receipt = json.loads(connection.read_text())
        assert receipt["scope_id"] == "foreground-test"
        assert receipt["url"].startswith("http://127.0.0.1:")
        assert not receipt["url"].endswith(":0")
        assert receipt["session_token"] != "inherited-session-must-not-be-used"
        assert receipt["operation_token"] != "inherited-human-must-not-be-used"
        assert receipt["session_token"] != receipt["operation_token"]

        first = run_cli(
            environment,
            connection,
            "start",
            "annotation",
            str(source),
            "--linear",
            "--submission-key",
            "first",
        )
        first_id = first["id"]
        eventually(lambda: (state / "started-1").exists())
        assert run_cli(environment, connection, "get", first_id)["state"] == "running"

        queued = run_cli(
            environment,
            connection,
            "start",
            "annotation",
            str(source),
            "--linear",
            "--submission-key",
            "queued",
        )
        queued_stop = run_cli(environment, connection, "stop", queued["id"])
        assert queued_stop["disposition"] == "accepted"
        assert queued_stop["snapshot"]["state"] == "canceled"
        active_stop = run_cli(
            environment,
            connection,
            "stop",
            first_id,
            expected_returncode=2,
        )
        assert active_stop["disposition"] == "unavailable"
        assert active_stop["snapshot"]["state"] == "running"

        (state / "release-1").touch()
        result: dict = {}

        def first_result_is_available() -> bool:
            nonlocal result
            result = run_cli(environment, connection, "result", first_id)
            return result["status"] == "available"

        eventually(first_result_is_available)
        assert result["result"]["sequence_length"] == 4
        assert result["result"]["features"][0]["name"] == "KanR"
        assert not (state / "started-2").exists()

        final = run_cli(
            environment,
            connection,
            "start",
            "annotation",
            str(source),
            "--linear",
            "--submission-key",
            "shutdown",
        )
        eventually(lambda: (state / "started-2").exists())
        server.terminate()
        time.sleep(0.25)
        assert (
            server.poll() is None
        ), "shutdown returned while physical work was still active"
        (state / "release-2").touch()
        assert server.wait(timeout=10) == -signal.SIGTERM
        eventually(lambda: not connection.exists())

        with sqlite3.connect(database) as ledger:
            state_row = ledger.execute(
                "SELECT state FROM managed_operation WHERE id = ?", (final["id"],)
            ).fetchone()
            result_row = ledger.execute(
                "SELECT payload_json FROM managed_operation_result WHERE operation_id = ?",
                (final["id"],),
            ).fetchone()
        assert state_row == ("succeeded",)
        assert result_row is not None
    finally:
        for invocation in range(1, 4):
            (state / f"release-{invocation}").touch()
        if server.poll() is None:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=5)
        server_log.close()


def test_runtime_name_and_database_path_cannot_escape_or_repurpose_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    registry = tmp_path / "registry"
    monkeypatch.setenv("DNAFORGE_OPERATION_RUNTIME_DIR", str(registry))
    assert validate_runtime_name("bench-1") == "bench-1"
    with pytest.raises(ValueError, match="runtime name"):
        validate_runtime_name("../escape")

    assert (
        resolve_database_path("bench-1", None)
        == (registry / "bench-1" / "managed-operations.sqlite3").resolve()
    )
    unrelated = tmp_path / "unrelated.sqlite3"
    with sqlite3.connect(unrelated) as connection:
        connection.execute("CREATE TABLE unrelated (value TEXT)")
    with pytest.raises(ValueError, match="managed-operation database"):
        resolve_database_path("bench-1", unrelated)
