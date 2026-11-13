"""Tests for the Phase 1b renderer-backed agent tools."""

from __future__ import annotations

import asyncio
import json
import os

import httpx
import pytest
from fastapi.testclient import TestClient

from src.concurrency import register_builtin_agent_tools
from src.concurrency.job_manager import get_job_manager, reset_job_manager
from src.concurrency.pools import reset_pool_manager
from src.concurrency.renderer_bridge import (
    RENDERER_PROVIDER_TOOL_NAMES,
    RENDERER_TOOL_MANIFEST_PATH,
    RENDERER_TOOL_SPECS,
    call_renderer_bridge,
    load_renderer_tool_manifest,
    load_renderer_tool_specs,
)
from src.concurrency.tool_registry import ToolContext, agent_tool_registry
from src.control_plane import get_control_plane_store, initialize_control_plane
from src.main import app
from src.routes.mcp_auth import (
    MCP_GRANT_IDENTITY_ENV,
    hash_api_key,
    session_grant_capabilities,
)

MCP_TOKEN = "test-mcp-token"


def test_renderer_audit_manifest_preserves_declared_conditional_capabilities():
    from src.routes.renderer_audit import _renderer_manifest_tools

    projected = _renderer_manifest_tools()
    for tool in load_renderer_tool_manifest()["tools"]:
        assert projected[tool["name"]].get(
            "conditional_required_capabilities", []
        ) == tool.get("conditional_required_capabilities", []), tool["name"]


def test_renderer_audit_project_creation_persists_conditional_capability_lifecycle(
    tmp_path,
):
    tool = next(
        tool
        for tool in load_renderer_tool_manifest()["tools"]
        if tool["name"] == "workspace_projects"
    )
    required = tool["required_capabilities"]
    effective = [*required, *tool["conditional_required_capabilities"]]
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    store.ensure_agent_identity("project-agent", scope=effective)
    action_id = store.insert_agent_action(
        agent_identity_id="project-agent",
        tool_name="workspace_projects",
        parameters={"operation": {"kind": "create", "name": "Audit regression"}},
        authorized_scope=effective,
    )
    body = {
        "action_id": action_id,
        "tool_name": "workspace_projects",
        "actor_kind": "renderer",
        "actor_identity": "project-agent",
        "actor_scope": effective,
        "side_effects": tool["effects"],
        "capability_check": {
            "required": required,
            "effective_required": effective,
            "satisfied": True,
            "reason": "granted",
        },
    }
    client = TestClient(app)
    for status in ("accepted", "completed"):
        response = client.post(
            "/mcp/renderer-audit",
            json={**body, "status": status},
            headers=auth_headers(),
        )
        assert response.status_code == 200, response.text
        assert response.json()["ok"] is True

    records = store.get_audit_records_for_action(action_id)
    assert [record["after_state_json"]["status"] for record in records] == [
        "accepted",
        "completed",
    ]
    for record in records:
        assert record["actor_scope_json"] == effective
        assert record["capability_check_json"] == body["capability_check"]


@pytest.mark.parametrize(
    "invalid_claim",
    ["undeclared", "missing-base", "write-workspace", "modify-tabs", "create-entity"],
)
def test_renderer_audit_project_creation_rejects_invalid_effective_capabilities(
    tmp_path, invalid_claim
):
    tool = next(
        tool
        for tool in load_renderer_tool_manifest()["tools"]
        if tool["name"] == "workspace_projects"
    )
    effective = [
        *tool["required_capabilities"],
        *tool["conditional_required_capabilities"],
    ]
    scope = list(effective)
    if invalid_claim == "undeclared":
        effective.append("undeclared-renderer-capability")
        scope.append("undeclared-renderer-capability")
    elif invalid_claim == "missing-base":
        effective.remove("read-workspace")
    else:
        scope.remove(invalid_claim)
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    store.ensure_agent_identity("project-agent", scope=["*"])
    action_id = store.insert_agent_action(
        agent_identity_id="project-agent",
        tool_name="workspace_projects",
        parameters={"operation": {"kind": "create", "name": "Audit regression"}},
        authorized_scope=scope,
    )
    response = TestClient(app).post(
        "/mcp/renderer-audit",
        json={
            "action_id": action_id,
            "tool_name": "workspace_projects",
            "actor_kind": "renderer",
            "actor_identity": "project-agent",
            "actor_scope": scope,
            "side_effects": tool["effects"],
            "capability_check": {
                "required": tool["required_capabilities"],
                "effective_required": effective,
                "satisfied": True,
                "reason": "granted",
            },
            "status": "accepted",
        },
        headers=auth_headers(),
    )
    assert response.status_code == 400
    error = response.json()["error"]
    assert error["code"] == "BAD_INPUT"
    assert error["message"] == (
        "Renderer audit effective capabilities do not match the declared tool capabilities."
        if invalid_claim in {"undeclared", "missing-base"}
        else "Renderer audit claims satisfied capabilities outside the actor scope."
    )
    assert store.get_audit_records_for_action(action_id) == []


def setup_function():
    agent_tool_registry.clear()
    register_builtin_agent_tools()
    reset_job_manager()
    reset_pool_manager()


@pytest.fixture(autouse=True)
def configured_session_grant(monkeypatch):
    monkeypatch.setenv("DNAFORGE_MCP_GRANT_CAPABILITIES", "*")
    monkeypatch.setenv(MCP_GRANT_IDENTITY_ENV, "renderer-tool-test-agent")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)


def auth_headers(**extra: str) -> dict[str, str]:
    identity_id = os.environ.get(MCP_GRANT_IDENTITY_ENV)
    if identity_id:
        get_control_plane_store().ensure_agent_identity(
            identity_id,
            scope=session_grant_capabilities() or [],
        )
    return {"X-DNAForge-Session": MCP_TOKEN, **extra}


