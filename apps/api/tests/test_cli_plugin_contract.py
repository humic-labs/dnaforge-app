"""Tests for the local CLI plug-in contract."""

import asyncio
import json
import subprocess
import sys
from pathlib import Path

from src.concurrency.plugin_runner import run_cli_plugin, validate_cli_plugin_manifest
from src.control_plane import new_uuid7

ROOT = Path(__file__).resolve().parents[3]
MANIFEST = ROOT / "examples/plugins/echo-tool/manifest.json"


def test_example_echo_manifest_validates():
    assert validate_cli_plugin_manifest(MANIFEST) == []


def test_example_echo_plugin_round_trips_locally():
    result = asyncio.run(
        run_cli_plugin(MANIFEST, {"message": "hi"}, job_id=new_uuid7())
    )
    assert result["result"]["echo"] == {"message": "hi"}
    assert result["result"]["jobId"]


def test_plugin_cli_validate_command():
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "src.concurrency.cli",
            "plugin",
            "validate",
            str(MANIFEST),
        ],
        cwd=ROOT / "apps/api",
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0
    assert json.loads(result.stdout)["ok"] is True
