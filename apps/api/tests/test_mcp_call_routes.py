"""Tests for the Phase 1b /mcp/call dispatcher surface."""

import hashlib
import json
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
    bootstrap_session_grant,
    hash_api_key,
    session_grant_capabilities,
)

MCP_TOKEN = "test-mcp-token"


@pytest.mark.parametrize(
    "arguments",
    [
        {"kind": "external", "name": 7, "metadata": {"review": True}},
        {"kind": "external", "metadata": {"review": True}, "unexpected": True},
    ],
)
def test_native_input_schema_rejects_before_writing(tmp_path, monkeypatch, arguments):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    response = TestClient(app).post(
        "/mcp/call",
        json={"name": "artifact.register", "arguments": arguments},
        headers=auth_headers(),
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "INVALID_TOOL_INPUT"
    if "unexpected" in arguments:
        assert response.json()["error"]["details"]["issues"] == [
            {"path": "/unexpected", "rule": "additionalProperties"}
        ]
    assert store.list_agent_artifacts() == []


def test_successful_native_output_must_match_its_schema(tmp_path, monkeypatch):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)

    async def invalid_handler(_args, _context):
        return {"ok": True, "wrongReceipt": True}

    monkeypatch.setattr(
        agent_tool_registry.require("artifact.register"), "handler", invalid_handler
    )
    response = TestClient(app).post(
        "/mcp/call",
        json={
            "name": "artifact.register",
            "arguments": {"kind": "external", "metadata": {"review": True}},
        },
        headers=auth_headers(),
    )
    body = response.json()
    assert body["status"] == "failed"
    assert body["error"]["code"] == "INVALID_TOOL_OUTPUT"
    assert body["error"]["retriable"] is False
    assert body["error"]["details"]["stateMayHaveChanged"] is True


def setup_function():
    agent_tool_registry.clear()
    register_builtin_agent_tools()
    reset_job_manager()
    reset_pool_manager()


@pytest.fixture(autouse=True)
def configured_session_grant(monkeypatch):
    """A session token authenticates; this server-owned grant authorizes."""
    monkeypatch.setenv("DNAFORGE_MCP_GRANT_CAPABILITIES", "*")
    monkeypatch.setenv(MCP_GRANT_IDENTITY_ENV, "mcp-call-test-agent")


def auth_headers(**extra: str) -> dict[str, str]:
    identity_id = os.environ.get(MCP_GRANT_IDENTITY_ENV)
    if identity_id:
        get_control_plane_store().ensure_agent_identity(
            identity_id,
            scope=session_grant_capabilities() or [],
        )
    return {"X-DNAForge-Session": MCP_TOKEN, **extra}


def test_mcp_call_executes_tool_and_writes_agent_audit(tmp_path, monkeypatch):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    client = TestClient(app)

    response = client.post(
        "/mcp/call",
        json={"name": "echo", "arguments": {"message": "mcp"}},
        headers=auth_headers(**{"X-DNAForge-Agent-Capabilities": "debug.echo"}),
    )

    assert response.status_code == 200
    data = response.json()
    assert data["ok"] is True
    assert data["status"] == "completed"
    assert data["result"]["echo"] == {"message": "mcp"}

    audit_records = get_control_plane_store().get_audit_records_for_action(
        data["jobId"]
    )
    assert audit_records[0]["actor_kind"] == "agent"
    assert audit_records[0]["capability_check_json"]["satisfied"] is True


def test_mcp_call_accepts_json_rpc_params_shape(tmp_path, monkeypatch):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    client = TestClient(app)

    response = client.post(
        "/mcp/call",
        json={
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {"name": "echo", "arguments": {"message": "params"}},
        },
        headers=auth_headers(**{"X-DNAForge-Agent-Capabilities": '["debug.echo"]'}),
    )

    assert response.status_code == 200
    assert response.json()["result"]["echo"] == {"message": "params"}