def test_renderer_tools_include_workspace_reads_on_the_shared_policy_surface(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.setenv("DNAFORGE_MCP_AGENT_IDENTITY", "renderer-list-agent")
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    store.ensure_agent_identity("renderer-list-agent", scope=["*"])
    client = TestClient(app)

    response = client.get("/api/tools", headers=auth_headers())

    assert response.status_code == 200
    tools = {tool["name"]: tool for tool in response.json()["tools"]}
    manifest_tool_names = {
        tool["name"] for tool in load_renderer_tool_manifest()["tools"]
    }
    assert manifest_tool_names.issubset(tools)
    assert set(RENDERER_PROVIDER_TOOL_NAMES.values()).issubset(tools)
    assert tools["external_fetch"]["spec"]["required_capabilities"] == [
        "external-fetch:annotation"
    ]
    assert tools["list_files"]["spec"]["required_capabilities"] == ["read-workspace"]
    assert tools["read_file"]["spec"]["required_capabilities"] == ["read-workspace"]
    assert tools["get_file_changes"]["spec"]["required_capabilities"] == [
        "read-workspace"
    ]
    assert tools["get_workspace"]["spec"]["home"] == "renderer"
    assert tools["get_workspace"]["mcp"]["annotations"]["audited"] is True
    assert tools["get_design"]["spec"]["required_capabilities"] == ["read-workspace"]
    assert tools["get_sequence"]["spec"]["required_capabilities"] == ["read-sequences"]
    assert tools["open_tab"]["spec"]["required_capabilities"] == ["modify-tabs"]
    assert tools["create_design"]["spec"]["required_capabilities"] == [
        "create-entity",
        "modify-tabs",
    ]
    assert tools["create_reference"]["spec"]["conditional_required_capabilities"] == [
        "read-workspace",
        "read-sequences",
    ]
    assert tools["create_reference"]["spec"]["requires_workspace"] is False
    assert tools["create_reference"]["spec"]["conditionally_requires_workspace"] is True
    assert tools["create_reference"]["mcp"]["annotations"][
        "conditionalRequiredCapabilities"
    ] == ["read-workspace", "read-sequences"]
    assert (
        tools["create_reference"]["mcp"]["annotations"][
            "conditionallyRequiresWorkspace"
        ]
        is True
    )
    assert tools["save_active_residue_selection"]["mcp"]["annotations"][
        "conditionalRequiredCapabilities"
    ] == ["external-fetch:structure"]
    assert tools["add_design_region"]["spec"]["required_capabilities"] == [
        "create-entity",
        "read-sequences",
    ]
    assert tools["draft_design_assembly"]["spec"]["required_capabilities"] == [
        "create-entity",
    ]
    assert tools["import_sequence"]["spec"]["required_capabilities"] == [
        "create-entity",
        "read-sequences",
        "modify-tabs",
    ]
    assert tools["plan_design_regions"]["spec"]["required_capabilities"] == [
        "read-sequences"
    ]
    import_schema = tools["import_sequence"]["mcp"]["inputSchema"]
    assert import_schema["oneOf"] == [
        {"required": ["source"]},
        {"required": ["sourcePath"]},
    ]
    assert (
        import_schema["properties"]["source"]["anyOf"][3]["properties"]["kind"]["const"]
        == "ncbi"
    )
    plan_schema = tools["plan_design_regions"]["mcp"]["inputSchema"]
    assert plan_schema["required"] == ["documentId"]
    assert "path" not in plan_schema["properties"]
    assert plan_schema["properties"]["maxRegions"]["default"] == 2


def test_sidecar_renderer_registry_is_loaded_from_shared_manifest():
    assert RENDERER_TOOL_MANIFEST_PATH.exists()
    assert RENDERER_TOOL_MANIFEST_PATH.as_posix().endswith(
        "packages/core/agent-tools/renderer-tool-manifest.json"
    )

    manifest = load_renderer_tool_manifest()
    sidecar_names = {spec["name"] for spec in RENDERER_TOOL_SPECS}
    manifest_names = {tool["name"] for tool in manifest["tools"]}

    assert sidecar_names == manifest_names
    assert all(
        agent_tool_registry.require(name).spec.category.cancelable is False
        for name in sidecar_names
    )


def test_renderer_manifest_requires_explicit_valid_exposure(tmp_path):
    base_tool = {
        "name": "test_tool",
        "description": "Test tool.",
        "inputSchema": {"type": "object", "properties": {}},
        "outputSchema": {
            "type": "object",
            "properties": {"ok": {"const": True}},
            "required": ["ok"],
        },
        "shape": "data-service",
        "effects": ["read-only"],
        "required_capabilities": ["read-workspace"],
        "requiresWorkspace": False,
    }

    def write_manifest(exposure):
        path = tmp_path / "renderer-tool-manifest.json"
        path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "tools": [{**base_tool, "exposure": exposure}],
                }
            ),
            encoding="utf-8",
        )
        return path

    shared_specs = load_renderer_tool_specs(write_manifest({"kind": "shared"}))
    assert shared_specs[0]["exposure"] == {"kind": "shared"}

    mcp_specs = load_renderer_tool_specs(
        write_manifest({"kind": "mcp-only", "reason": "MCP owns the stream."})
    )
    assert mcp_specs[0]["exposure"] == {
        "kind": "mcp-only",
        "reason": "MCP owns the stream.",
    }

    with pytest.raises(RuntimeError, match="must declare exposure"):
        load_renderer_tool_specs(write_manifest(None))
    with pytest.raises(RuntimeError, match="requires a reason"):
        load_renderer_tool_specs(write_manifest({"kind": "mcp-only", "reason": "  "}))
    with pytest.raises(RuntimeError, match="shared or mcp-only"):
        load_renderer_tool_specs(write_manifest({"kind": "hosted-only"}))


def test_renderer_operation_start_requires_a_sidecar_owner(tmp_path):
    manifest = load_renderer_tool_manifest()
    run_msa = next(tool for tool in manifest["tools"] if tool["name"] == "run_msa")
    run_msa["sidecarOrchestrated"] = False
    path = tmp_path / "renderer-tool-manifest.json"
    path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(
        RuntimeError, match="starts a managed operation.*no sidecar owner"
    ):
        load_renderer_tool_specs(path)


def test_mcp_call_forwards_renderer_tool_with_session_and_scope(tmp_path, monkeypatch):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.setenv(MCP_GRANT_IDENTITY_ENV, "agent-1")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_URL", "http://127.0.0.1:7777")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", "renderer-secret")
    captured: dict[str, object] = {}

    async def fake_post(self, url, json, headers):  # noqa: ANN001
        captured["url"] = url
        captured["json"] = json
        captured["headers"] = headers
        return httpx.Response(
            200,
            json={
                "ok": True,
                "result": {
                    "ok": True,
                    "workspaceId": None,
                    "workspaceFile": None,
                    "focusedPanelId": "main",
                    "projects": [],
                    "referenceFolders": [],
                    "folders": [],
                    "panels": [],
                },
                "audit_id": "renderer-audit-1",
            },
        )

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    client = TestClient(app)

    response = client.post(
        "/mcp/call",
        json={"name": "get_workspace", "arguments": {}},
        headers=auth_headers(
            **{
                "X-DNAForge-Agent-Identity": "agent-1",
                "X-DNAForge-Agent-Capabilities": "read-workspace",
                "X-DNAForge-Turn-Id": "turn-sidecar-1",
            }
        ),
    )

    assert response.status_code == 200
    data = response.json()
    assert data["ok"] is True
    assert data["result"]["ok"] is True
    assert data["result"]["audit_id"] == "renderer-audit-1"
    assert captured["url"] == "http://127.0.0.1:7777/__tools/call"
    assert captured["json"] == {
        "tool_name": "get_workspace",
        "args": {},
        "agent_identity": "agent-1",
        "action_id": data["jobId"],
    }
    headers = captured["headers"]
    assert isinstance(headers, dict)
    assert headers["X-DNAForge-Session"] == "renderer-secret"
    assert headers["X-DNAForge-Agent-Identity"] == "agent-1"
    assert headers["X-DNAForge-Action-Id"] == data["jobId"]
    assert headers["X-DNAForge-Turn-Id"] == "turn-sidecar-1"
    assert json.loads(headers["X-DNAForge-Agent-Capabilities"]) == ["read-workspace"]

    audit_records = get_control_plane_store().get_audit_records_for_action(
        data["jobId"]
    )
    assert audit_records[0]["actor_kind"] == "agent"
    assert audit_records[0]["actor_scope_json"] == ["read-workspace"]


