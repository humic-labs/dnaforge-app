"""Toolbox endpoints — status, retry, and plugin health checking."""

import httpx
from fastapi import APIRouter, HTTPException, Request

from ..annotation.tools import get_tool_progress, is_downloading_tools
from ..models.toolbox import (
    ToolboxHealthResponse,
    ToolboxRetryResponse,
    ToolboxStatusResponse,
)
from ..security.operation_authority import require_human_operation_authority
from ..toolbox.annotation import sync_annotation_status
from ..toolbox.registry import toolbox_registry

router = APIRouter(prefix="/toolbox", tags=["Toolbox"])


@router.get(
    "/status", response_model=ToolboxStatusResponse, response_model_exclude_none=True
)
async def toolbox_status():
    """Return status of all registered capabilities.

    Syncs annotation status on each request (lazy, not polled).
    Plugin status is NOT synced here — only via /toolbox/health/{cap_id}.
    """
    sync_annotation_status()
    result = toolbox_registry.to_dict()
    if is_downloading_tools():
        result["downloads"] = get_tool_progress()
    return result


@router.post("/retry/{cap_id}", response_model=ToolboxRetryResponse)
async def toolbox_retry(cap_id: str, request: Request):
    """Retry failed downloads for a capability.

    Currently only supports 'annotation' — the only capability with
    downloadable components. Returns 400 for capabilities without retry.
    """
    cap = toolbox_registry.get_capability(cap_id)
    if cap is None:
        raise HTTPException(status_code=404, detail=f"Unknown capability: {cap_id}")

    if cap_id == "annotation":
        require_human_operation_authority(request)
        coordinator = getattr(request.app.state, "annotation_provisioning", None)
        if coordinator is None:
            raise HTTPException(
                status_code=503,
                detail="Annotation provisioning is unavailable in this runtime",
            )
        operation = await coordinator.retry()
        return {
            "retrying": True,
            "capability": cap_id,
            "operation_id": operation.id,
            "state": operation.state,
        }

    raise HTTPException(
        status_code=400, detail=f"Capability '{cap_id}' does not support retry"
    )


async def check_plugin_health(url: str) -> str:
    """Check if a plugin service is reachable. Returns 'ready' or 'unavailable'."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{url}/health")
            return "ready" if resp.status_code == 200 else "error"
    except (httpx.HTTPError, httpx.InvalidURL):
        return "unavailable"


@router.post("/health/{cap_id}", response_model=ToolboxHealthResponse)
async def toolbox_health_check(cap_id: str):
    """Check health of a plugin capability. Updates registry with result.

    Only works for plugin capabilities. Called lazily: on Toolbox open,
    on first use, or via manual 'Test Connection' button.
    """
    cap = toolbox_registry.get_capability(cap_id)
    if cap is None:
        raise HTTPException(status_code=404, detail=f"Unknown capability: {cap_id}")

    if cap.source != "plugin":
        raise HTTPException(
            status_code=400, detail="Health check only available for plugins"
        )

    url = None
    for comp in cap.components:
        if comp.source == "plugin" and comp.path:
            url = comp.path
            break

    if url is None:
        raise HTTPException(status_code=400, detail="Plugin has no URL configured")

    status = await check_plugin_health(url)

    for comp in cap.components:
        if comp.source == "plugin":
            toolbox_registry.update_component(cap_id, comp.id, status=status)

    return {"capability": cap_id, "status": status, "url": url}
