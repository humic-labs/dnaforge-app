"""Tests for agent artifact normalization and persistence."""

import hashlib

import pytest

from src.agent_artifacts import (
    build_artifact_resource,
    normalize_artifact_args,
    register_agent_artifact,
)
from src.control_plane import ControlPlaneStore


def test_normalize_file_artifact_resolves_relative_path_from_provenance(tmp_path):
    result_file = tmp_path / "counts.tsv"
    result_file.write_text("gene\tcount\nlacZ\t12\n")

    normalized = normalize_artifact_args(
        {
            "kind": "file",
            "path": "counts.tsv",
            "provenance": {"cwd": str(tmp_path)},
            "tags": ["counts"],
        }
    )

    assert normalized["name"] == "counts.tsv"
    assert normalized["path"] == str(result_file)
    assert normalized["size_bytes"] == result_file.stat().st_size
    assert normalized["sha256"] == hashlib.sha256(result_file.read_bytes()).hexdigest()
    assert normalized["provenance"] == {"cwd": str(tmp_path)}
    assert normalized["tags"] == ["counts"]


def test_register_url_artifact_persists_readable_resource(tmp_path):
    store = ControlPlaneStore(tmp_path / "control.sqlite3")
    store.initialize()
    store.ensure_agent_identity("agent-1", scope=["write-workspace"])
    action_id = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="artifact.register",
        parameters={},
    )

    result = register_agent_artifact(
        {
            "kind": "url",
            "sourceUri": "https://example.org/results/counts.tsv",
            "metadata": {"provider": "example"},
        },
        agent_identity_id="agent-1",
        action_id=action_id,
        store=store,
    )

    artifact = store.get_agent_artifact(result["artifactId"])
    resource = build_artifact_resource(artifact)

    assert result["ok"] is True
    assert result["artifact"]["name"] == "counts.tsv"
    assert result["artifact"]["sourceUri"] == "https://example.org/results/counts.tsv"
    assert resource["resourceUri"] == result["resourceUri"]
    assert resource["artifact"]["metadata"] == {"provider": "example"}
    store.close()


def test_artifact_validation_rejects_unverifiable_local_paths(tmp_path):
    with pytest.raises(FileNotFoundError, match="Artifact path does not exist"):
        normalize_artifact_args(
            {
                "kind": "file",
                "path": str(tmp_path / "missing.tsv"),
            }
        )


def test_artifact_validation_rejects_empty_external_records():
    with pytest.raises(ValueError, match="external artifacts require"):
        normalize_artifact_args({"kind": "external"})
