from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from src.concurrency import register_builtin_agent_tools
from src.concurrency.dispatcher import dispatch_tool
from src.concurrency.job_manager import get_job_manager, reset_job_manager
from src.concurrency.renderer_bridge import call_renderer_bridge, load_renderer_tool_manifest
from src.concurrency.tool_errors import ToolExecutionFailure
from src.concurrency.tool_registry import ToolReplayPolicy, agent_tool_registry
from src.control_plane import get_control_plane_store, initialize_control_plane
from src.main import app
from src.routes.mcp_auth import MCP_GRANT_IDENTITY_ENV


@pytest.fixture
def settlement(tmp_path, monkeypatch):
    path = tmp_path / "settlement.sqlite3"
    initialize_control_plane(path)
    reset_job_manager()
    agent_tool_registry.clear()
    register_builtin_agent_tools()
    monkeypatch.setenv("DNAFORGE_MCP_SESSION_TOKEN", "settlement-session")
    monkeypatch.setenv(MCP_GRANT_IDENTITY_ENV, "settlement-agent")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", "settlement-renderer")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_URL", "http://renderer.invalid")
    client = TestClient(app, headers={"X-DNAForge-Session": "settlement-session"})
    yield path, client
    client.close()
    reset_job_manager()
    get_control_plane_store().close()


def audit(client, context, tool_name, outcome=None):
    tool = next(t for t in load_renderer_tool_manifest()["tools"] if t["name"] == tool_name)
    body = {
        "action_id": context.job_id,
        "tool_name": tool_name,
        "actor_kind": "renderer",
        "actor_identity": context.agent_identity_id,
        "actor_scope": context.agent_capabilities,
        "side_effects": tool["effects"],
        "capability_check": {
            "required": tool["required_capabilities"],
            "satisfied": True,
            "reason": "granted",
        },
        "status": "accepted" if outcome is None else "completed",
    }
    if outcome is not None:
        body["outcome"] = outcome
    return client.post("/mcp/renderer-audit", json=body)


def workspace_result():
    return {
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
    }


async def dispatch_workspace(handler):
    agent_tool_registry.require("get_workspace").handler = handler
    return await dispatch_tool(
        "get_workspace",
        {},
        agent_identity_id="settlement-agent",
        agent_capabilities=["read-workspace"],
        idempotency_key="workspace-read",
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("projected", [False, True])
async def test_renderer_success_survives_late_transport_failure(settlement, projected):
    path, client = settlement
    registered = agent_tool_registry.require("get_workspace")
    if projected:
        registered.replay_policy = ToolReplayPolicy.EXECUTE
        registered.audit_result_projector = lambda result: {"workspaceRead": True}
    committed = {}

    async def handler(args, context):
        response = audit(client, context, "get_workspace", workspace_result())
        assert response.status_code == 200, response.text
        committed.update(get_control_plane_store().get_agent_action(context.job_id))
        raise ToolExecutionFailure(
            code="LATE_TRANSPORT_ERROR",
            message="Response lost",
            retriable=False,
            details={"renderer_audit_id": "untrusted-late-writer"},
        )

    job = await dispatch_workspace(handler)
    assert get_job_manager().snapshot(job.id)["status"] == "completed"
    assert get_control_plane_store().get_agent_action(job.id) == committed
    reopened = initialize_control_plane(path)
    assert reopened.get_agent_action(job.id) == committed
    reset_job_manager()
    snapshot = get_job_manager().snapshot(job.id)
    assert snapshot["status"] == "completed"
    assert ("resultProjection" in snapshot) is projected


@pytest.mark.asyncio
async def test_bridge_recovers_committed_result_after_lost_response(settlement):
    path, client = settlement
    attempts = []

    async def handler(args, context):
        async def post(url, **kwargs):
            attempts.append(url)
            response = audit(client, context, "get_workspace", workspace_result())
            assert response.status_code == 200, response.text
            raise httpx.ReadTimeout("Renderer committed; response was lost")

        return await call_renderer_bridge("get_workspace", args, context, post=post)

    job = await dispatch_workspace(handler)
    result = get_job_manager().snapshot(job.id)
    assert result["status"] == "completed"
    assert result["result"]["result"] == workspace_result()["result"]
    assert attempts == ["http://renderer.invalid/__tools/call"]
    before = get_control_plane_store().get_agent_action(job.id)
    assert initialize_control_plane(path).get_agent_action(job.id) == before


@pytest.mark.asyncio
async def test_duplicate_and_conflicting_completion_preserve_first_outcome(settlement):
    path, client = settlement
    captured = {}

    async def handler(args, context):
        first = audit(client, context, "get_workspace", workspace_result())
        assert first.status_code == 200, first.text
        captured.update(context=context, audit_id=first.json()["audit_id"])
        return {**workspace_result(), "audit_id": captured["audit_id"]}

    job = await dispatch_workspace(handler)
    store = get_control_plane_store()
    before = store.get_agent_action(job.id)
    audits_before = store.get_audit_records_for_action(job.id)
    duplicate = audit(client, captured["context"], "get_workspace", workspace_result())
    assert duplicate.status_code == 200, duplicate.text
    assert duplicate.json()["audit_id"] == captured["audit_id"]
    conflict = audit(
        client, captured["context"], "get_workspace", {"ok": True, "result": {"different": True}}
    )
    assert conflict.status_code == 409, conflict.text
    store.complete_agent_action(job.id, error={"code": "WRONG_OWNER", "message": "late"})
    assert store.get_agent_action(job.id) == before
    assert store.get_audit_records_for_action(job.id) == audits_before
    assert initialize_control_plane(path).get_agent_action(job.id) == before


@pytest.mark.asyncio
async def test_managed_preparation_waits_for_job_owner(settlement):
    _, client = settlement
    registered = agent_tool_registry.require("search_primer_matches")

    async def handler(args, context):
        assert audit(client, context, "search_primer_matches").status_code == 200
        response = audit(
            client,
            context,
            "search_primer_matches",
            {"ok": True, "result": {"ok": True, "targets": []}},
        )
        assert response.status_code == 200, response.text
        action = get_control_plane_store().get_agent_action(context.job_id)
        assert action["completed_at"] is None
        assert action["result_json"] is None
        raise ToolExecutionFailure(
            code="MANAGED_ADMISSION_FAILED", message="No targets", retriable=False
        )

    registered.handler = handler
    job = await dispatch_tool(
        "search_primer_matches",
        {"primerIds": ["primer"], "targetDocumentIds": ["target"]},
        agent_identity_id="settlement-agent",
        agent_capabilities=registered.spec.required_capabilities,
    )
    snapshot = get_job_manager().snapshot(job.id)
    assert snapshot["status"] == "failed"
    assert snapshot["error"]["code"] == "MANAGED_ADMISSION_FAILED"
    assert "result" not in snapshot
