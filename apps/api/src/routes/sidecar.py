"""Sidecar health and pool-status endpoints."""

from __future__ import annotations

from fastapi import APIRouter

from ..compute_scheduling import scheduling_status
from ..concurrency.job_manager import get_job_manager
from ..concurrency.pools import get_pool_manager
from ..concurrency.tool_registry import agent_tool_registry
from ..control_plane import get_control_plane_store

router = APIRouter(prefix="/sidecar", tags=["Sidecar"])


@router.get("/health")
async def sidecar_health():
    get_control_plane_store()
    return {
        "ok": True,
        "database": "ready",
        "registered_tools": len(agent_tool_registry.list()),
    }


@router.get("/status")
async def sidecar_status():
    return {
        "pools": get_pool_manager().stats(),
        "jobs": get_job_manager().counts(),
        "tools": {"registered": len(agent_tool_registry.list())},
        "scheduling": await scheduling_status(),
    }
