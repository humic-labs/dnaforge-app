"""Security contract for the retained legacy MCP resource HTTP routes."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from src.control_plane import initialize_control_plane
from src.main import app

MCP_TOKEN = "legacy-resource-security-token"
CALLER_ID = "legacy-resource-caller"
FOREIGN_ID = "legacy-resource-foreign"


def _headers(*, capabilities: str | None = None) -> dict[str, str]:
    headers = {
        "X-DNAForge-Session": MCP_TOKEN,
        "X-DNAForge-Agent-Identity": CALLER_ID,
    }
    if capabilities is not None:
        headers["X-DNAForge-Agent-Capabilities"] = capabilities
    return headers


@pytest.mark.parametrize(
    "path",
    [
        "/mcp/actions/missing",
        "/mcp/artifacts",
        "/mcp/artifacts/missing",
        "/mcp/analysis-runs",
        "/mcp/analysis-runs/missing",
        "/mcp/resource-links",
        "/mcp/resource-links/missing",
        "/mcp/agent/status",
        "/mcp/workflows",
        "/mcp/workflows/missing",
        "/mcp/workflow-ledgers/summary",
        "/mcp/workflow-ledgers/latest/missing",
    ],
)
def test_legacy_resource_routes_require_read_workspace(
    path: str,
    tmp_path,
    monkeypatch,
):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    store.ensure_agent_identity(CALLER_ID, scope=["debug.echo"])
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.setenv("DNAFORGE_MCP_AGENT_IDENTITY", CALLER_ID)
    monkeypatch.setenv("DNAFORGE_MCP_GRANT_CAPABILITIES", "debug.echo")
    client = TestClient(app)

    response = client.get(path, headers=_headers())

    assert response.status_code == 403
    assert response.json()["error"] == {
        "code": "INSUFFICIENT_SCOPE",
        "message": (
            "The caller does not have the capability required for MCP resources."
        ),
        "retriable": False,
        "details": {
            "required": ["read-workspace"],
            "provided": ["debug.echo"],
        },
    }


def test_legacy_resource_routes_require_a_persistent_grant(tmp_path, monkeypatch):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.delenv("DNAFORGE_MCP_AGENT_IDENTITY", raising=False)
    monkeypatch.setenv("DNAFORGE_MCP_GRANT_CAPABILITIES", "read-workspace")
    client = TestClient(app)

    response = client.get("/mcp/workflows", headers=_headers())

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "GRANT_MISSING"


def test_legacy_owned_resources_filter_lists_and_hide_foreign_rows(
    tmp_path,
    monkeypatch,
):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    for identity_id in (CALLER_ID, FOREIGN_ID):
        store.ensure_agent_identity(identity_id, scope=["read-workspace"])
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.setenv("DNAFORGE_MCP_AGENT_IDENTITY", CALLER_ID)
    monkeypatch.setenv("DNAFORGE_MCP_GRANT_CAPABILITIES", "read-workspace")

    foreign_parent_id = store.insert_agent_action(
        agent_identity_id=FOREIGN_ID,
        tool_name="foreign.parent",
        parameters={},
        action_id="foreign-action",
    )
    own_action_id = store.insert_agent_action(
        agent_identity_id=CALLER_ID,
        tool_name="own.child",
        parameters={},
        parent_action_id=foreign_parent_id,
        action_id="own-action",
    )
    own_artifact_id = store.insert_agent_artifact(
        agent_identity_id=CALLER_ID,
        kind="file",
        name="own-artifact",
        artifact_id="own-artifact",
    )
    foreign_artifact_id = store.insert_agent_artifact(
        agent_identity_id=FOREIGN_ID,
        kind="file",
        name="foreign-artifact",
        artifact_id="foreign-artifact",
    )
    own_run_id = store.insert_agent_analysis_run(
        agent_identity_id=CALLER_ID,
        name="own-run",
        status="completed",
        command={"argv": []},
        analysis_run_id="own-run",
    )
    foreign_run_id = store.insert_agent_analysis_run(
        agent_identity_id=FOREIGN_ID,
        name="foreign-run",
        status="completed",
        command={"argv": []},
        analysis_run_id="foreign-run",
    )
    own_link_id = store.insert_agent_resource_link(
        agent_identity_id=CALLER_ID,
        source_uri="waypoint://artifact/own-artifact",
        target_uri="waypoint://analysis-run/own-run",
        relationship="produced_by",
        resource_link_id="own-link",
    )
    foreign_link_id = store.insert_agent_resource_link(
        agent_identity_id=FOREIGN_ID,
        source_uri="waypoint://artifact/foreign-artifact",
        target_uri="waypoint://analysis-run/foreign-run",
        relationship="produced_by",
        resource_link_id="foreign-link",
    )
    client = TestClient(app)

    artifact_list = client.get("/mcp/artifacts", headers=_headers()).json()
    run_list = client.get("/mcp/analysis-runs", headers=_headers()).json()
    link_list = client.get("/mcp/resource-links", headers=_headers()).json()
    own_action = client.get(
        f"/mcp/actions/{own_action_id}",
        headers=_headers(),
    )

    assert [resource["uri"] for resource in artifact_list["resources"]] == [
        f"waypoint://artifact/{own_artifact_id}"
    ]
    assert [resource["uri"] for resource in run_list["resources"]] == [
        f"waypoint://analysis-run/{own_run_id}"
    ]
    assert [resource["uri"] for resource in link_list["resources"]] == [
        f"waypoint://resource-link/{own_link_id}"
    ]
    assert own_action.status_code == 200
    assert [row["id"] for row in own_action.json()["resource"]["actionChain"]] == [
        own_action_id
    ]

    foreign_and_missing = [
        (
            f"/mcp/actions/{foreign_parent_id}",
            "/mcp/actions/missing",
            "UNKNOWN_ACTION",
        ),
        (
            f"/mcp/artifacts/{foreign_artifact_id}",
            "/mcp/artifacts/missing",
            "UNKNOWN_ARTIFACT",
        ),
        (
            f"/mcp/analysis-runs/{foreign_run_id}",
            "/mcp/analysis-runs/missing",
            "UNKNOWN_ANALYSIS_RUN",
        ),
        (
            f"/mcp/resource-links/{foreign_link_id}",
            "/mcp/resource-links/missing",
            "UNKNOWN_RESOURCE_LINK",
        ),
    ]
    for foreign_path, missing_path, expected_code in foreign_and_missing:
        foreign = client.get(foreign_path, headers=_headers())
        missing = client.get(missing_path, headers=_headers())
        assert foreign.status_code == missing.status_code == 404
        assert foreign.json()["error"]["code"] == expected_code
        assert missing.json()["error"]["code"] == expected_code


def test_legacy_workflow_ledger_routes_filter_foreign_and_unowned_runs(
    tmp_path,
    monkeypatch,
):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    for identity_id in (CALLER_ID, FOREIGN_ID):
        store.ensure_agent_identity(identity_id, scope=["read-workspace"])
    own_action_id = store.insert_agent_action(
        agent_identity_id=CALLER_ID,
        tool_name="workflow.step",
        parameters={},
        action_id="own-workflow-action",
    )
    foreign_action_id = store.insert_agent_action(
        agent_identity_id=FOREIGN_ID,
        tool_name="workflow.step",
        parameters={},
        action_id="foreign-workflow-action",
    )
    ledger_root = tmp_path / "workflow-ledgers"
    ledgers = [
        ("run-a-own", "shared-workflow", own_action_id, "own-run-visible"),
        (
            "run-b-foreign",
            "shared-workflow",
            foreign_action_id,
            "foreign-run-secret",
        ),
        (
            "run-c-unowned",
            "unowned-workflow",
            None,
            "unowned-run-secret",
        ),
        (
            "run-d-foreign-only",
            "foreign-workflow",
            foreign_action_id,
            "foreign-only-secret",
        ),
    ]
    for run_name, workflow_id, action_id, marker in ledgers:
        run_dir = ledger_root / run_name
        run_dir.mkdir(parents=True)
        lifecycle = [{"action_id": action_id}] if action_id is not None else []
        (run_dir / "workflow-ledger.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "workflow": {
                        "id": workflow_id,
                        "demand": {"level": "high"},
                    },
                    "outcome": "passed",
                    "success": True,
                    "classification": marker,
                    "command_lifecycle": lifecycle,
                }
            )
        )
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.setenv("DNAFORGE_MCP_AGENT_IDENTITY", CALLER_ID)
    monkeypatch.setenv("DNAFORGE_MCP_GRANT_CAPABILITIES", "read-workspace")
    monkeypatch.setenv("DNAFORGE_WORKFLOW_LEDGER_ROOT", str(ledger_root))
    client = TestClient(app)

    summary_response = client.get(
        "/mcp/workflow-ledgers/summary",
        headers=_headers(),
    )
    latest_response = client.get(
        "/mcp/workflow-ledgers/latest/shared-workflow",
        headers=_headers(),
    )
    foreign_response = client.get(
        "/mcp/workflow-ledgers/latest/foreign-workflow",
        headers=_headers(),
    )
    unowned_response = client.get(
        "/mcp/workflow-ledgers/latest/unowned-workflow",
        headers=_headers(),
    )

    assert summary_response.status_code == 200
    summary = summary_response.json()["resource"]["summary"]
    assert summary["total_runs"] == 1
    assert list(summary["workflows"]) == ["shared-workflow"]
    assert "foreign-run-secret" not in json.dumps(summary)
    assert "foreign-only-secret" not in json.dumps(summary)
    assert "unowned-run-secret" not in json.dumps(summary)
    assert latest_response.status_code == 200
    latest = latest_response.json()["resource"]["ledger"]
    assert latest["classification"] == "own-run-visible"
    assert foreign_response.status_code == 404
    assert foreign_response.json()["error"]["code"] == "UNKNOWN_WORKFLOW_LEDGER"
    assert unowned_response.status_code == 404
    assert unowned_response.json()["error"]["code"] == "UNKNOWN_WORKFLOW_LEDGER"
