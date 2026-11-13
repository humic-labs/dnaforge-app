from __future__ import annotations

import asyncio
from types import SimpleNamespace

import httpx
import pytest

from src.concurrency.renderer_bridge import (
    _persisted_renderer_outcome,
    call_renderer_bridge,
    register_renderer_agent_tools,
)
from src.concurrency.tool_registry import ToolContext, agent_tool_registry
from src.managed_annotation_agent_tools import (
    managed_operation_audit_result,
    register_managed_annotation_agent_tools,
)
from src.managed_annotation_document_tools import (
    register_managed_annotation_document_tools,
)
from src.managed_msa_agent_tool import register_managed_msa_agent_tool
from src.managed_primer_match_agent_tool import register_managed_primer_match_agent_tool
from src.managed_sequence_analysis_agent_tools import (
    register_sequence_analysis_agent_tools,
)
from src.native_file_document_tools import register_native_file_document_tool
from src.native_workflow_tools import register_native_workflow_tools


def _context() -> ToolContext:
    return ToolContext(
        job_id="action-1",
        agent_identity_id="agent-1",
        agent_capabilities=[
            "operations.read",
            "read-workspace",
            "read-sequences",
            "write-workspace",
        ],
        cancel_event=asyncio.Event(),
    )


def test_sidecar_orchestrated_manifest_entries_fail_closed_without_handlers():
    agent_tool_registry.clear()
    try:
        with pytest.raises(RuntimeError, match="has no sidecar handler"):
            register_renderer_agent_tools()
    finally:
        agent_tool_registry.clear()


def test_sidecar_orchestrated_aliases_keep_sidecar_handlers_and_result_projection():
    agent_tool_registry.clear()
    try:
        register_managed_annotation_agent_tools()
        register_managed_annotation_document_tools()
        register_managed_msa_agent_tool()
        register_managed_primer_match_agent_tool()
        register_sequence_analysis_agent_tools()
        register_native_file_document_tool()
        register_native_workflow_tools()
        canonical = agent_tool_registry.require("operations.annotation.apply")
        register_renderer_agent_tools()
        alias = agent_tool_registry.require("operations_annotation_apply")

        assert alias.handler is canonical.handler
        assert alias.replay_policy == canonical.replay_policy
        assert alias.audit_result_projector is managed_operation_audit_result
        assert canonical.audit_result_projector is managed_operation_audit_result
    finally:
        agent_tool_registry.clear()


def test_renderer_recovery_prefers_live_delivery_result_over_projected_sqlite(
    monkeypatch,
):
    retained = {
        "ok": True,
        "result": {
            "operationId": "operation-1",
            "candidates": [{"id": "operation-1:0"}],
        },
        "audit_id": "renderer-audit-1",
    }
    manager = SimpleNamespace(peek_delivery_result=lambda _job_id: retained)
    monkeypatch.setattr("src.concurrency.job_manager.get_job_manager", lambda: manager)
    monkeypatch.setattr(
        "src.concurrency.renderer_bridge.get_control_plane_store",
        lambda: pytest.fail(
            "projected SQLite fallback must not run while live delivery exists"
        ),
    )

    assert _persisted_renderer_outcome(_context()) == retained


@pytest.mark.asyncio
async def test_private_renderer_transport_keeps_trusted_context_outside_public_args(
    monkeypatch,
):
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_URL", "http://127.0.0.1:7777")
    monkeypatch.setenv("DNAFORGE_RENDERER_BRIDGE_TOKEN", "renderer-secret")
    calls: list[dict] = []

    async def post(_url, json, headers):  # noqa: ANN001
        calls.append(json)
        return httpx.Response(
            200,
            json={"ok": True, "result": {"applicable": True}, "audit_id": "audit-1"},
        )

    trusted = {"schema": "dnaforge.managed-annotation-authority.v1"}
    await call_renderer_bridge(
        "operations.annotation.inspect",
        {"operationId": "operation-1", "targetDocumentId": "sequence-1"},
        _context(),
        post=post,
        trusted_context=trusted,
    )
    await call_renderer_bridge("get_workspace", {}, _context(), post=post)

    assert calls[0]["trusted_context"] == trusted
    assert "trusted_context" not in calls[0]["args"]
    assert "trusted_context" not in calls[1]