def test_raw_api_key_route_forwards_external_tool_scope_to_renderer(
    tmp_path, monkeypatch
):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.delenv("DNAFORGE_MCP_SESSION_TOKEN", raising=False)
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_URL", "http://127.0.0.1:7777")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", "renderer-secret")
    api_key = "dna_key_external_fetch"
    store.create_agent_identity(
        identity_id="raw-api-external-agent",
        scope=["external-fetch:annotation"],
        label="External fetch API key",
        kind="http-api-key",
        api_key_hash=hash_api_key(api_key),
    )
    captured: dict[str, object] = {}

    async def fake_post(self, url, json, headers):  # noqa: ANN001
        captured["url"] = url
        captured["json"] = json
        captured["headers"] = headers
        return httpx.Response(
            200,
            json={
                "ok": True,
                "result": {
                    "ok": True,
                    "status": 200,
                    "external_resource_id": "resource-1",
                    "provider": "uniprot",
                    "external_id": "P12345",
                    "cache_hit": False,
                    "license": None,
                    "attribution": None,
                    "metadata": {},
                    "xref_count": 0,
                },
                "audit_id": "renderer-audit-api-key",
            },
        )

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    client = TestClient(app)

    discovery = client.get(
        "/api/tools/external_fetch",
        headers={"X-DNAForge-API-Key": api_key},
    )
    response = client.post(
        "/api/tools/external_fetch/execute",
        json={"provider": "uniprot", "external_id": "P12345"},
        headers={"X-DNAForge-API-Key": api_key},
    )

    assert discovery.status_code == 200
    assert discovery.json()["spec"]["name"] == "external_fetch"
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "completed"
    assert data["result"]["result"]["external_resource_id"] == "resource-1"
    assert data["result"]["result"]["ok"] is True
    assert data["result"]["result"]["provider"] == "uniprot"
    assert data["result"]["audit_id"] == "renderer-audit-api-key"
    assert captured["url"] == "http://127.0.0.1:7777/__tools/call"
    assert captured["json"] == {
        "tool_name": "external.fetch",
        "args": {"provider": "uniprot", "external_id": "P12345"},
        "agent_identity": "raw-api-external-agent",
        "action_id": data["jobId"],
    }
    headers = captured["headers"]
    assert isinstance(headers, dict)
    assert headers["X-DNAForge-Agent-Identity"] == "raw-api-external-agent"
    assert json.loads(headers["X-DNAForge-Agent-Capabilities"]) == [
        "external-fetch:annotation"
    ]


def test_mcp_call_forwards_attenuated_scope_for_renderer_authorization(
    tmp_path, monkeypatch
):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_URL", "http://127.0.0.1:7777")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", "renderer-secret")
    monkeypatch.delenv("DNAFORGE_MCP_GRANT_CAPABILITIES", raising=False)
    captured: dict[str, object] = {}

    async def fake_post(self, url, json, headers):  # noqa: ANN001
        captured["headers"] = headers
        return httpx.Response(
            200,
            json={
                "ok": False,
                "error": {
                    "code": "INSUFFICIENT_SCOPE",
                    "message": "Renderer authorization rejected the call.",
                    "retriable": False,
                    "details": {"required": ["read-workspace"], "provided": []},
                },
                "audit_id": "audit-1",
            },
        )

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    client = TestClient(app)

    response = client.post(
        "/mcp/call",
        json={"name": "get_workspace", "arguments": {}},
        headers=auth_headers(**{"X-DNAForge-Agent-Capabilities": "*"}),
    )

    assert response.status_code == 200
    headers = captured["headers"]
    assert isinstance(headers, dict)
    assert json.loads(headers["X-DNAForge-Agent-Capabilities"]) == []
    data = response.json()
    assert data["ok"] is False
    assert data["status"] == "failed"
    assert data["error"]["code"] == "INSUFFICIENT_SCOPE"
    assert data["error"]["details"]["renderer_audit_id"] == "audit-1"


def test_mcp_call_marks_renderer_tool_error_as_failed(tmp_path, monkeypatch):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_URL", "http://127.0.0.1:7777")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", "renderer-secret")

    async def fake_post(self, url, json, headers):  # noqa: ANN001
        return httpx.Response(
            200,
            json={
                "ok": False,
                "error": {
                    "code": "BAD_INPUT",
                    "message": "Renderer tool input failed validation.",
                    "retriable": False,
                    "details": {"field": "path"},
                },
                "audit_id": "renderer-audit-1",
            },
        )

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    client = TestClient(app)

    response = client.post(
        "/mcp/call",
        json={"name": "get_workspace", "arguments": {}},
        headers=auth_headers(**{"X-DNAForge-Agent-Capabilities": "read-workspace"}),
    )

    assert response.status_code == 200
    data = response.json()
    assert data["ok"] is False
    assert data["status"] == "failed"
    assert data["error"]["code"] == "BAD_INPUT"
    assert data["error"]["details"] == {
        "field": "path",
        "renderer_audit_id": "renderer-audit-1",
    }
    action = get_control_plane_store().get_agent_action(data["jobId"])
    assert action["error_json"]["code"] == "BAD_INPUT"
    assert action["result_json"] is None


def test_mcp_call_replays_failed_renderer_mutation_for_same_idempotency_key(
    tmp_path, monkeypatch
):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", MCP_TOKEN)
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_URL", "http://127.0.0.1:7777")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", "renderer-secret")
    calls = 0

    async def fake_post(self, url, json, headers):  # noqa: ANN001
        nonlocal calls
        calls += 1
        return httpx.Response(
            200,
            json={
                "ok": False,
                "error": {
                    "code": "SAVE_ARTIFACT_FAILED",
                    "message": "Artifact exists but viewer projection failed.",
                    "retriable": False,
                    "details": {
                        "stateChanged": True,
                        "partialEffects": [
                            {"kind": "saved-selection-created", "id": "selection-1"}
                        ],
                    },
                },
                "audit_id": "renderer-audit-partial",
            },
        )

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    client = TestClient(app)
    headers = auth_headers(
        **{
            "X-DNAForge-Agent-Capabilities": "read-workspace",
            "Idempotency-Key": "hosted:turn-1:get_workspace:call-1",
        }
    )

    first = client.post(
        "/mcp/call",
        json={"name": "get_workspace", "arguments": {}},
        headers=headers,
    )
    second = client.post(
        "/mcp/call",
        json={"name": "get_workspace", "arguments": {}},
        headers=headers,
    )

    assert calls == 1
    assert second.json() == first.json()
    assert second.json()["error"]["details"] == {
        "stateChanged": True,
        "partialEffects": [{"kind": "saved-selection-created", "id": "selection-1"}],
        "renderer_audit_id": "renderer-audit-partial",
    }


@pytest.mark.parametrize("action_tool", ["workspace_git_status", "workspace.gitStatus"])
def test_renderer_audit_accepts_declared_provider_alias(
    tmp_path, monkeypatch, action_tool
):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    store.ensure_agent_identity("agent-1", scope=["read-workspace"])
    action_id = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name=action_tool,
        parameters={},
        authorized_scope=["read-workspace"],
    )
    response = TestClient(app).post(
        "/mcp/renderer-audit",
        json={
            "action_id": action_id,
            "tool_name": "workspace.gitStatus",
            "actor_kind": "renderer",
            "actor_identity": "agent-1",
            "actor_scope": ["read-workspace"],
            "side_effects": ["read-only"],
            "capability_check": {
                "required": ["read-workspace"],
                "satisfied": True,
                "reason": "granted",
            },
            "status": "completed",
            "outcome": {"ok": True, "result": {"changes": []}},
        },
        headers=auth_headers(),
    )
    assert response.status_code == 200, response.text
    assert store.get_agent_action(action_id)["completed_at"] is not None
    assert store.get_agent_action(action_id)["error_json"] is None
    assert store.get_audit_records_for_action(action_id)[0]["actor_kind"] == "renderer"


