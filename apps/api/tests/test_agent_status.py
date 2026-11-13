"""Tests for the MCP agent status resource."""

from src.agent_status import AGENT_STATUS_RESOURCE_URI, build_agent_status_resource
from src.concurrency import register_builtin_agent_tools
from src.concurrency.tool_registry import agent_tool_registry
from src.control_plane import initialize_control_plane


def test_agent_status_summarizes_tools_caller_and_latest_resources(tmp_path):
    agent_tool_registry.clear()
    register_builtin_agent_tools()
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    store.ensure_agent_identity("agent-1", scope=["read-workspace", "write-workspace"])
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
    analysis_run_id = store.insert_agent_analysis_run(
        agent_identity_id="agent-1",
        action_id=action_id,
        name="RNA-seq smoke",
        status="completed",
        command={"line": "python analyze.py"},
    )
    resource_link_id = store.insert_agent_resource_link(
        agent_identity_id="agent-1",
        action_id=action_id,
        source_uri=f"waypoint://analysis-run/{analysis_run_id}",
        target_uri="waypoint://workflow/ncbi-derivative-design",
        relationship="implements_workflow",
    )

    resource = build_agent_status_resource(
        agent_identity_id="agent-1",
        caller_capabilities=["read-workspace", "write-workspace"],
    )

    assert resource["resourceUri"] == AGENT_STATUS_RESOURCE_URI
    assert resource["sidecar"]["ok"] is True
    assert resource["caller"] == {
        "agentIdentityId": "agent-1",
        "capabilities": ["read-workspace", "write-workspace"],
    }
    assert "artifact.register" in resource["tools"]["names"]
    assert "analysis_run.create" in resource["tools"]["names"]
    assert "resource_link.create" in resource["tools"]["names"]
    assert "ncbi-derivative-design" in resource["workflows"]["ids"]
    assert resource["latestResources"]["artifact"]["resourceUri"] == (
        f"waypoint://artifact/{artifact_id}"
    )
    assert resource["latestResources"]["analysisRun"]["resourceUri"] == (
        f"waypoint://analysis-run/{analysis_run_id}"
    )
    assert resource["latestResources"]["resourceLink"]["resourceUri"] == (
        f"waypoint://resource-link/{resource_link_id}"
    )
    store.close()
