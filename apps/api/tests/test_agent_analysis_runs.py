"""Tests for analysis-run normalization and artifact linking."""

import pytest

from src.agent_analysis_runs import (
    build_analysis_run_resource,
    normalize_analysis_run_args,
    register_agent_analysis_run,
)
from src.control_plane import ControlPlaneStore


def test_normalize_analysis_run_links_known_output_artifacts(tmp_path):
    store, action_id, artifact_id, artifact_uri = _store_with_artifact(tmp_path)

    normalized = normalize_analysis_run_args(
        {
            "command": ["python", "analyze.py"],
            "cwd": str(tmp_path),
            "outputArtifacts": [artifact_uri],
            "metrics": {"durationMs": 1200},
        },
        store=store,
    )

    assert action_id
    assert normalized["name"] == "python"
    assert normalized["status"] == "completed"
    assert normalized["command"] == {"argv": ["python", "analyze.py"]}
    assert normalized["outputs"] == [
        {
            "kind": "artifact",
            "artifactId": artifact_id,
            "resourceUri": artifact_uri,
            "name": "counts.tsv",
        }
    ]
    assert normalized["metrics"] == {"durationMs": 1200}
    store.close()


def test_register_analysis_run_persists_readable_resource(tmp_path):
    store, action_id, _artifact_id, artifact_uri = _store_with_artifact(tmp_path)

    result = register_agent_analysis_run(
        {
            "name": "RNA-seq smoke",
            "status": "completed",
            "command": "python analyze.py",
            "outputArtifacts": [artifact_uri],
            "metadata": {"workflow": "rna-seq-smoke"},
        },
        agent_identity_id="agent-1",
        action_id=action_id,
        store=store,
    )

    analysis_run = store.get_agent_analysis_run(result["analysisRunId"])
    resource = build_analysis_run_resource(analysis_run)

    assert result["ok"] is True
    assert result["resourceUri"] == resource["resourceUri"]
    assert result["analysisRun"]["name"] == "RNA-seq smoke"
    assert result["analysisRun"]["outputs"][0]["resourceUri"] == artifact_uri
    assert resource["analysisRun"]["metadata"] == {"workflow": "rna-seq-smoke"}
    store.close()


def test_analysis_run_validation_rejects_unknown_artifact(tmp_path):
    store = ControlPlaneStore(tmp_path / "control.sqlite3")
    store.initialize()

    with pytest.raises(ValueError, match="Unknown artifact reference"):
        normalize_analysis_run_args(
            {"command": "python analyze.py", "outputArtifacts": ["missing"]},
            store=store,
        )
    store.close()


def test_analysis_run_validation_rejects_bad_status():
    with pytest.raises(ValueError, match="status must be one of"):
        normalize_analysis_run_args({"status": "done"})


def _store_with_artifact(tmp_path):
    store = ControlPlaneStore(tmp_path / "control.sqlite3")
    store.initialize()
    store.ensure_agent_identity("agent-1", scope=["write-workspace"])
    action_id = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="artifact.register",
        parameters={},
    )
    artifact_id = store.insert_agent_artifact(
        agent_identity_id="agent-1",
        action_id=action_id,
        kind="file",
        name="counts.tsv",
        path=str(tmp_path / "counts.tsv"),
    )
    artifact_uri = f"waypoint://artifact/{artifact_id}"
    return store, action_id, artifact_id, artifact_uri