@pytest.mark.parametrize(
    ("effective", "scope", "expected_status"),
    [
        (["read-workspace", "modify-tabs"], ["read-workspace", "modify-tabs"], 200),
        (["read-workspace", "modify-tabs"], ["read-workspace"], 400),
        (["read-workspace", "undeclared-permission"], ["*"], 400),
    ],
)
def test_renderer_audit_preserves_declared_conditional_permissions(
    tmp_path, effective, scope, expected_status
):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    store.ensure_agent_identity("conditional-agent", scope=scope)
    action_id = store.insert_agent_action(
        agent_identity_id="conditional-agent",
        tool_name="app_views",
        parameters={"operation": {"kind": "navigate", "target": "new-chat"}},
        authorized_scope=scope,
    )
    response = TestClient(app).post(
        "/mcp/renderer-audit",
        json={
            "action_id": action_id,
            "tool_name": "app_views",
            "actor_kind": "renderer",
            "actor_identity": "conditional-agent",
            "actor_scope": scope,
            "side_effects": ["read-only", "ui-bound", "mutating"],
            "capability_check": {
                "required": ["read-workspace"],
                "effective_required": effective,
                "satisfied": True,
                "reason": "granted",
            },
            "status": "accepted",
        },
        headers=auth_headers(),
    )
    assert response.status_code == expected_status, response.text
    if expected_status == 200:
        assert len(store.get_audit_records_for_action(action_id)) == 1


def test_renderer_audit_endpoint_persists_renderer_record(tmp_path, monkeypatch):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", "renderer-secret")
    store.ensure_agent_identity("agent-1", scope=["read-workspace"])
    action_id = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="get_workspace",
        parameters={},
    )
    client = TestClient(app)

    response = client.post(
        "/mcp/renderer-audit",
        json={
            "action_id": action_id,
            "tool_name": "get_workspace",
            "actor_kind": "renderer",
            "actor_identity": "agent-1",
            "actor_scope": ["read-workspace"],
            "side_effects": ["read-only"],
            "capability_check": {
                "required": ["read-workspace"],
                "satisfied": True,
                "reason": "granted",
            },
            "status": "completed",
        },
        headers=auth_headers(),
    )

    assert response.status_code == 200
    data = response.json()
    assert data["ok"] is True
    audit_records = store.get_audit_records_for_action(action_id)
    assert audit_records[0]["id"] == data["audit_id"]
    assert audit_records[0]["actor_kind"] == "renderer"
    assert audit_records[0]["actor_scope_json"] == ["read-workspace"]
    assert audit_records[0]["after_state_json"] == {"status": "completed"}


def test_renderer_audit_projects_managed_operation_result(tmp_path, monkeypatch):
    marker = "SCIENTIFIC-RENDERER-RESULT-MARKER"
    capabilities = ["operations.read", "read-workspace", "read-sequences"]
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", "renderer-secret")
    store.ensure_agent_identity("agent-1", scope=capabilities)
    action_id = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="operations.annotation.inspect",
        parameters={"operationId": "operation-1", "targetDocumentId": "sequence-1"},
        authorized_scope=capabilities,
        job_pool="cpu-fast",
        job_cancelable=False,
    )
    client = TestClient(app)

    response = client.post(
        "/mcp/renderer-audit",
        json={
            "action_id": action_id,
            "tool_name": "operations.annotation.inspect",
            "actor_kind": "renderer",
            "actor_identity": "agent-1",
            "actor_scope": capabilities,
            "side_effects": ["read-only"],
            "capability_check": {
                "required": capabilities,
                "satisfied": True,
                "reason": "granted",
            },
            "status": "completed",
            "outcome": {
                "ok": True,
                "result": {"candidates": [{"feature": {"name": marker}}]},
            },
        },
        headers=auth_headers(),
    )

    assert response.status_code == 200, response.text
    action = store.get_agent_action(action_id)
    assert marker not in json.dumps(action, sort_keys=True)
    projection = action["result_json"]["_dnaforge_audit_result_projection_v1"]
    assert projection["schema_version"] == 1
    assert projection["payload_bytes"] > 0
    assert projection["payload_sha256"].startswith("sha256:")
    snapshot = get_job_manager().snapshot(action_id)
    assert snapshot is not None
    assert "result" not in snapshot
    assert snapshot["resultProjection"] == projection


def test_renderer_audit_endpoint_accepts_pre_execution_accepted_status(
    tmp_path, monkeypatch
):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", "renderer-secret")
    store.ensure_agent_identity("agent-1", scope=["modify-tabs"])
    action_id = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="open_tab",
        parameters={"type": "structure", "entityId": "structure:1RBL", "label": "1RBL"},
    )
    client = TestClient(app)

    response = client.post(
        "/mcp/renderer-audit",
        json={
            "action_id": action_id,
            "tool_name": "open_tab",
            "actor_kind": "renderer",
            "actor_identity": "agent-1",
            "actor_scope": ["modify-tabs"],
            "side_effects": ["ui-bound"],
            "capability_check": {
                "required": ["modify-tabs"],
                "satisfied": True,
                "reason": "granted",
            },
            "status": "accepted",
        },
        headers=auth_headers(),
    )

    assert response.status_code == 200
    audit_records = store.get_audit_records_for_action(action_id)
    assert audit_records[0]["after_state_json"] == {"status": "accepted"}


def test_renderer_audit_endpoint_rejects_side_effect_completion_without_prior_acceptance(
    tmp_path, monkeypatch
):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", "renderer-secret")
    store.ensure_agent_identity("agent-1", scope=["modify-tabs"])
    action_id = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="open_tab",
        parameters={"type": "structure", "entityId": "structure:1RBL", "label": "1RBL"},
    )
    client = TestClient(app)

    response = client.post(
        "/mcp/renderer-audit",
        json={
            "action_id": action_id,
            "tool_name": "open_tab",
            "actor_kind": "renderer",
            "actor_identity": "agent-1",
            "actor_scope": ["modify-tabs"],
            "side_effects": ["ui-bound"],
            "capability_check": {
                "required": ["modify-tabs"],
                "satisfied": True,
                "reason": "granted",
            },
            "status": "completed",
        },
        headers=auth_headers(),
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "BAD_INPUT"
    assert store.get_audit_records_for_action(action_id) == []


def test_renderer_audit_endpoint_accepts_side_effect_completion_after_prior_acceptance(
    tmp_path, monkeypatch
):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", "renderer-secret")
    store.ensure_agent_identity("agent-1", scope=["modify-tabs"])
    action_id = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="open_tab",
        parameters={"type": "structure", "entityId": "structure:1RBL", "label": "1RBL"},
    )
    client = TestClient(app)

    base_body = {
        "action_id": action_id,
        "tool_name": "open_tab",
        "actor_kind": "renderer",
        "actor_identity": "agent-1",
        "actor_scope": ["modify-tabs"],
        "side_effects": ["ui-bound"],
        "capability_check": {
            "required": ["modify-tabs"],
            "satisfied": True,
            "reason": "granted",
        },
    }
    accepted = client.post(
        "/mcp/renderer-audit",
        json={**base_body, "status": "accepted"},
        headers=auth_headers(),
    )
    completed = client.post(
        "/mcp/renderer-audit",
        json={**base_body, "status": "completed"},
        headers=auth_headers(),
    )

    assert accepted.status_code == 200
    assert completed.status_code == 200
    audit_records = store.get_audit_records_for_action(action_id)
    assert [record["after_state_json"]["status"] for record in audit_records] == [
        "accepted",
        "completed",
    ]


