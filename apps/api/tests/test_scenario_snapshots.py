"""Snapshot parity tests — Python writes, TypeScript reads.

Python is the authority for scenario shapes. This test always writes
snapshot JSON files that the TS side reads and asserts equality.
"""

import json
from pathlib import Path

from src.models.toolbox import ToolboxStatusResponse

from .scenarios import (
    downloading_all,
    downloading_databases,
    downloading_tools,
    fresh_install,
    fully_ready,
    mixed_component_status,
    partial_ready,
    tools_error,
    with_mafft,
    with_plugin,
)

SNAPSHOTS_DIR = Path(__file__).parent / "snapshots"


def _write_snapshot(name: str, scenario: ToolboxStatusResponse) -> None:
    """Write a scenario snapshot and verify roundtrip."""
    json_data = scenario.model_dump(exclude_none=True)
    snapshot_path = SNAPSHOTS_DIR / f"{name}.json"
    snapshot_path.write_text(
        json.dumps(json_data, indent=2, sort_keys=True), newline="\n"
    )
    restored = ToolboxStatusResponse.model_validate(json_data)
    assert restored == scenario, f"Roundtrip failed for {name}"


def test_fresh_install_snapshot():
    _write_snapshot("fresh_install", fresh_install())


def test_fully_ready_snapshot():
    _write_snapshot("fully_ready", fully_ready())


def test_downloading_tools_snapshot():
    _write_snapshot("downloading_tools_50", downloading_tools(50))


def test_downloading_databases_snapshot():
    _write_snapshot("downloading_databases_30", downloading_databases(30))


def test_downloading_all_snapshot():
    _write_snapshot("downloading_all_25_60", downloading_all(25, 60))


def test_tools_error_snapshot():
    _write_snapshot("tools_error", tools_error())


def test_partial_ready_snapshot():
    _write_snapshot("partial_ready_blastn", partial_ready(["blastn"]))


def test_mixed_component_status_snapshot():
    _write_snapshot("mixed_component_status", mixed_component_status())


def test_with_mafft_snapshot():
    _write_snapshot("with_mafft_fresh", with_mafft(fresh_install()))


def test_with_plugin_snapshot():
    _write_snapshot(
        "with_plugin_alphafold",
        with_plugin(
            fully_ready(), "alphafold", label="AlphaFold", url="http://localhost:9001"
        ),
    )
