"""Authenticated projection of the current persistent agent caller."""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field
from starlette.responses import JSONResponse

from .mcp_auth import PersistentAgentAuthResult, resolve_persistent_agent_request

router = APIRouter(prefix="/mcp/caller", tags=["MCP"])


class CurrentAgentCaller(BaseModel):
    agent_identity_id: str = Field(serialization_alias="agentIdentityId")
    effective_capabilities: list[str] = Field(
        serialization_alias="effectiveCapabilities"
    )


class CurrentAgentCallerResponse(BaseModel):
    ok: Literal[True]
    caller: CurrentAgentCaller


@router.get(
    "",
    operation_id="getCurrentAgentCaller",
    response_model=CurrentAgentCallerResponse,
)
async def get_current_agent_caller(
    response: Response,
    auth_result: Annotated[
        PersistentAgentAuthResult,
        Depends(resolve_persistent_agent_request),
    ],
):
    agent_context, auth_error = auth_result
    if auth_error is not None:
        return JSONResponse(
            status_code=401,
            content=auth_error,
            headers={"Cache-Control": "no-store"},
        )
    assert agent_context is not None
    response.headers["Cache-Control"] = "no-store"
    return CurrentAgentCallerResponse(
        ok=True,
        caller=CurrentAgentCaller(
            agent_identity_id=agent_context["agent_identity_id"],
            effective_capabilities=agent_context["effective_capabilities"],
        ),
    )