@pytest.mark.parametrize(
    ("first_terminal_status", "second_terminal_status"),
    [
        ("completed", "failed"),
        ("failed", "completed"),
    ],
)
def test_renderer_audit_endpoint_rejects_second_side_effect_terminal_status(
    tmp_path, monkeypatch, first_terminal_status, second_terminal_status
):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", "renderer-secret")
    store.ensure_agent_identity("agent-1", scope=["modify-tabs"])
    action_id = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="open_tab",
        parameters={"type": "structure", "entityId": "structure:1RBL", "label": "1RBL"},
    )
    client = TestClient(app)

    base_body = {
        "action_id": action_id,
        "tool_name": "open_tab",
        "actor_kind": "renderer",
        "actor_identity": "agent-1",
        "actor_scope": ["modify-tabs"],
        "side_effects": ["ui-bound"],
        "capability_check": {
            "required": ["modify-tabs"],
            "satisfied": True,
            "reason": "granted",
        },
    }

    accepted = client.post(
        "/mcp/renderer-audit",
        json={**base_body, "status": "accepted"},
        headers=auth_headers(),
    )
    first_terminal = client.post(
        "/mcp/renderer-audit",
        json={**base_body, "status": first_terminal_status},
        headers=auth_headers(),
    )
    second_terminal = client.post(
        "/mcp/renderer-audit",
        json={**base_body, "status": second_terminal_status},
        headers=auth_headers(),
    )

    assert accepted.status_code == 200
    assert first_terminal.status_code == 200
    assert second_terminal.status_code == 400
    assert second_terminal.json()["error"]["code"] == "BAD_INPUT"
    audit_records = store.get_audit_records_for_action(action_id)
    assert [record["after_state_json"]["status"] for record in audit_records] == [
        "accepted",
        first_terminal_status,
    ]


def test_renderer_audit_endpoint_rejects_side_effect_acceptance_after_terminal_status(
    tmp_path, monkeypatch
):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", "renderer-secret")
    store.ensure_agent_identity("agent-1", scope=["modify-tabs"])
    action_id = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="open_tab",
        parameters={"type": "structure", "entityId": "structure:1RBL", "label": "1RBL"},
    )
    client = TestClient(app)

    base_body = {
        "action_id": action_id,
        "tool_name": "open_tab",
        "actor_kind": "renderer",
        "actor_identity": "agent-1",
        "actor_scope": ["modify-tabs"],
        "side_effects": ["ui-bound"],
        "capability_check": {
            "required": ["modify-tabs"],
            "satisfied": True,
            "reason": "granted",
        },
    }

    accepted = client.post(
        "/mcp/renderer-audit",
        json={**base_body, "status": "accepted"},
        headers=auth_headers(),
    )
    completed = client.post(
        "/mcp/renderer-audit",
        json={**base_body, "status": "completed"},
        headers=auth_headers(),
    )
    late_accepted = client.post(
        "/mcp/renderer-audit",
        json={**base_body, "status": "accepted"},
        headers=auth_headers(),
    )

    assert accepted.status_code == 200
    assert completed.status_code == 200
    assert late_accepted.status_code == 400
    assert late_accepted.json()["error"]["code"] == "BAD_INPUT"
    audit_records = store.get_audit_records_for_action(action_id)
    assert [record["after_state_json"]["status"] for record in audit_records] == [
        "accepted",
        "completed",
    ]


def test_renderer_audit_endpoint_uses_action_scope_not_identity_scope(
    tmp_path, monkeypatch
):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", "renderer-secret")
    store.ensure_agent_identity("agent-1", scope=[])
    action_id = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="open_tab",
        parameters={"type": "structure", "entityId": "structure:1RBL", "label": "1RBL"},
        authorized_scope=["modify-tabs"],
    )
    client = TestClient(app)

    response = client.post(
        "/mcp/renderer-audit",
        json={
            "action_id": action_id,
            "tool_name": "open_tab",
            "actor_kind": "renderer",
            "actor_identity": "agent-1",
            "actor_scope": ["modify-tabs"],
            "side_effects": ["ui-bound"],
            "capability_check": {
                "required": ["modify-tabs"],
                "satisfied": True,
                "reason": "granted",
            },
            "status": "accepted",
        },
        headers=auth_headers(),
    )

    assert response.status_code == 200
    audit_records = store.get_audit_records_for_action(action_id)
    assert audit_records[0]["actor_scope_json"] == ["modify-tabs"]


def test_renderer_audit_endpoint_accepts_matching_after_state_status(
    tmp_path, monkeypatch
):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", "renderer-secret")
    store.ensure_agent_identity("agent-1", scope=["modify-tabs"])
    action_id = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="open_tab",
        parameters={"type": "structure", "entityId": "structure:1RBL", "label": "1RBL"},
    )
    client = TestClient(app)

    response = client.post(
        "/mcp/renderer-audit",
        json={
            "action_id": action_id,
            "tool_name": "open_tab",
            "actor_kind": "renderer",
            "actor_identity": "agent-1",
            "actor_scope": ["modify-tabs"],
            "side_effects": ["ui-bound"],
            "capability_check": {
                "required": ["modify-tabs"],
                "satisfied": True,
                "reason": "granted",
            },
            "status": "accepted",
            "after_state": {"status": "accepted"},
        },
        headers=auth_headers(),
    )

    assert response.status_code == 200
    audit_records = store.get_audit_records_for_action(action_id)
    assert audit_records[0]["after_state_json"] == {"status": "accepted"}


def test_renderer_audit_endpoint_injects_status_into_supplied_after_state(
    tmp_path, monkeypatch
):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", "renderer-secret")
    store.ensure_agent_identity("agent-1", scope=["modify-tabs"])
    action_id = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="open_tab",
        parameters={"type": "structure", "entityId": "structure:1RBL", "label": "1RBL"},
    )
    client = TestClient(app)

    response = client.post(
        "/mcp/renderer-audit",
        json={
            "action_id": action_id,
            "tool_name": "open_tab",
            "actor_kind": "renderer",
            "actor_identity": "agent-1",
            "actor_scope": ["modify-tabs"],
            "side_effects": ["ui-bound"],
            "capability_check": {
                "required": ["modify-tabs"],
                "satisfied": True,
                "reason": "granted",
            },
            "status": "accepted",
            "after_state": {"tab_id": "tab-1"},
        },
        headers=auth_headers(),
    )

    assert response.status_code == 200
    audit_records = store.get_audit_records_for_action(action_id)
    assert audit_records[0]["after_state_json"] == {
        "tab_id": "tab-1",
        "status": "accepted",
    }


