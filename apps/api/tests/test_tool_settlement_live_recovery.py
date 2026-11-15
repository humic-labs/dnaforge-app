from __future__ import annotations

import httpx
import pytest

from src.concurrency.job_manager import get_job_manager
from src.concurrency.renderer_bridge import call_renderer_bridge
from src.concurrency.tool_registry import ToolReplayPolicy, agent_tool_registry
from src.control_plane import get_control_plane_store, initialize_control_plane
from tests.test_tool_settlement import audit, dispatch_workspace, workspace_result
from tests.test_tool_settlement import settlement as settlement


@pytest.mark.asyncio
async def test_audited_live_result_recovers_without_reading_projected_sqlite(
    settlement, monkeypatch
):
    path, client = settlement
    registered = agent_tool_registry.require("get_workspace")
    registered.replay_policy = ToolReplayPolicy.EXECUTE
    registered.audit_result_projector = lambda _result: {"workspaceRead": True}
    delivered = {}

    async def handler(args, context):
        async def post(_url, **_kwargs):
            response = audit(client, context, "get_workspace", workspace_result())
            assert response.status_code == 200, response.text
            action = get_control_plane_store().get_agent_action(context.job_id)
            assert action["completion_owner"] == "renderer"
            assert action["completion_state"] == "settled"
            monkeypatch.setattr(
                "src.concurrency.renderer_bridge.get_control_plane_store",
                lambda: pytest.fail("Live delivery must not depend on SQLite fallback"),
            )
            raise httpx.ReadTimeout("Renderer committed; response lost")

        result = await call_renderer_bridge("get_workspace", args, context, post=post)
        delivered.update(result)
        return result

    job = await dispatch_workspace(handler)
    assert delivered["result"] == workspace_result()["result"]
    assert isinstance(delivered["audit_id"], str)
    snapshot = get_job_manager().snapshot(job.id)
    assert snapshot["status"] == "completed"
    assert snapshot["result"] == delivered
    persisted = get_control_plane_store().get_agent_action(job.id)
    assert get_job_manager().snapshot(job.id)["resultProjection"] == {"workspaceRead": True}
    assert initialize_control_plane(path).get_agent_action(job.id) == persisted
