"""Tests for generic resource-link records."""

import pytest

from src.agent_resource_links import (
    build_resource_link_resource,
    normalize_resource_link_args,
    register_agent_resource_link,
)
from src.control_plane import ControlPlaneStore


def test_normalize_resource_link_validates_known_sidecar_resources(tmp_path):
    store, action_id, analysis_run_uri = _store_with_analysis_run(tmp_path)

    normalized = normalize_resource_link_args(
        {
            "sourceUri": analysis_run_uri,
            "targetUri": "waypoint://workflow/ncbi-derivative-design",
            "relationship": "implements_workflow",
            "metadata": {"confidence": "high"},
        },
        store=store,
    )

    assert action_id
    assert normalized == {
        "source_uri": analysis_run_uri,
        "target_uri": "waypoint://workflow/ncbi-derivative-design",
        "relationship": "implements_workflow",
        "metadata": {"confidence": "high"},
    }
    store.close()


def test_register_resource_link_persists_readable_resource(tmp_path):
    store, action_id, analysis_run_uri = _store_with_analysis_run(tmp_path)

    result = register_agent_resource_link(
        {
            "sourceUri": analysis_run_uri,
            "targetUri": "waypoint://workflow/ncbi-derivative-design",
            "relationship": "implements_workflow",
        },
        agent_identity_id="agent-1",
        action_id=action_id,
        store=store,
    )

    resource_link = store.get_agent_resource_link(result["resourceLinkId"])
    resource = build_resource_link_resource(resource_link)

    assert result["ok"] is True
    assert result["resourceUri"] == resource["resourceUri"]
    assert result["resourceLink"]["sourceUri"] == analysis_run_uri
    assert result["resourceLink"]["targetUri"] == (
        "waypoint://workflow/ncbi-derivative-design"
    )
    assert resource["resourceLink"]["relationship"] == "implements_workflow"
    store.close()


def test_resource_link_validation_rejects_unknown_analysis_run(tmp_path):
    store = ControlPlaneStore(tmp_path / "control.sqlite3")
    store.initialize()

    with pytest.raises(ValueError, match="Unknown analysis-run resource"):
        normalize_resource_link_args(
            {
                "sourceUri": "waypoint://analysis-run/missing",
                "targetUri": "waypoint://workflow/ncbi-derivative-design",
                "relationship": "implements_workflow",
            },
            store=store,
        )
    store.close()


def test_resource_link_validation_requires_waypoint_uris():
    with pytest.raises(ValueError, match="sourceUri must be"):
        normalize_resource_link_args(
            {
                "sourceUri": "https://example.org/result",
                "targetUri": "waypoint://workflow/ncbi-derivative-design",
                "relationship": "implements_workflow",
            }
        )


def _store_with_analysis_run(tmp_path):
    store = ControlPlaneStore(tmp_path / "control.sqlite3")
    store.initialize()
    store.ensure_agent_identity("agent-1", scope=["write-workspace"])
    action_id = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="analysis_run.create",
        parameters={},
    )
    analysis_run_id = store.insert_agent_analysis_run(
        agent_identity_id="agent-1",
        action_id=action_id,
        name="RNA-seq smoke",
        status="completed",
        command={"line": "python analyze.py"},
    )
    return store, action_id, f"waypoint://analysis-run/{analysis_run_id}"
