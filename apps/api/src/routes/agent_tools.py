"""Agent-facing tool discovery and execution endpoints."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, HTTPException, Request, Response
from starlette.responses import JSONResponse

from ..concurrency.dispatcher import UnknownToolError, dispatch_tool
from ..concurrency.job_manager import IdempotencyConflict, get_job_manager
from ..concurrency.refusals import QueueRefusal
from ..concurrency.schema import ToolHome, manifest_json_schema, to_mcp_format
from ..concurrency.tool_registry import agent_tool_registry
from ..mcp_discovery import has_required_capabilities, registered_tool_catalog
from .mcp_auth import (
    check_parent_action,
    error_response,
    resolve_authenticated_agent_context,
    write_rejection_audit,
)

router = APIRouter(prefix="/api/tools", tags=["Agent Tools"])


@router.get("")
async def list_agent_tools(
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
    return {
        "tools": [
            {
                "name": registered.spec.name,
                "description": registered.spec.description,
                "spec": registered.spec.model_dump(mode="json"),
                "mcp": to_mcp_format(registered.spec),
            }
            for registered in registered_tool_catalog()
        ]
    }


@router.get("/manifest-schema")
async def get_manifest_schema():
    return manifest_json_schema()


@router.get("/{name}")
async def get_agent_tool(
    name: str,
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

    registered = agent_tool_registry.get(name)
    if registered is None:
        raise HTTPException(status_code=404, detail=f"Unknown tool: {name}")
    return {
        "spec": registered.spec.model_dump(mode="json"),
        "mcp": to_mcp_format(registered.spec),
    }


@router.post("/{name}/execute")
async def execute_agent_tool(
    request: Request,
    name: str,
    body: dict[str, Any],
    response: Response,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    agent_identity_id: str = Header(
        default="local-agent", alias="X-DNAForge-Agent-Identity"
    ),
    agent_capabilities: str | None = Header(
        default=None, alias="X-DNAForge-Agent-Capabilities"
    ),
    session_token: str | None = Header(default=None, alias="X-DNAForge-Session"),
    api_key: str | None = Header(default=None, alias="X-DNAForge-API-Key"),
    turn_id: str | None = Header(default=None, alias="X-DNAForge-Turn-Id"),
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

    args = body.get("args", body)
    if not isinstance(args, dict):
        return JSONResponse(
            status_code=400,
            content=error_response(
                "BAD_INPUT",
                "Agent tool execution args must be a JSON object.",
                retriable=False,
            ),
        )

    registered = agent_tool_registry.get(name)
    if registered is None or registered.handler is None:
        raise HTTPException(status_code=404, detail=f"Unknown tool: {name}")

    agent_identity_id = agent_context["agent_identity_id"]
    caller_scope = agent_context["effective_capabilities"]
    required = registered.spec.required_capabilities
    parent_action_id = body.get("parent_action_id")
    if parent_action_id is not None and not isinstance(parent_action_id, str):
        parent_action_id = None
    parent_action_error = check_parent_action(parent_action_id)
    if parent_action_error is not None:
        return JSONResponse(status_code=400, content=parent_action_error)
    if (
        registered.spec.home != ToolHome.RENDERER.value
        and not has_required_capabilities(caller_scope, required)
    ):
        action_id, audit_id = write_rejection_audit(
            agent_identity_id=agent_identity_id,
            tool_name=name,
            args=registered.audit_parameters(args),
            actor_scope=caller_scope,
            required_capabilities=required,
            parent_action_id=parent_action_id,
        )
        return JSONResponse(
            status_code=403,
            content=error_response(
                "INSUFFICIENT_SCOPE",
                "Agent identity does not have the capabilities required for this tool.",
                retriable=False,
                details={
                    "required": required,
                    "provided": caller_scope,
                    "requested": agent_context["requested_capabilities"],
                    "action_id": action_id,
                    "audit_id": audit_id,
                },
            ),
        )

    try:
        job = await dispatch_tool(
            name,
            args,
            agent_identity_id=agent_identity_id,
            agent_capabilities=caller_scope,
            idempotency_key=idempotency_key,
            parent_action_id=parent_action_id,
            turn_id=turn_id,
            native_document_authority=getattr(
                request.app.state, "native_document_authority", None
            ),
            managed_operations=getattr(
                request.app.state,
                "managed_operations",
                getattr(request.app.state, "managed_annotation_operations", None),
            ),
        )
    except UnknownToolError:
        raise HTTPException(status_code=404, detail=f"Unknown tool: {name}") from None
    except IdempotencyConflict as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "error": "idempotency_key_collision",
                "key": exc.key,
            },
        ) from exc
    except QueueRefusal as exc:
        response.headers["Retry-After"] = str(exc.retry_after_seconds)
        raise HTTPException(status_code=503, detail=exc.to_response()) from exc

    if job.status in ("queued", "running"):
        response.status_code = 202
    return get_job_manager().snapshot(job.id) or job.snapshot()