def test_renderer_audit_endpoint_rejects_mismatched_after_state_status(
    tmp_path, monkeypatch
):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", "renderer-secret")
    store.ensure_agent_identity("agent-1", scope=["modify-tabs"])
    action_id = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="open_tab",
        parameters={"type": "structure", "entityId": "structure:1RBL", "label": "1RBL"},
    )
    client = TestClient(app)

    response = client.post(
        "/mcp/renderer-audit",
        json={
            "action_id": action_id,
            "tool_name": "open_tab",
            "actor_kind": "renderer",
            "actor_identity": "agent-1",
            "actor_scope": ["modify-tabs"],
            "side_effects": ["ui-bound"],
            "capability_check": {
                "required": ["modify-tabs"],
                "satisfied": True,
                "reason": "granted",
            },
            "status": "accepted",
            "after_state": {"status": "queued"},
        },
        headers=auth_headers(),
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "BAD_INPUT"
    assert store.get_audit_records_for_action(action_id) == []


def test_renderer_audit_endpoint_rejects_mismatched_tool_name(tmp_path, monkeypatch):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", "renderer-secret")
    store.ensure_agent_identity("agent-1", scope=["read-workspace"])
    action_id = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="external.fetch",
        parameters={"provider": "rcsb", "external_id": "1RBL"},
    )
    client = TestClient(app)

    response = client.post(
        "/mcp/renderer-audit",
        json={
            "action_id": action_id,
            "tool_name": "get_workspace",
            "actor_kind": "renderer",
            "actor_identity": "agent-1",
            "actor_scope": ["read-workspace"],
            "side_effects": ["read-only"],
            "capability_check": {
                "required": ["read-workspace"],
                "satisfied": True,
                "reason": "granted",
            },
            "status": "completed",
        },
        headers=auth_headers(),
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "BAD_INPUT"
    assert store.get_audit_records_for_action(action_id) == []


def test_renderer_audit_endpoint_rejects_manifest_mismatched_side_effects(
    tmp_path, monkeypatch
):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", "renderer-secret")
    store.ensure_agent_identity("agent-1", scope=["modify-tabs"])
    action_id = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="open_tab",
        parameters={"type": "structure", "entityId": "structure:1RBL", "label": "1RBL"},
    )
    client = TestClient(app)

    response = client.post(
        "/mcp/renderer-audit",
        json={
            "action_id": action_id,
            "tool_name": "open_tab",
            "actor_kind": "renderer",
            "actor_identity": "agent-1",
            "actor_scope": ["modify-tabs"],
            "side_effects": ["read-only"],
            "capability_check": {
                "required": ["modify-tabs"],
                "satisfied": True,
                "reason": "granted",
            },
            "status": "accepted",
        },
        headers=auth_headers(),
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "BAD_INPUT"
    assert store.get_audit_records_for_action(action_id) == []


def test_renderer_audit_endpoint_rejects_manifest_mismatched_capability_check(
    tmp_path, monkeypatch
):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", "renderer-secret")
    store.ensure_agent_identity("agent-1", scope=["modify-tabs"])
    action_id = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="open_tab",
        parameters={"type": "structure", "entityId": "structure:1RBL", "label": "1RBL"},
    )
    client = TestClient(app)

    response = client.post(
        "/mcp/renderer-audit",
        json={
            "action_id": action_id,
            "tool_name": "open_tab",
            "actor_kind": "renderer",
            "actor_identity": "agent-1",
            "actor_scope": ["modify-tabs"],
            "side_effects": ["ui-bound"],
            "capability_check": {
                "required": [],
                "satisfied": True,
                "reason": "granted",
            },
            "status": "accepted",
        },
        headers=auth_headers(),
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "BAD_INPUT"
    assert store.get_audit_records_for_action(action_id) == []


def test_renderer_audit_endpoint_rejects_satisfied_claim_outside_actor_scope(
    tmp_path, monkeypatch
):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", "renderer-secret")
    store.ensure_agent_identity("agent-1", scope=[])
    action_id = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="open_tab",
        parameters={"type": "structure", "entityId": "structure:1RBL", "label": "1RBL"},
    )
    client = TestClient(app)

    response = client.post(
        "/mcp/renderer-audit",
        json={
            "action_id": action_id,
            "tool_name": "open_tab",
            "actor_kind": "renderer",
            "actor_identity": "agent-1",
            "actor_scope": [],
            "side_effects": ["ui-bound"],
            "capability_check": {
                "required": ["modify-tabs"],
                "satisfied": True,
                "reason": "granted",
            },
            "status": "accepted",
        },
        headers=auth_headers(),
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "BAD_INPUT"
    assert store.get_audit_records_for_action(action_id) == []


def test_renderer_audit_endpoint_rejects_forged_actor_scope_not_authorized_by_sidecar(
    tmp_path, monkeypatch
):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", "renderer-secret")
    store.ensure_agent_identity("agent-1", scope=[])
    action_id = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="open_tab",
        parameters={"type": "structure", "entityId": "structure:1RBL", "label": "1RBL"},
    )
    client = TestClient(app)

    response = client.post(
        "/mcp/renderer-audit",
        json={
            "action_id": action_id,
            "tool_name": "open_tab",
            "actor_kind": "renderer",
            "actor_identity": "agent-1",
            "actor_scope": ["modify-tabs"],
            "side_effects": ["ui-bound"],
            "capability_check": {
                "required": ["modify-tabs"],
                "satisfied": True,
                "reason": "granted",
            },
            "status": "accepted",
        },
        headers=auth_headers(),
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "BAD_INPUT"
    assert store.get_audit_records_for_action(action_id) == []


def test_renderer_audit_endpoint_rejects_wildcard_actor_scope_not_authorized_by_sidecar(
    tmp_path, monkeypatch
):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", "renderer-secret")
    store.ensure_agent_identity("agent-1", scope=["modify-tabs"])
    action_id = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="open_tab",
        parameters={"type": "structure", "entityId": "structure:1RBL", "label": "1RBL"},
    )
    client = TestClient(app)

    response = client.post(
        "/mcp/renderer-audit",
        json={
            "action_id": action_id,
            "tool_name": "open_tab",
            "actor_kind": "renderer",
            "actor_identity": "agent-1",
            "actor_scope": ["*"],
            "side_effects": ["ui-bound"],
            "capability_check": {
                "required": ["modify-tabs"],
                "satisfied": True,
                "reason": "granted",
            },
            "status": "accepted",
        },
        headers=auth_headers(),
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "BAD_INPUT"
    assert store.get_audit_records_for_action(action_id) == []


def test_renderer_audit_endpoint_rejects_success_status_with_unsatisfied_capability(
    tmp_path, monkeypatch
):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", "renderer-secret")
    store.ensure_agent_identity("agent-1", scope=["modify-tabs"])
    action_id = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="open_tab",
        parameters={"type": "structure", "entityId": "structure:1RBL", "label": "1RBL"},
    )
    client = TestClient(app)

    response = client.post(
        "/mcp/renderer-audit",
        json={
            "action_id": action_id,
            "tool_name": "open_tab",
            "actor_kind": "renderer",
            "actor_identity": "agent-1",
            "actor_scope": ["modify-tabs"],
            "side_effects": ["ui-bound"],
            "capability_check": {
                "required": ["modify-tabs"],
                "satisfied": False,
                "reason": "insufficient_scope",
            },
            "status": "completed",
        },
        headers=auth_headers(),
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "BAD_INPUT"
    assert store.get_audit_records_for_action(action_id) == []


def test_renderer_audit_endpoint_rejects_unauthorized_sidecar_action(
    tmp_path, monkeypatch
):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", "renderer-secret")
    store.ensure_agent_identity("agent-1", scope=["modify-tabs"])
    action_id = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="open_tab",
        parameters={"type": "structure", "entityId": "structure:1RBL", "label": "1RBL"},
        authorization_state="denied",
    )
    client = TestClient(app)

    response = client.post(
        "/mcp/renderer-audit",
        json={
            "action_id": action_id,
            "tool_name": "open_tab",
            "actor_kind": "renderer",
            "actor_identity": "agent-1",
            "actor_scope": ["modify-tabs"],
            "side_effects": ["ui-bound"],
            "capability_check": {
                "required": ["modify-tabs"],
                "satisfied": True,
                "reason": "granted",
            },
            "status": "accepted",
        },
        headers=auth_headers(),
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "BAD_INPUT"
    assert store.get_audit_records_for_action(action_id) == []


def test_renderer_audit_endpoint_rejects_mismatched_actor_identity(
    tmp_path, monkeypatch
):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", "renderer-secret")
    store.ensure_agent_identity("agent-1", scope=["read-workspace"])
    store.ensure_agent_identity("agent-2", scope=["read-workspace"])
    action_id = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="get_workspace",
        parameters={},
    )
    client = TestClient(app)

    response = client.post(
        "/mcp/renderer-audit",
        json={
            "action_id": action_id,
            "tool_name": "get_workspace",
            "actor_kind": "renderer",
            "actor_identity": "agent-2",
            "actor_scope": ["read-workspace"],
            "side_effects": ["read-only"],
            "capability_check": {
                "required": ["read-workspace"],
                "satisfied": True,
                "reason": "granted",
            },
            "status": "completed",
        },
        headers=auth_headers(),
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "BAD_INPUT"
    assert store.get_audit_records_for_action(action_id) == []


def test_renderer_audit_endpoint_rejects_bad_session(tmp_path, monkeypatch):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", "renderer-secret")
    client = TestClient(app)

    response = client.post(
        "/mcp/renderer-audit",
        json={},
        headers={"X-DNAForge-Session": "wrong"},
    )

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "BAD_SESSION"


def test_renderer_audit_endpoint_does_not_reuse_bridge_callback_token(
    tmp_path, monkeypatch
):
    initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.delenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", raising=False)
    client = TestClient(app)

    response = client.post(
        "/mcp/renderer-audit",
        json={},
        headers=auth_headers(),
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "BAD_INPUT"


@pytest.mark.asyncio
async def test_renderer_bridge_rejects_malformed_success_response(monkeypatch):
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_URL", "http://127.0.0.1:7777")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", "renderer-secret")

    async def fake_post(_url, json, headers):  # noqa: ANN001
        return httpx.Response(200, json={"ok": True, "result": {}})

    with pytest.raises(RuntimeError, match="outcome is unresolved"):
        await call_renderer_bridge(
            "get_workspace",
            {},
            ToolContext(
                job_id="action-1",
                agent_identity_id="agent-1",
                agent_capabilities=["read-workspace"],
                cancel_event=asyncio.Event(),
            ),
            post=fake_post,
        )


@pytest.mark.asyncio
async def test_renderer_bridge_forwards_persisted_workspace_binding(
    tmp_path, monkeypatch
):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    store.create_agent_identity(
        identity_id="agent_stdio_external",
        scope=["read-workspace"],
        label="External MCP client",
        kind="stdio-mcp",
        origin="local-mcp",
    )
    assert store.bind_local_mcp_workspace(
        "agent_stdio_external",
        workspace_id='folders:["/lab"]',
        workspace_label="/lab",
    )
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_URL", "http://127.0.0.1:7777")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", "renderer-secret")

    async def fake_post(_url, json, headers):  # noqa: ANN001
        assert headers["X-DNAForge-Bound-Workspace"] == 'folders:["/lab"]'
        return httpx.Response(
            200,
            json={"ok": True, "result": {"folders": []}, "audit_id": "audit-1"},
        )

    response = await call_renderer_bridge(
        "get_workspace",
        {},
        ToolContext(
            job_id="action-1",
            agent_identity_id="agent_stdio_external",
            agent_capabilities=["read-workspace"],
            cancel_event=asyncio.Event(),
        ),
        post=fake_post,
    )

    assert response["result"] == {"folders": []}


@pytest.mark.asyncio
async def test_renderer_bridge_rejects_malformed_error_response(monkeypatch):
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_URL", "http://127.0.0.1:7777")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", "renderer-secret")

    async def fake_post(_url, json, headers):  # noqa: ANN001
        return httpx.Response(500, json={"ok": False, "error": {"code": "BROKEN"}})

    with pytest.raises(RuntimeError, match="outcome is unresolved"):
        await call_renderer_bridge(
            "get_workspace",
            {},
            ToolContext(
                job_id="action-1",
                agent_identity_id="agent-1",
                agent_capabilities=["read-workspace"],
                cancel_event=asyncio.Event(),
            ),
            post=fake_post,
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("first_response", ["pending", "timeout"])
async def test_renderer_deadline_recovers_same_action_without_redispatch(
    monkeypatch, first_response
):
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_URL", "http://127.0.0.1:7777")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", "renderer-secret")
    urls = []

    async def post(url, json, headers):
        urls.append(url)
        assert headers["X-DNAForge-Action-Id"] == "original-action"
        if len(urls) == 1:
            if first_response == "timeout":
                raise httpx.ReadTimeout("caller stopped waiting")
            return httpx.Response(
                200,
                json={
                    "ok": False,
                    "error": {
                        "code": "OPERATION_PENDING",
                        "message": "Still owned",
                        "retriable": False,
                    },
                },
            )
        return httpx.Response(
            200, json={"ok": True, "result": {"saved": True}, "audit_id": "final-audit"}
        )

    result = await call_renderer_bridge(
        "create_design",
        {},
        ToolContext(
            job_id="original-action",
            agent_identity_id="agent-1",
            agent_capabilities=["create-entity"],
            cancel_event=None,
        ),
        post=post,
    )
    assert result["result"] == {"saved": True}
    assert urls == [
        "http://127.0.0.1:7777/__tools/call",
        "http://127.0.0.1:7777/__tools/result",
    ]


def test_terminal_renderer_audit_reconciles_unresolved_action_and_survives_restart(
    tmp_path, monkeypatch
):
    from src.concurrency.job_manager import get_job_manager

    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", "renderer-secret")
    store.ensure_agent_identity("agent-1", scope=["modify-tabs"])
    action_id = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="open_tab",
        parameters={},
        authorized_scope=["modify-tabs"],
        job_pool="cpu-fast",
        job_cancelable=False,
    )
    store.complete_agent_action(
        action_id, error={"code": "OUTCOME_UNRESOLVED", "retriable": False}
    )
    client = TestClient(app)
    body = {
        "action_id": action_id,
        "tool_name": "open_tab",
        "actor_kind": "renderer",
        "actor_identity": "agent-1",
        "actor_scope": ["modify-tabs"],
        "side_effects": ["ui-bound"],
        "capability_check": {
            "required": ["modify-tabs"],
            "satisfied": True,
            "reason": "granted",
        },
    }
    assert (
        client.post(
            "/mcp/renderer-audit",
            headers=auth_headers(),
            json={**body, "status": "accepted"},
        ).status_code
        == 200
    )
    response = client.post(
        "/mcp/renderer-audit",
        headers=auth_headers(),
        json={
            **body,
            "status": "completed",
            "outcome": {"ok": True, "result": {"tabId": "real-tab"}},
        },
    )
    assert response.status_code == 200
    action = store.get_agent_action(action_id)
    assert action["error_json"] is None
    assert action["result_json"] == {
        "ok": True,
        "result": {"tabId": "real-tab"},
        "audit_id": response.json()["audit_id"],
    }
    terminal_audit = store.get_audit_records_for_action(action_id)[-1]
    assert terminal_audit["after_state_json"]["outcome"] == {
        "ok": True,
        "action_id": action_id,
    }
    reset_job_manager()
    assert get_job_manager().snapshot(action_id)["status"] == "completed"


@pytest.mark.asyncio
async def test_sidecar_restart_retains_uncertain_write_identity(tmp_path):
    from src.concurrency.job_manager import JobManager
    from src.concurrency.renderer_bridge import _renderer_tool_spec

    store = initialize_control_plane(tmp_path / "control.sqlite3")
    manager = JobManager()
    spec = _renderer_tool_spec(
        next(tool for tool in RENDERER_TOOL_SPECS if tool["name"] == "create_design")
    )
    started = asyncio.Event()
    release = asyncio.Event()
    writes = []

    async def handler(args, context):
        started.set()
        await release.wait()
        writes.append(context.job_id)
        return {
            "ok": True,
            "result": {
                "ok": True,
                "designId": "test-design",
                "destinationProject": None,
                "name": "Example",
                "assemblyMethod": "gibson",
                "goldenGateEnzyme": None,
                "opened": False,
                "tabId": None,
                "resourceUri": "waypoint://design/test-design",
                "artifact": {
                    "type": "design",
                    "designId": "test-design",
                    "name": "Example",
                    "resourceUri": "waypoint://design/test-design",
                    "openAction": {
                        "tool": "open_tab",
                        "type": "design",
                        "entityId": "test-design",
                        "label": "Example",
                    },
                },
                "mutation": {
                    "operationId": context.job_id,
                    "toolName": "create_design",
                    "effect": "created_design",
                    "target": {"type": "design", "id": "test-design"},
                    "resourceUri": "waypoint://design/test-design",
                    "beforeVersion": None,
                    "afterVersion": 1,
                    "changed": True,
                },
            },
            "audit_id": "audit-1",
        }

    submission = asyncio.create_task(
        manager.submit(
            spec=spec,
            args={},
            handler=handler,
            agent_identity_id="agent-1",
            idempotency_key="original-key",
        )
    )
    await started.wait()
    restarted = JobManager()
    try:
        recovered = await asyncio.wait_for(
            restarted.submit(
                spec=spec,
                args={},
                handler=handler,
                agent_identity_id="agent-1",
                idempotency_key="original-key",
            ),
            timeout=0.2,
        )
        snapshot = restarted.snapshot(recovered.id)
        assert snapshot["error"]["code"] == "OUTCOME_UNRESOLVED"
        assert snapshot["error"]["retriable"] is False
        assert store.get_agent_action(recovered.id)["idempotency_key_hash"]
    finally:
        release.set()
        await submission
    assert len(writes) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("home", ["renderer", "native"])
async def test_abandoned_external_submit_does_not_cancel_execution(tmp_path, home):
    from src.concurrency.job_manager import JobManager
    from src.concurrency.renderer_bridge import _renderer_tool_spec

    initialize_control_plane(tmp_path / "control.sqlite3")
    manager = JobManager()
    spec = _renderer_tool_spec(
        next(tool for tool in RENDERER_TOOL_SPECS if tool["name"] == "create_design")
    ).model_copy(update={"home": home})
    started = asyncio.Event()
    release = asyncio.Event()
    action_ids = []

    async def handler(args, context):
        action_ids.append(context.job_id)
        started.set()
        await release.wait()
        return {
            "ok": True,
            "result": {
                "ok": True,
                "designId": "test-design",
                "destinationProject": None,
                "name": "Example",
                "assemblyMethod": "gibson",
                "goldenGateEnzyme": None,
                "opened": False,
                "tabId": None,
                "resourceUri": "waypoint://design/test-design",
                "artifact": {
                    "type": "design",
                    "designId": "test-design",
                    "name": "Example",
                    "resourceUri": "waypoint://design/test-design",
                    "openAction": {
                        "tool": "open_tab",
                        "type": "design",
                        "entityId": "test-design",
                        "label": "Example",
                    },
                },
                "mutation": {
                    "operationId": context.job_id,
                    "toolName": "create_design",
                    "effect": "created_design",
                    "target": {"type": "design", "id": "test-design"},
                    "resourceUri": "waypoint://design/test-design",
                    "beforeVersion": None,
                    "afterVersion": 1,
                    "changed": True,
                },
            },
            "audit_id": "audit-1",
        }

    submission = asyncio.create_task(
        manager.submit(spec=spec, args={}, handler=handler)
    )
    await started.wait()
    submission.cancel()
    with pytest.raises(asyncio.CancelledError):
        await submission
    assert manager.snapshot(action_ids[0])["status"] == "running"
    owner = manager.get(action_ids[0]).task
    release.set()
    await owner
    assert manager.snapshot(action_ids[0])["status"] == "completed"


def test_renderer_preparation_does_not_complete_service_owned_search(
    tmp_path, monkeypatch
):
    store = initialize_control_plane(tmp_path / "control.sqlite3")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", "renderer-secret")
    capabilities = [
        "operations.start",
        "operations.read",
        "read-workspace",
        "read-sequences",
    ]
    store.ensure_agent_identity("agent-1", scope=capabilities)
    action_id = store.insert_agent_action(
        agent_identity_id="agent-1",
        tool_name="search_primer_matches",
        parameters={},
        authorized_scope=capabilities,
        job_pool="cpu-fast",
        job_cancelable=False,
    )
    client = TestClient(app)
    body = {
        "action_id": action_id,
        "tool_name": "search_primer_matches",
        "actor_kind": "renderer",
        "actor_identity": "agent-1",
        "actor_scope": capabilities,
        "side_effects": ["mutating"],
        "capability_check": {
            "required": capabilities,
            "satisfied": True,
            "reason": "granted",
        },
    }
    assert (
        client.post(
            "/mcp/renderer-audit",
            headers=auth_headers(),
            json={**body, "status": "accepted"},
        ).status_code
        == 200
    )
    response = client.post(
        "/mcp/renderer-audit",
        headers=auth_headers(),
        json={
            **body,
            "status": "completed",
            "outcome": {"ok": True, "result": {"ok": True, "targets": []}},
        },
    )
    assert response.status_code == 200
    action = store.get_agent_action(action_id)
    assert action["completed_at"] is None
    assert action["result_json"] is None
    assert [
        record["after_state_json"]["status"]
        for record in store.get_audit_records_for_action(action_id)
    ] == ["accepted", "completed"]
