"""Tests for  harness runtime helpers."""

from __future__ import annotations

import json

import pytest

from src.agent_workflow_harness.runtime import (
    FAKE_BINARIES,
    MCP_GRANT_CONFIG_PATH,
    HarnessFailure,
    default_mcp_grant_capabilities,
    local_http_target,
    prepare_startup_fixtures,
    read_renderer_calls,
    require,
)


def test_default_mcp_grant_capabilities_uses_shared_electron_config():
    config = json.loads(MCP_GRANT_CONFIG_PATH.read_text())

    assert default_mcp_grant_capabilities() == config["defaultMcpGrantCapabilities"]
    assert "read-workspace" in default_mcp_grant_capabilities()


def test_local_http_target_accepts_loopback_with_path_and_query():
    assert local_http_target("http://127.0.0.1:8123/health?ready=1") == (
        "127.0.0.1",
        8123,
        "/health?ready=1",
    )


def test_local_http_target_rejects_non_loopback_or_non_http_urls():
    with pytest.raises(HarnessFailure, match="must use http"):
        local_http_target("https://127.0.0.1:8123/health")

    with pytest.raises(HarnessFailure, match="loopback-only"):
        local_http_target("http://example.com:8123/health")


def test_prepare_startup_fixtures_creates_annotation_data_and_fake_binaries(tmp_path):
    data_dir = tmp_path / "data"
    binaries_dir = tmp_path / "binaries"

    prepare_startup_fixtures(data_dir, binaries_dir)

    version = json.loads((data_dir / "annotation/version.json").read_text())
    assert version == {"version": "1.2.2"}
    assert (data_dir / "annotation/BLAST_dbs/snapgene.nsq").read_bytes() == (
        b"harness-fixture"
    )
    for name in FAKE_BINARIES:
        binary = binaries_dir / name
        assert binary.exists()
        assert binary.read_text() == "#!/bin/sh\nexit 0\n"


def test_read_renderer_calls_ignores_missing_file_and_blank_lines(tmp_path):
    missing = tmp_path / "missing.jsonl"
    assert read_renderer_calls(missing) == []

    log_path = tmp_path / "renderer.jsonl"
    log_path.write_text('{"tool":"get_workspace"}\n\n{"tool":"open_tab"}\n')

    assert read_renderer_calls(log_path) == [
        {"tool": "get_workspace"},
        {"tool": "open_tab"},
    ]


def test_require_raises_harness_failure():
    require(True, "ok")

    with pytest.raises(HarnessFailure, match="not ok"):
        require(False, "not ok")