def test_mcp_call_rejects_missing_capability_with_audit(tmp_path, monkeypatch):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    client = TestClient(app)

    response = client.post(
        "/mcp/call",
        json={"tool_name": "echo", "args": {"message": "blocked"}},
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


def test_mcp_call_returns_401_grant_revoked_for_revoked_identity_row(
    tmp_path, monkeypatch
):
    """ — route-level integration: when the env identity row is
    flipped to revoked=1, the very next /mcp/call returns HTTP 401 with
    the GRANT_REVOKED error envelope. Pins the wire shape on the route
    boundary in addition to the unit-level coverage in
    test_mcp_auth_grant.py.
    """
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.setenv("DNAFORGE_MCP_AGENT_IDENTITY", "revoked-agent")
    monkeypatch.setenv("DNAFORGE_MCP_GRANT_CAPABILITIES", "debug.echo")
    get_control_plane_store().ensure_agent_identity(
        "revoked-agent", scope=["debug.echo"], revoked=True
    )
    client = TestClient(app)

    response = client.post(
        "/mcp/call",
        json={"name": "echo", "arguments": {"message": "no"}},
        headers=auth_headers(),
    )

    assert response.status_code == 401
    body = response.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "GRANT_REVOKED"
    assert body["error"]["retriable"] is False
    assert body["error"]["details"]["agent_identity_id"] == "revoked-agent"


def test_mcp_call_uses_server_side_grant_when_capability_header_is_omitted(
    tmp_path, monkeypatch
):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.setenv("DNAFORGE_MCP_GRANT_CAPABILITIES", "debug.echo")
    monkeypatch.setenv("DNAFORGE_MCP_AGENT_IDENTITY", "granted-local-agent")

    bootstrap_session_grant()
    client = TestClient(app)

    response = client.post(
        "/mcp/call",
        json={"name": "echo", "arguments": {"message": "mcp"}},
        headers=auth_headers(),
    )

    assert response.status_code == 200
    data = response.json()
    assert data["result"]["echo"] == {"message": "mcp"}
    audit_records = get_control_plane_store().get_audit_records_for_action(
        data["jobId"]
    )
    assert audit_records[0]["actor_identity"] == "granted-local-agent"
    assert audit_records[0]["actor_scope_json"] == ["debug.echo"]


def test_mcp_call_honors_explicit_empty_capability_attenuation(tmp_path, monkeypatch):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.setenv("DNAFORGE_MCP_GRANT_CAPABILITIES", "debug.echo")
    monkeypatch.setenv("DNAFORGE_MCP_AGENT_IDENTITY", "granted-local-agent")
    bootstrap_session_grant()
    client = TestClient(app)

    response = client.post(
        "/mcp/call",
        json={"name": "echo", "arguments": {"message": "must be denied"}},
        headers=auth_headers(**{"X-DNAForge-Agent-Capabilities": "[]"}),
    )

    assert response.status_code == 403
    body = response.json()
    assert body["error"]["code"] == "INSUFFICIENT_SCOPE"
    assert body["error"]["details"]["provided"] == []
    assert body["error"]["details"]["requested"] == []


def test_mcp_call_caps_header_scope_to_server_side_grant(tmp_path, monkeypatch):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.setenv("DNAFORGE_MCP_GRANT_CAPABILITIES", "read-workspace")
    client = TestClient(app)

    response = client.post(
        "/mcp/call",
        json={"name": "echo", "arguments": {"message": "blocked"}},
        headers=auth_headers(**{"X-DNAForge-Agent-Capabilities": "debug.echo,*"}),
    )

    assert response.status_code == 403
    data = response.json()
    assert data["error"]["code"] == "INSUFFICIENT_SCOPE"
    assert data["error"]["details"]["provided"] == ["read-workspace"]
    assert data["error"]["details"]["requested"] == ["debug.echo", "*"]


def test_mcp_call_fails_closed_when_session_grant_is_not_configured(
    tmp_path, monkeypatch
):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.delenv("DNAFORGE_MCP_GRANT_CAPABILITIES", raising=False)
    monkeypatch.delenv(MCP_GRANT_IDENTITY_ENV, raising=False)
    client = TestClient(app)

    response = client.post(
        "/mcp/call",
        json={"name": "echo", "arguments": {"message": "must not self-grant"}},
        headers=auth_headers(
            **{"X-DNAForge-Agent-Capabilities": "debug.echo,read-workspace"}
        ),
    )

    assert response.status_code == 401
    data = response.json()
    assert data["error"]["code"] == "GRANT_MISSING"


def test_mcp_call_rejects_bad_session(tmp_path, monkeypatch):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", "expected-token")
    client = TestClient(app)

    response = client.post(
        "/mcp/call",
        json={"name": "echo", "arguments": {"message": "nope"}},
        headers={
            "X-DNAForge-Session": "wrong-token",
            "X-DNAForge-Agent-Capabilities": "debug.echo",
        },
    )

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "BAD_SESSION"


def test_mcp_call_rejects_when_session_token_is_not_configured(tmp_path, monkeypatch):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.delenv("DNAFORGE_MCP_SESSION_TOKEN", raising=False)
    client = TestClient(app)

    response = client.post(
        "/mcp/call",
        json={"name": "echo", "arguments": {"message": "blocked"}},
        headers={"X-DNAForge-Agent-Capabilities": "debug.echo"},
    )

    assert response.status_code == 500
    assert response.json()["error"]["code"] == "MCP_SESSION_NOT_CONFIGURED"


def test_mcp_call_accepts_api_key_grant_without_session_token(tmp_path, monkeypatch):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.delenv("DNAFORGE_MCP_SESSION_TOKEN", raising=False)
    monkeypatch.delenv("DNAFORGE_MCP_GRANT_CAPABILITIES", raising=False)
    api_key = "dna_key_test"
    store.create_agent_identity(
        identity_id="agent_http_test",
        scope=["debug.echo"],
        label="Test API key",
        kind="http-api-key",
        api_key_hash=hash_api_key(api_key),
    )
    client = TestClient(app)

    response = client.post(
        "/mcp/call",
        json={"name": "echo", "arguments": {"message": "api-key"}},
        headers={"X-DNAForge-API-Key": api_key},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["result"]["echo"] == {"message": "api-key"}
    audit_records = store.get_audit_records_for_action(body["jobId"])
    assert audit_records[0]["actor_identity"] == "agent_http_test"
    assert audit_records[0]["actor_scope_json"] == ["debug.echo"]


def test_mcp_call_caps_api_key_scope_to_persisted_grant(tmp_path, monkeypatch):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.delenv("DNAFORGE_MCP_SESSION_TOKEN", raising=False)
    api_key = "dna_key_limited"
    store.create_agent_identity(
        identity_id="agent_http_limited",
        scope=["read-workspace"],
        label="Limited API key",
        kind="http-api-key",
        api_key_hash=hash_api_key(api_key),
    )
    client = TestClient(app)

    response = client.post(
        "/mcp/call",
        json={"name": "echo", "arguments": {"message": "blocked"}},
        headers={
            "X-DNAForge-API-Key": api_key,
            "X-DNAForge-Agent-Capabilities": "debug.echo,*",
        },
    )

    assert response.status_code == 403
    data = response.json()
    assert data["error"]["code"] == "INSUFFICIENT_SCOPE"
    assert data["error"]["details"]["provided"] == ["read-workspace"]
    assert data["error"]["details"]["requested"] == ["debug.echo", "*"]


def test_mcp_call_preserves_parent_action_chain(tmp_path, monkeypatch):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.setenv(MCP_GRANT_IDENTITY_ENV, "child-agent")
    store.ensure_agent_identity("parent-agent", scope=["debug.echo"])
    store.ensure_agent_identity("child-agent", scope=["debug.echo"])
    parent_id = store.insert_agent_action(
        agent_identity_id="parent-agent",
        tool_name="parent",
        parameters={},
    )
    client = TestClient(app)

    response = client.post(
        "/mcp/call",
        json={
            "name": "echo",
            "arguments": {"message": "child"},
            "parent_action_id": parent_id,
        },
        headers={
            "X-DNAForge-Session": MCP_TOKEN,
            "X-DNAForge-Agent-Identity": "child-agent",
            "X-DNAForge-Agent-Capabilities": "debug.echo",
        },
    )

    assert response.status_code == 200
    child_id = response.json()["jobId"]
    child = store.get_agent_action(child_id)
    assert child["parent_action_id"] == parent_id
    assert child["root_action_id"] == parent_id
    assert [row["id"] for row in store.trace_action_chain(child_id)] == [
        child_id,
        parent_id,
    ]


def test_mcp_call_rejects_unknown_parent_action_id(tmp_path, monkeypatch):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    client = TestClient(app, raise_server_exceptions=False)

    response = client.post(
        "/mcp/call",
        json={
            "name": "echo",
            "arguments": {"message": "child"},
            "parent_action_id": "missing-parent",
        },
        headers=auth_headers(**{"X-DNAForge-Agent-Capabilities": "debug.echo"}),
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "UNKNOWN_PARENT_ACTION"


def test_mcp_call_rejects_unknown_parent_before_scope_audit(tmp_path, monkeypatch):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    client = TestClient(app, raise_server_exceptions=False)

    response = client.post(
        "/mcp/call",
        json={
            "name": "echo",
            "arguments": {"message": "child"},
            "parent_action_id": "missing-parent",
        },
        headers=auth_headers(**{"X-DNAForge-Agent-Capabilities": "read-workspace"}),
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "UNKNOWN_PARENT_ACTION"


def test_mcp_action_resource_returns_action_and_audits(tmp_path, monkeypatch):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    client = TestClient(app)

    response = client.post(
        "/mcp/call",
        json={"name": "echo", "arguments": {"message": "trace me"}},
        headers=auth_headers(
            **{
                "X-DNAForge-Agent-Identity": "agent-1",
                "X-DNAForge-Agent-Capabilities": "debug.echo",
            }
        ),
    )
    action_id = response.json()["jobId"]

    resource_response = client.get(
        f"/mcp/actions/{action_id}",
        headers=auth_headers(),
    )

    assert resource_response.status_code == 200
    resource = resource_response.json()["resource"]
    assert resource["resourceUri"] == f"waypoint://action/{action_id}"
    assert resource["action"]["id"] == action_id
    assert resource["action"]["toolName"] == "echo"
    assert resource["action"]["parameters"] == {"message": "trace me"}
    assert resource["action"]["result"]["echo"] == {"message": "trace me"}
    assert resource["action"]["result"]["jobId"] == action_id
    assert resource["actionChain"][0]["id"] == action_id
    assert resource["auditRecords"][0]["actorKind"] == "agent"
    assert resource["auditRecords"][0]["capabilityCheck"]["satisfied"] is True


def test_mcp_agent_status_resource_reports_caller_and_tools(tmp_path, monkeypatch):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.setenv("DNAFORGE_MCP_AGENT_IDENTITY", "status-agent")
    store.ensure_agent_identity(
        "status-agent", scope=["read-workspace", "write-workspace"]
    )
    client = TestClient(app)

    response = client.get(
        "/mcp/agent/status",
        headers=auth_headers(
            **{
                "X-DNAForge-Agent-Identity": "status-agent",
                "X-DNAForge-Agent-Capabilities": (
                    '["read-workspace", "write-workspace"]'
                ),
            }
        ),
    )

    assert response.status_code == 200
    resource = response.json()["resource"]
    assert resource["resourceUri"] == "waypoint://agent/status"
    assert resource["caller"] == {
        "agentIdentityId": "status-agent",
        "capabilities": ["read-workspace", "write-workspace"],
    }
    assert resource["mcp"]["sessionConfigured"] is True
    assert "artifact.register" in resource["tools"]["names"]
    assert "analysis_run.create" in resource["tools"]["names"]
    assert "resource_link.create" in resource["tools"]["names"]
    assert "ncbi-derivative-design" in resource["workflows"]["ids"]


def test_mcp_artifact_register_persists_artifact_resource(tmp_path, monkeypatch):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.setenv(MCP_GRANT_IDENTITY_ENV, "analysis-agent")
    result_file = tmp_path / "results.tsv"
    result_file.write_text("gene\tlog2fc\nlacZ\t1.2\n")
    client = TestClient(app)

    response = client.post(
        "/mcp/call",
        json={
            "name": "artifact.register",
            "arguments": {
                "kind": "file",
                "path": str(result_file),
                "name": "Differential expression table",
                "description": "Agent-produced analysis table.",
                "metadata": {"workflow": "rna-seq-smoke"},
                "provenance": {
                    "command": "python analyze.py",
                    "cwd": str(tmp_path),
                },
                "tags": ["rna-seq", "table"],
            },
        },
        headers=auth_headers(
            **{
                "X-DNAForge-Agent-Identity": "analysis-agent",
                "X-DNAForge-Agent-Capabilities": "write-workspace",
            }
        ),
    )

    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "completed"
    result = data["result"]
    artifact_id = result["artifactId"]
    assert result["resourceUri"] == f"waypoint://artifact/{artifact_id}"
    assert result["artifact"]["path"] == str(result_file)
    assert result["artifact"]["sizeBytes"] == result_file.stat().st_size
    assert (
        result["artifact"]["sha256"]
        == hashlib.sha256(result_file.read_bytes()).hexdigest()
    )
    assert result["artifact"]["metadata"] == {"workflow": "rna-seq-smoke"}
    assert result["artifact"]["provenance"]["command"] == "python analyze.py"

    list_response = client.get("/mcp/artifacts", headers=auth_headers())
    read_response = client.get(
        f"/mcp/artifacts/{artifact_id}",
        headers=auth_headers(),
    )

    assert list_response.status_code == 200
    assert list_response.json()["resources"] == [
        {
            "uri": f"waypoint://artifact/{artifact_id}",
            "name": "Differential expression table",
            "description": "Agent-produced analysis table.",
            "mimeType": "application/json",
        }
    ]
    assert read_response.status_code == 200
    resource = read_response.json()["resource"]
    assert resource["resourceUri"] == f"waypoint://artifact/{artifact_id}"
    assert resource["artifact"]["agentIdentityId"] == "analysis-agent"
    assert resource["artifact"]["actionId"] == data["jobId"]


def test_mcp_analysis_run_create_links_registered_artifacts(tmp_path, monkeypatch):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.setenv(MCP_GRANT_IDENTITY_ENV, "analysis-agent")
    result_file = tmp_path / "counts.tsv"
    result_file.write_text("gene\tcount\nlacZ\t12\n")
    client = TestClient(app)
    headers = auth_headers(
        **{
            "X-DNAForge-Agent-Identity": "analysis-agent",
            "X-DNAForge-Agent-Capabilities": "write-workspace",
        }
    )

    artifact_response = client.post(
        "/mcp/call",
        json={
            "name": "artifact.register",
            "arguments": {
                "kind": "file",
                "path": str(result_file),
                "name": "counts.tsv",
            },
        },
        headers=headers,
    )
    artifact_uri = artifact_response.json()["result"]["resourceUri"]

    response = client.post(
        "/mcp/call",
        json={
            "name": "analysis_run.create",
            "arguments": {
                "name": "RNA-seq smoke",
                "status": "completed",
                "command": ["python", "analyze.py"],
                "outputArtifacts": [artifact_uri],
                "metrics": {"durationMs": 1200},
            },
        },
        headers=headers,
    )

    assert response.status_code == 200
    data = response.json()
    result = data["result"]
    analysis_run_id = result["analysisRunId"]
    assert result["resourceUri"] == f"waypoint://analysis-run/{analysis_run_id}"
    assert result["analysisRun"]["outputs"][0]["resourceUri"] == artifact_uri
    assert result["analysisRun"]["metrics"] == {"durationMs": 1200}

    list_response = client.get("/mcp/analysis-runs", headers=auth_headers())
    read_response = client.get(
        f"/mcp/analysis-runs/{analysis_run_id}",
        headers=auth_headers(),
    )

    assert list_response.status_code == 200
    assert list_response.json()["resources"] == [
        {
            "uri": f"waypoint://analysis-run/{analysis_run_id}",
            "name": "RNA-seq smoke",
            "description": "Registered analysis run (completed).",
            "mimeType": "application/json",
        }
    ]
    assert read_response.status_code == 200
    resource = read_response.json()["resource"]
    assert resource["analysisRun"]["command"] == {"argv": ["python", "analyze.py"]}
    assert resource["analysisRun"]["agentIdentityId"] == "analysis-agent"
    assert resource["analysisRun"]["actionId"] == data["jobId"]


def test_mcp_resource_link_create_connects_run_to_workflow(tmp_path, monkeypatch):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    client = TestClient(app)
    headers = auth_headers(
        **{
            "X-DNAForge-Agent-Identity": "analysis-agent",
            "X-DNAForge-Agent-Capabilities": "write-workspace",
        }
    )

    analysis_response = client.post(
        "/mcp/call",
        json={
            "name": "analysis_run.create",
            "arguments": {
                "name": "RNA-seq smoke",
                "command": "python analyze.py",
            },
        },
        headers=headers,
    )
    analysis_run_uri = analysis_response.json()["result"]["resourceUri"]

    response = client.post(
        "/mcp/call",
        json={
            "name": "resource_link.create",
            "arguments": {
                "sourceUri": analysis_run_uri,
                "targetUri": "waypoint://workflow/ncbi-derivative-design",
                "relationship": "implements_workflow",
                "metadata": {"confidence": "high"},
            },
        },
        headers=headers,
    )

    assert response.status_code == 200
    data = response.json()
    result = data["result"]
    resource_link_id = result["resourceLinkId"]
    assert result["resourceUri"] == f"waypoint://resource-link/{resource_link_id}"
    assert result["resourceLink"]["sourceUri"] == analysis_run_uri
    assert result["resourceLink"]["targetUri"] == (
        "waypoint://workflow/ncbi-derivative-design"
    )

    list_response = client.get("/mcp/resource-links", headers=auth_headers())
    read_response = client.get(
        f"/mcp/resource-links/{resource_link_id}",
        headers=auth_headers(),
    )

    assert list_response.status_code == 200
    assert list_response.json()["resources"] == [
        {
            "uri": f"waypoint://resource-link/{resource_link_id}",
            "name": "implements_workflow",
            "description": (
                f"{analysis_run_uri} -> waypoint://workflow/ncbi-derivative-design"
            ),
            "mimeType": "application/json",
        }
    ]
    assert read_response.status_code == 200
    resource = read_response.json()["resource"]
    assert resource["resourceLink"]["relationship"] == "implements_workflow"
    assert resource["resourceLink"]["metadata"] == {"confidence": "high"}
    assert resource["resourceLink"]["actionId"] == data["jobId"]


def test_mcp_workflow_resources_are_session_gated_and_readable(monkeypatch):
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    client = TestClient(app)

    list_response = client.get("/mcp/workflows", headers=auth_headers())
    resource_response = client.get(
        "/mcp/workflows/ncbi-derivative-design",
        headers=auth_headers(),
    )

    assert list_response.status_code == 200
    listed = list_response.json()
    assert listed["ok"] is True
    assert any(
        resource["uri"] == "waypoint://workflow/ncbi-derivative-design"
        for resource in listed["resources"]
    )
    assert resource_response.status_code == 200
    workflow = resource_response.json()["resource"]["workflow"]
    assert workflow["id"] == "ncbi-derivative-design"
    assert workflow["mode"] == "hybrid"
    assert workflow["demand"]["level"] == "high"


def test_mcp_workflow_ledger_resources_summarize_prior_runs(tmp_path, monkeypatch):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    owner_id = "mcp-call-test-agent"
    store.ensure_agent_identity(owner_id, scope=["read-workspace"])
    action_id = store.insert_agent_action(
        agent_identity_id=owner_id,
        tool_name="workflow.step",
        parameters={},
        action_id="owned-workflow-action",
    )
    run_dir = tmp_path / "run-a"
    run_dir.mkdir()
    (run_dir / "workflow-ledger.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "workflow": {
                    "id": "ncbi-derivative-design",
                    "title": "NCBI sequence to derivative design",
                    "mode": "hybrid",
                    "maturity": "live-app-tested",
                    "demand": {"level": "high"},
                },
                "success": True,
                "outcome": "passed",
                "classification": "passed",
                "metrics": {
                    "successful_tool_flows": 6,
                    "failed_tool_flows": 0,
                },
                "command_lifecycle": [{"action_id": action_id}],
            }
        )
    )
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.setenv("DNAFORGE_WORKFLOW_LEDGER_ROOT", str(tmp_path))
    client = TestClient(app)

    summary_response = client.get(
        "/mcp/workflow-ledgers/summary",
        headers=auth_headers(),
    )
    latest_response = client.get(
        "/mcp/workflow-ledgers/latest/ncbi-derivative-design",
        headers=auth_headers(),
    )

    assert summary_response.status_code == 200
    summary = summary_response.json()["resource"]["summary"]
    assert summary["total_runs"] == 1
    assert summary["demand"]["high"]["passed_runs"] == 1
    assert latest_response.status_code == 200
    latest = latest_response.json()["resource"]
    assert latest["workflowId"] == "ncbi-derivative-design"
    assert latest["ledger"]["outcome"] == "passed"


def test_mcp_workflow_prepare_run_tool_returns_command_and_history(
    tmp_path, monkeypatch
):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    owner_id = "mcp-call-test-agent"
    foreign_id = "mcp-call-foreign-agent"
    store.ensure_agent_identity(owner_id, scope=["read-workspace"])
    store.ensure_agent_identity(foreign_id, scope=["read-workspace"])
    own_action_id = store.insert_agent_action(
        agent_identity_id=owner_id,
        tool_name="workflow.step",
        parameters={},
        action_id="prepare-own-workflow-action",
    )
    foreign_action_id = store.insert_agent_action(
        agent_identity_id=foreign_id,
        tool_name="workflow.step",
        parameters={},
        action_id="prepare-foreign-workflow-action",
    )
    run_dir = tmp_path / "run-a"
    run_dir.mkdir()
    (run_dir / "workflow-ledger.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "workflow": {
                    "id": "ncbi-derivative-design",
                    "title": "NCBI sequence to derivative design",
                    "mode": "hybrid",
                    "maturity": "live-app-tested",
                    "demand": {"level": "high"},
                },
                "success": False,
                "outcome": "failed",
                "classification": "observer_gap",
                "failed_stage": "observe_design_state",
                "duration_ms": 200,
                "metrics": {
                    "successful_tool_flows": 5,
                    "failed_tool_flows": 1,
                },
                "command_lifecycle": [{"action_id": own_action_id}],
                "next_actions": ["Repair the observer."],
            }
        )
    )
    foreign_run_dir = tmp_path / "run-b"
    foreign_run_dir.mkdir()
    (foreign_run_dir / "workflow-ledger.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "workflow": {
                    "id": "ncbi-derivative-design",
                    "demand": {"level": "high"},
                },
                "success": True,
                "outcome": "passed",
                "classification": "foreign-run-secret",
                "metrics": {
                    "successful_tool_flows": 99,
                    "failed_tool_flows": 0,
                },
                "command_lifecycle": [{"action_id": foreign_action_id}],
                "next_actions": ["Foreign-only action."],
            }
        )
    )
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.setenv("DNAFORGE_WORKFLOW_LEDGER_ROOT", str(tmp_path))
    client = TestClient(app)

    response = client.post(
        "/mcp/call",
        json={
            "name": "workflow.prepare_run",
            "arguments": {
                "workflowId": "ncbi-derivative-design",
                "buildDesktop": False,
                "timeoutSeconds": 90,
            },
        },
        headers=auth_headers(**{"X-DNAForge-Agent-Capabilities": "read-workspace"}),
    )

    assert response.status_code == 200
    data = response.json()
    result = data["result"]
    assert result["workflowId"] == "ncbi-derivative-design"
    assert result["resources"]["contract"] == (
        "waypoint://workflow/ncbi-derivative-design"
    )
    assert result["command"]["argv"] == [
        "uv",
        "run",
        "python",
        "scripts/agent_mcp_console.py",
        "--workflow",
        "ncbi-derivative-design",
        "--timeout",
        "90",
    ]
    assert result["latestRun"]["classification"] == "observer_gap"
    assert result["latestRun"]["nextActions"] == ["Repair the observer."]
    assert result["runHistory"]["failed_tool_flows"] == 1
    assert result["runHistory"]["runs"] == 1
    assert "foreign-run-secret" not in json.dumps(result)
    assert result["workflowBoundaries"]["missing"] == []
    assert result["workflowBoundaries"]["boundaries"]["app_service"]["steps"] == 5
    assert result["workflowBoundaries"]["boundaries"]["external_provider"][
        "step_ids"
    ] == ["fetch_ncbi_record"]


def test_mcp_call_unknown_tool_returns_structured_404(tmp_path, monkeypatch):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    client = TestClient(app)

    response = client.post(
        "/mcp/call",
        json={"name": "nope", "arguments": {}},
        headers=auth_headers(),
    )

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "UNKNOWN_TOOL"
