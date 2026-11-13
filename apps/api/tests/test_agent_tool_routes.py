"""Tests for  agent tool discovery and execution routes."""

import os

import pytest
from fastapi.testclient import TestClient

from src.concurrency import register_builtin_agent_tools
from src.concurrency.job_manager import reset_job_manager
from src.concurrency.pools import reset_pool_manager
from src.concurrency.tool_registry import agent_tool_registry
from src.control_plane import get_control_plane_store, initialize_control_plane
from src.main import app
from src.routes.mcp_auth import (
    MCP_GRANT_IDENTITY_ENV,
    session_grant_capabilities,
)

MCP_TOKEN = "test-mcp-token"


def setup_function():
    agent_tool_registry.clear()
    register_builtin_agent_tools()
    reset_job_manager()
    reset_pool_manager()


@pytest.fixture(autouse=True)
def configured_session_grant(monkeypatch):
    monkeypatch.setenv("DNAFORGE_MCP_GRANT_CAPABILITIES", "*")
    monkeypatch.setenv(MCP_GRANT_IDENTITY_ENV, "agent-tool-test-agent")


def auth_headers(**extra: str) -> dict[str, str]:
    identity_id = os.environ.get(MCP_GRANT_IDENTITY_ENV)
    if identity_id:
        get_control_plane_store().ensure_agent_identity(
            identity_id,
            scope=session_grant_capabilities() or [],
        )
    return {"X-DNAForge-Session": MCP_TOKEN, **extra}


def test_list_tools_returns_echo_mcp_projection(tmp_path, monkeypatch):
    monkeypatch.setenv("DNAFORGE_SIDECAR_DB_PATH", str(tmp_path / "control.sqlite3"))
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.setenv("DNAFORGE_MCP_AGENT_IDENTITY", "tool-list-agent")
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    store.ensure_agent_identity("tool-list-agent", scope=["*"])
    client = TestClient(app)

    response = client.get("/api/tools", headers=auth_headers())

    assert response.status_code == 200
    data = response.json()
    echo_tool = next(tool for tool in data["tools"] if tool["name"] == "echo")
    assert echo_tool["mcp"]["annotations"]["duration"] == "immediate"
    workflow_tool = next(
        tool for tool in data["tools"] if tool["name"] == "workflow.prepare_run"
    )
    assert workflow_tool["mcp"]["annotations"]["audited"] is True
    assert workflow_tool["mcp"]["inputSchema"]["required"] == ["workflowId"]
    artifact_tool = next(
        tool for tool in data["tools"] if tool["name"] == "artifact.register"
    )
    assert artifact_tool["mcp"]["annotations"]["effects"] == ["mutating"]
    assert artifact_tool["spec"]["required_capabilities"] == ["write-workspace"]
    analysis_run_tool = next(
        tool for tool in data["tools"] if tool["name"] == "analysis_run.create"
    )
    assert analysis_run_tool["mcp"]["annotations"]["effects"] == ["mutating"]
    assert analysis_run_tool["spec"]["required_capabilities"] == ["write-workspace"]
    resource_link_tool = next(
        tool for tool in data["tools"] if tool["name"] == "resource_link.create"
    )
    assert resource_link_tool["mcp"]["annotations"]["effects"] == ["mutating"]
    assert resource_link_tool["spec"]["required_capabilities"] == ["write-workspace"]


def test_manifest_schema_endpoint(monkeypatch):
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    client = TestClient(app)

    response = client.get("/api/tools/manifest-schema", headers=auth_headers())

    assert response.status_code == 200
    assert response.json()["title"] == "DNAForgeTool"


def test_execute_echo_completes_inline(tmp_path, monkeypatch):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    client = TestClient(app)

    response = client.post(
        "/api/tools/echo/execute",
        json={"message": "hi"},
        headers=auth_headers(**{"X-DNAForge-Agent-Capabilities": "debug.echo"}),
    )

    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "completed"
    assert data["result"]["echo"] == {"message": "hi"}


def test_execute_rejects_missing_capability_with_audit(tmp_path, monkeypatch):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    client = TestClient(app)

    response = client.post(
        "/api/tools/echo/execute",
        json={"message": "blocked"},
        headers=auth_headers(**{"X-DNAForge-Agent-Capabilities": "read-workspace"}),
    )

    assert response.status_code == 403
    data = response.json()
    assert data["ok"] is False
    assert data["error"]["code"] == "INSUFFICIENT_SCOPE"
    action_id = data["error"]["details"]["action_id"]
    audit_id = data["error"]["details"]["audit_id"]

    action = get_control_plane_store().get_agent_action(action_id)
    audit_records = get_control_plane_store().get_audit_records_for_action(action_id)
    assert action["authorization_state"] == "denied"
    assert action["error_json"]["code"] == "INSUFFICIENT_SCOPE"
    assert audit_records[0]["id"] == audit_id
    assert audit_records[0]["capability_check_json"]["satisfied"] is False


def test_execute_rejects_unknown_parent_action_id(tmp_path, monkeypatch):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    client = TestClient(app, raise_server_exceptions=False)

    response = client.post(
        "/api/tools/echo/execute",
        json={"message": "child", "parent_action_id": "missing-parent"},
        headers=auth_headers(**{"X-DNAForge-Agent-Capabilities": "debug.echo"}),
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "UNKNOWN_PARENT_ACTION"


def test_execute_rejects_bad_session(tmp_path, monkeypatch):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", "expected-token")
    client = TestClient(app)

    response = client.post(
        "/api/tools/echo/execute",
        json={"message": "nope"},
        headers={
            "X-DNAForge-Session": "wrong-token",
            "X-DNAForge-Agent-Capabilities": "debug.echo",
        },
    )

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "BAD_SESSION"


def test_execute_rejects_when_session_token_is_not_configured(tmp_path, monkeypatch):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.delenv("DNAFORGE_MCP_SESSION_TOKEN", raising=False)
    client = TestClient(app)

    response = client.post(
        "/api/tools/echo/execute",
        json={"message": "blocked"},
        headers={"X-DNAForge-Agent-Capabilities": "debug.echo"},
    )

    assert response.status_code == 500
    assert response.json()["error"]["code"] == "MCP_SESSION_NOT_CONFIGURED"


def test_execute_requires_a_persistent_grant(tmp_path, monkeypatch):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.delenv(MCP_GRANT_IDENTITY_ENV, raising=False)
    client = TestClient(app)

    response = client.post(
        "/api/tools/echo/execute",
        json={"message": "blocked"},
        headers={
            "X-DNAForge-Session": MCP_TOKEN,
            "X-DNAForge-Agent-Capabilities": "debug.echo",
        },
    )

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "GRANT_MISSING"


def test_execute_rejects_non_object_args(tmp_path, monkeypatch):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    client = TestClient(app)

    response = client.post(
        "/api/tools/echo/execute",
        json={"args": "not-an-object"},
        headers=auth_headers(**{"X-DNAForge-Agent-Capabilities": "debug.echo"}),
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "BAD_INPUT"


def test_execute_unknown_tool_returns_404(monkeypatch):
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    client = TestClient(app)

    response = client.post("/api/tools/nope/execute", json={}, headers=auth_headers())

    assert response.status_code == 404


def test_sidecar_status_has_pool_stats(monkeypatch):
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    client = TestClient(app)

    response = client.get("/sidecar/status", headers=auth_headers())

    assert response.status_code == 200
    assert "cpu_fast" in response.json()["pools"]
