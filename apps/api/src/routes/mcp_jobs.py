"""Authenticated, identity-owned MCP job status and cancellation routes."""

from __future__ import annotations

from fastapi import APIRouter, Header, Response
from starlette.responses import JSONResponse

from ..concurrency.job_manager import JobRecord, get_job_manager
from .mcp_auth import error_response, resolve_authenticated_agent_context

router = APIRouter(prefix="/mcp/jobs", tags=["MCP"])


@router.get("/{job_id}")
async def get_mcp_job(
    job_id: str,
    agent_identity_id: str = Header(
        default="local-agent", alias="X-DNAForge-Agent-Identity"
    ),
    agent_capabilities: str | None = Header(
        default=None, alias="X-DNAForge-Agent-Capabilities"
    ),
    session_token: str | None = Header(default=None, alias="X-DNAForge-Session"),
    api_key: str | None = Header(default=None, alias="X-DNAForge-API-Key"),
):
    agent_context, auth_error = resolve_authenticated_agent_context(
        session_token=session_token,
        api_key=api_key,
        agent_identity_id=agent_identity_id,
        raw_capabilities=agent_capabilities,
        require_persistent_grant=True,
    )
    if auth_error is not None:
        return JSONResponse(status_code=401, content=auth_error)
    assert agent_context is not None

    job = _owned_job(job_id, agent_context["agent_identity_id"])
    if job is None:
        return _unknown_job_response(job_id)
    snapshot = get_job_manager().snapshot(job_id) or job.snapshot()
    return {"ok": True, **snapshot}


@router.delete("/{job_id}", status_code=204)
async def cancel_mcp_job(
    job_id: str,
    agent_identity_id: str = Header(
        default="local-agent", alias="X-DNAForge-Agent-Identity"
    ),
    agent_capabilities: str | None = Header(
        default=None, alias="X-DNAForge-Agent-Capabilities"
    ),
    session_token: str | None = Header(default=None, alias="X-DNAForge-Session"),
    api_key: str | None = Header(default=None, alias="X-DNAForge-API-Key"),
):
    agent_context, auth_error = resolve_authenticated_agent_context(
        session_token=session_token,
        api_key=api_key,
        agent_identity_id=agent_identity_id,
        raw_capabilities=agent_capabilities,
        require_persistent_grant=True,
    )
    if auth_error is not None:
        return JSONResponse(status_code=401, content=auth_error)
    assert agent_context is not None

    job = _owned_job(job_id, agent_context["agent_identity_id"])
    if job is None:
        return _unknown_job_response(job_id)
    if not job.cancelable:
        return JSONResponse(
            status_code=409,
            content=error_response(
                "JOB_NOT_CANCELABLE",
                "This MCP job does not support cancellation.",
                retriable=False,
                details={"job_id": job_id, "tool_name": job.tool_name},
            ),
        )
    await get_job_manager().cancel(job_id)
    return Response(status_code=204)


def _owned_job(job_id: str, agent_identity_id: str) -> JobRecord | None:
    job = get_job_manager().get(job_id)
    if job is None or job.agent_identity_id != agent_identity_id:
        return None
    return job


def _unknown_job_response(job_id: str) -> JSONResponse:
    return JSONResponse(
        status_code=404,
        content=error_response(
            "UNKNOWN_JOB",
            "Unknown MCP job.",
            retriable=False,
            details={"job_id": job_id},
        ),
    )
