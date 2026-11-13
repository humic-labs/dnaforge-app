"""Tests for packaged-safe agent manifest lookup."""

from __future__ import annotations

import pytest

from src.agent_manifest_paths import AGENT_TOOLS_DIR_ENV, agent_tool_manifest_path


def test_agent_tool_manifest_path_prefers_configured_directory(tmp_path, monkeypatch):
    agent_tools_dir = tmp_path / "agent-tools"
    agent_tools_dir.mkdir()
    manifest = agent_tools_dir / "workflow-manifest.json"
    manifest.write_text('{"schemaVersion": 1, "workflows": []}', encoding="utf-8")
    monkeypatch.setenv(AGENT_TOOLS_DIR_ENV, str(agent_tools_dir))

    assert agent_tool_manifest_path("workflow-manifest.json") == manifest


def test_agent_tool_manifest_path_fails_loudly_for_bad_configured_directory(
    tmp_path, monkeypatch
):
    monkeypatch.setenv(AGENT_TOOLS_DIR_ENV, str(tmp_path))

    with pytest.raises(RuntimeError, match=AGENT_TOOLS_DIR_ENV):
        agent_tool_manifest_path("workflow-manifest.json")


def test_agent_tool_manifest_path_can_resolve_from_packaged_candidate_root(tmp_path):
    packaged_root = tmp_path / "onefile-root"
    agent_tools_dir = packaged_root / "packages/core/agent-tools"
    agent_tools_dir.mkdir(parents=True)
    manifest = agent_tools_dir / "renderer-tool-manifest.json"
    manifest.write_text('{"schemaVersion": 1, "tools": []}', encoding="utf-8")

    assert (
        agent_tool_manifest_path(
            "renderer-tool-manifest.json",
            candidate_dirs=[packaged_root / "packages/core/agent-tools"],
        )
        == manifest
    )


def test_agent_tool_manifest_path_rejects_nested_filenames():
    with pytest.raises(ValueError, match="path separators"):
        agent_tool_manifest_path("../workflow-manifest.json", candidate_dirs=[])
