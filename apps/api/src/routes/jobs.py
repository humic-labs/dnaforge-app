"""Job status, event, and cancel endpoints for the sidecar substrate."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
from sse_starlette.sse import EventSourceResponse
from starlette.background import BackgroundTask
from starlette.responses import JSONResponse

from ..concurrency.job_manager import (
    JobEventSubscriberLimit,
    JobRecord,
    get_job_manager,
)
from .mcp_auth import (
    PersistentAgentAuthResult,
    error_response,
    resolve_persistent_agent_request,
)

router = APIRouter(prefix="/jobs", tags=["Jobs"])


@router.get("/{job_id}")
async def get_job(
    job_id: str,
    auth_result: Annotated[
        PersistentAgentAuthResult,
        Depends(resolve_persistent_agent_request),
    ],
):
    agent_context, auth_error = auth_result
    if auth_error is not None:
        return JSONResponse(status_code=401, content=auth_error)
    assert agent_context is not None

    job = _owned_job(job_id, agent_context["agent_identity_id"])
    if job is None:
        raise HTTPException(status_code=404, detail=f"Unknown job: {job_id}")
    return get_job_manager().snapshot(job_id) or job.snapshot()


@router.get("/{job_id}/events")
async def get_job_events(
    job_id: str,
    auth_result: Annotated[
        PersistentAgentAuthResult,
        Depends(resolve_persistent_agent_request),
    ],
):
    agent_context, auth_error = auth_result
    if auth_error is not None:
        return JSONResponse(status_code=401, content=auth_error)
    assert agent_context is not None

    job = _owned_job(job_id, agent_context["agent_identity_id"])
    if job is None:
        raise HTTPException(status_code=404, detail=f"Unknown job: {job_id}")

    manager = get_job_manager()
    try:
        subscription = manager.subscribe_events(job_id)
    except JobEventSubscriberLimit as exc:
        return JSONResponse(
            status_code=429,
            headers={"Retry-After": "1"},
            content=error_response(
                "JOB_EVENT_SUBSCRIBER_LIMIT",
                "Too many live event streams for this job or agent identity.",
                retriable=True,
                details={"scope": exc.scope, "limit": exc.limit},
            ),
        )
    if subscription is None:
        raise HTTPException(status_code=404, detail=f"Unknown job: {job_id}")

    async def event_generator():
        try:
            async for event in subscription:
                yield event
        finally:
            subscription.close()

    return EventSourceResponse(
        event_generator(), background=BackgroundTask(subscription.close)
    )


@router.delete("/{job_id}", status_code=204)
async def cancel_job(
    job_id: str,
    auth_result: Annotated[
        PersistentAgentAuthResult,
        Depends(resolve_persistent_agent_request),
    ],
):
    agent_context, auth_error = auth_result
    if auth_error is not None:
        return JSONResponse(status_code=401, content=auth_error)
    assert agent_context is not None

    job = _owned_job(job_id, agent_context["agent_identity_id"])
    if job is None:
        raise HTTPException(status_code=404, detail=f"Unknown job: {job_id}")
    if not job.cancelable:
        return JSONResponse(
            status_code=409,
            content=error_response(
                "JOB_NOT_CANCELABLE",
                "This job does not support cancellation.",
                retriable=False,
                details={"job_id": job_id, "tool_name": job.tool_name},
            ),
        )

    canceled = await get_job_manager().cancel(job_id)
    if not canceled:
        raise HTTPException(status_code=404, detail=f"Unknown job: {job_id}")
    return Response(status_code=204)


def _owned_job(job_id: str, agent_identity_id: str) -> JobRecord | None:
    job = get_job_manager().get(job_id)
    if job is None or job.agent_identity_id != agent_identity_id:
        return None
    return job
