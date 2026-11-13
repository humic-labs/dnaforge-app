"""Phase 1b MCP call surface backed by the universal dispatcher."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Annotated, Any
from urllib.parse import unquote, urlsplit

from fastapi import APIRouter, BackgroundTasks, Depends, Header, Request
from starlette.responses import JSONResponse

from ..agent_analysis_runs import (
    analysis_run_resources_from_rows,
    build_analysis_run_resource,
)
from ..agent_artifacts import artifact_resources_from_rows, build_artifact_resource
from ..agent_resource_links import (
    build_resource_link_resource,
    resource_link_resources_from_rows,
)
from ..agent_status import build_agent_status_resource
from ..agent_workflows import (
    DEFAULT_RUNS_ROOT,
    latest_workflow_run_resource,
    owned_workflow_ledger_filter,
    workflow_contract_resource,
    workflow_manifest_resource,
    workflow_resources_from_manifest,
    workflow_run_summary_resource,
)
from ..concurrency.dispatcher import dispatch_tool
from ..concurrency.job_manager import IdempotencyConflict, get_job_manager
from ..concurrency.refusals import QueueRefusal
from ..concurrency.renderer_bridge import read_renderer_resource
from ..concurrency.schema import ToolHome
from ..concurrency.tool_registry import agent_tool_registry
from ..concurrency.tool_validation import ToolInputValidationError
from ..control_plane import get_control_plane_store
from ..external_access_observation import (
    action_observation,
    emit_external_access_observation,
    observations_enabled,
    transport_refusal_observation,
)
from ..mcp_discovery import has_required_capabilities, registered_tool_catalog
from .mcp_auth import (
    AgentCallerContext,
    PersistentAgentAuthResult,
    check_parent_action,
    error_response,
    resolve_authenticated_agent_context,
    resolve_persistent_agent_request,
    write_rejection_audit,
)

router = APIRouter(prefix="/mcp", tags=["MCP"])
PersistentAgentAuth = Annotated[
    PersistentAgentAuthResult,
    Depends(resolve_persistent_agent_request),
]


@router.post("/call")
async def call_mcp_tool(
    request: Request,
    body: dict[str, Any],
    background_tasks: BackgroundTasks,
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
    prefer: str | None = Header(default=None, alias="Prefer"),
):
    agent_context, auth_error = resolve_authenticated_agent_context(
        session_token=session_token,
        api_key=api_key,
        agent_identity_id=agent_identity_id,
        raw_capabilities=agent_capabilities,
        require_persistent_grant=True,
    )
    if auth_error is not None:
        if observations_enabled() and api_key:
            try:
                receipt = transport_refusal_observation(
                    str((auth_error.get("error") or {}).get("code", ""))
                )
                if receipt is not None:
                    background_tasks.add_task(emit_external_access_observation, receipt)
            except Exception:
                pass
        return JSONResponse(status_code=401, content=auth_error)
    assert agent_context is not None

    parsed = _parse_call_body(body)
    if parsed["error"] is not None:
        return JSONResponse(status_code=400, content=parsed["error"])

    tool_name = parsed["tool_name"]
    args = parsed["args"]
    parent_action_id = parsed["parent_action_id"]
    request_idempotency_key = idempotency_key or parsed["idempotency_key"]

    registered = agent_tool_registry.get(tool_name)
    if registered is None or registered.handler is None:
        return JSONResponse(
            status_code=404,
            content=error_response(
                "UNKNOWN_TOOL",
                f"Unknown tool: {tool_name}",
                retriable=False,
            ),
        )
    parent_action_error = check_parent_action(parent_action_id)
    if parent_action_error is not None:
        return JSONResponse(status_code=400, content=parent_action_error)

    agent_identity_id = agent_context["agent_identity_id"]
    caller_scope = agent_context["effective_capabilities"]
    required = registered.spec.required_capabilities

    if (
        registered.spec.home != ToolHome.RENDERER.value
        and not has_required_capabilities(caller_scope, required)
    ):
        action_id, audit_id = write_rejection_audit(
            agent_identity_id=agent_identity_id,
            tool_name=tool_name,
            args=registered.audit_parameters(args),
            actor_scope=caller_scope,
            required_capabilities=required,
            parent_action_id=parent_action_id,
        )
        if observations_enabled():
            try:
                receipt = action_observation(action_id)
                if receipt is not None:
                    background_tasks.add_task(emit_external_access_observation, receipt)
            except Exception:
                pass
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
            tool_name,
            args,
            agent_identity_id=agent_identity_id,
            agent_capabilities=caller_scope,
            idempotency_key=request_idempotency_key,
            parent_action_id=parent_action_id,
            turn_id=turn_id,
            prefer_async="respond-async" in (prefer or "").lower().split(","),
            native_document_authority=getattr(
                request.app.state, "native_document_authority", None
            ),
            managed_operations=getattr(
                request.app.state,
                "managed_operations",
                getattr(request.app.state, "managed_annotation_operations", None),
            ),
        )
    except ToolInputValidationError as exc:
        return JSONResponse(
            status_code=400,
            content=error_response(
                "INVALID_TOOL_INPUT",
                str(exc),
                retriable=False,
                details={"issues": exc.issues, "stateChanged": False},
            ),
        )
    except IdempotencyConflict as exc:
        return JSONResponse(
            status_code=409,
            content=error_response(
                "IDEMPOTENCY_CONFLICT",
                "Idempotency key was reused with a different request body.",
                retriable=False,
                details={"key": exc.key},
            ),
        )
    except QueueRefusal as exc:
        return JSONResponse(
            status_code=503,
            headers={"Retry-After": str(exc.retry_after_seconds)},
            content=error_response(
                "QUEUE_SATURATED",
                "The selected worker pool is saturated.",
                retriable=True,
                details=exc.to_response(),
            ),
        )

    status_code = 202 if job.status in ("queued", "running") else 200
    ok = job.status not in {"failed", "canceled"}
    snapshot = get_job_manager().snapshot(job.id) or job.snapshot()
    return JSONResponse(status_code=status_code, content={"ok": ok, **snapshot})


@router.post("/resources/read")
async def read_mcp_resource(
    body: dict[str, Any],
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
    """Read an authenticated, capability-scoped MCP resource.

    Persistent control-plane grants are reloaded on every request. Owned
    sidecar resources are resolved locally; design, sequence, and selection
    resources cross the existing renderer bridge. Every successful or denied
    read retains the existing action/audit evidence contract.
    """

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

    uri = body.get("uri")
    if not isinstance(uri, str) or not uri:
        return JSONResponse(
            status_code=400,
            content=error_response(
                "BAD_INPUT",
                "MCP resources/read body must include uri.",
                retriable=False,
            ),
        )

    parsed_resource = _parse_mcp_resource_uri(uri)
    if parsed_resource is None:
        return JSONResponse(
            status_code=400,
            content=error_response(
                "UNSUPPORTED_RESOURCE_URI",
                "The requested waypoint resource URI is not supported.",
                retriable=False,
                details={"uri": uri},
            ),
        )

    resource_kind, resource_id = parsed_resource
    required_capabilities = (
        ["read-sequences"] if resource_kind == "sequence" else ["read-workspace"]
    )
    caller_scope = agent_context["effective_capabilities"]
    if not has_required_capabilities(caller_scope, required_capabilities):
        action_id, audit_id = write_rejection_audit(
            agent_identity_id=agent_context["agent_identity_id"],
            tool_name="resources/read",
            args={"uri": uri},
            actor_scope=caller_scope,
            required_capabilities=required_capabilities,
            parent_action_id=None,
        )
        return JSONResponse(
            status_code=403,
            content=error_response(
                "INSUFFICIENT_SCOPE",
                "The caller does not have the capability required for this resource.",
                retriable=False,
                details={
                    "required": required_capabilities,
                    "provided": caller_scope,
                    "action_id": action_id,
                    "audit_id": audit_id,
                },
            ),
        )

    if resource_kind != "selection":
        return await _read_sidecar_resource(
            uri=uri,
            resource_kind=resource_kind,
            resource_id=resource_id,
            agent_identity_id=agent_context["agent_identity_id"],
            actor_scope=caller_scope,
            required_capabilities=required_capabilities,
            turn_id=turn_id,
        )

    reference_id = resource_id
    try:
        bridge_result = await read_renderer_resource(
            reference_id,
            agent_identity_id=agent_context["agent_identity_id"],
            agent_capabilities=agent_context["effective_capabilities"],
            turn_id=turn_id,
        )
    except RuntimeError as exc:
        action_id, audit_id = _write_resource_read_audit(
            agent_identity_id=agent_context["agent_identity_id"],
            actor_scope=caller_scope,
            uri=uri,
            error={"code": "RENDERER_BRIDGE_UNAVAILABLE", "message": str(exc)},
        )
        return JSONResponse(
            status_code=502,
            content=error_response(
                "RENDERER_BRIDGE_UNAVAILABLE",
                str(exc),
                retriable=True,
                details={"uri": uri, "action_id": action_id, "audit_id": audit_id},
            ),
        )

    payload = bridge_result["payload"]
    if not isinstance(payload, dict) or not isinstance(payload.get("ok"), bool):
        action_id, audit_id = _write_resource_read_audit(
            agent_identity_id=agent_context["agent_identity_id"],
            actor_scope=caller_scope,
            uri=uri,
            error={
                "code": "RENDERER_BRIDGE_ERROR",
                "message": "Renderer bridge returned an invalid resource response.",
            },
        )
        return JSONResponse(
            status_code=502,
            content=error_response(
                "RENDERER_BRIDGE_ERROR",
                "Renderer bridge returned an invalid resource response.",
                retriable=True,
                details={"uri": uri, "action_id": action_id, "audit_id": audit_id},
            ),
        )

    if payload["ok"] is False:
        error = payload.get("error") if isinstance(payload.get("error"), dict) else {}
        code = (
            error.get("code")
            if isinstance(error.get("code"), str) and error.get("code")
            else "RESOURCE_UNAVAILABLE"
        )
        message = (
            error.get("message")
            if isinstance(error.get("message"), str) and error.get("message")
            else "Selection resource is unavailable."
        )
        action_id, audit_id = _write_resource_read_audit(
            agent_identity_id=agent_context["agent_identity_id"],
            actor_scope=caller_scope,
            uri=uri,
            error={"code": code, "message": message},
        )
        not_found = code in {"SELECTION_NOT_FOUND", "SELECTION_NO_DESCRIPTOR"}
        forbidden = code in {
            "BAD_SESSION",
            "INSUFFICIENT_SCOPE",
            "WRONG_WORKSPACE",
            "REFERENCE_UNSCOPED",
            "REFERENCE_SCOPE_MISMATCH",
        }
        return JSONResponse(
            status_code=404 if not_found else 403 if forbidden else 400,
            content=error_response(
                code,
                message,
                retriable=False,
                details={"uri": uri, "action_id": action_id, "audit_id": audit_id},
            ),
        )

    reference = payload.get("reference")
    descriptor = reference.get("data") if isinstance(reference, dict) else None
    resource_envelope = {
        "trust": "untrusted-data",
        "reference": {
            "refId": reference_id,
            "entityType": (
                reference.get("entityType") if isinstance(reference, dict) else None
            ),
            "displayLabel": (
                reference.get("displayLabel") if isinstance(reference, dict) else None
            ),
            "locator": (
                reference.get("locator") if isinstance(reference, dict) else None
            ),
            "measuredBy": "app-computed",
        },
        "descriptor": descriptor,
    }
    action_id, audit_id = _write_resource_read_audit(
        agent_identity_id=agent_context["agent_identity_id"],
        actor_scope=caller_scope,
        uri=uri,
        result={"reference_id": reference_id},
    )
    return {
        "ok": True,
        "action_id": action_id,
        "audit_id": audit_id,
        "contents": [
            {
                "uri": uri,
                "mimeType": "application/json",
                "text": json.dumps(resource_envelope),
            }
        ],
    }


def _write_resource_read_audit(
    *,
    agent_identity_id: str,
    actor_scope: list[str],
    uri: str,
    required_capabilities: list[str] | None = None,
    result: dict[str, Any] | None = None,
    error: dict[str, Any] | None = None,
) -> tuple[str, str]:
    store = get_control_plane_store()
    store.ensure_agent_identity(agent_identity_id, scope=actor_scope)
    action_id = store.insert_agent_action(
        agent_identity_id=agent_identity_id,
        tool_name="resources/read",
        parameters={"uri": uri},
        authorized_scope=actor_scope,
    )
    store.complete_agent_action(action_id, result=result, error=error)
    audit_id = store.insert_audit_record(
        action_id=action_id,
        actor_kind="agent",
        actor_identity=agent_identity_id,
        actor_scope=actor_scope,
        side_effects=[],
        capability_check={
            "required": required_capabilities or ["read-workspace"],
            "satisfied": True,
            "reason": "granted",
        },
        after_state={
            "status": "failed" if error else "completed",
            **({"error": error} if error else {}),
        },
    )
    return action_id, audit_id


async def _read_sidecar_resource(
    *,
    uri: str,
    resource_kind: str,
    resource_id: str,
    agent_identity_id: str,
    actor_scope: list[str],
    required_capabilities: list[str],
    turn_id: str | None,
):
    try:
        resource = await _load_sidecar_resource(
            resource_kind=resource_kind,
            resource_id=resource_id,
            agent_identity_id=agent_identity_id,
            actor_scope=actor_scope,
            turn_id=turn_id,
        )
    except RuntimeError as exc:
        action_id, audit_id = _write_resource_read_audit(
            agent_identity_id=agent_identity_id,
            actor_scope=actor_scope,
            uri=uri,
            required_capabilities=required_capabilities,
            error={"code": "RESOURCE_UNAVAILABLE", "message": str(exc)},
        )
        return JSONResponse(
            status_code=502,
            content=error_response(
                "RESOURCE_UNAVAILABLE",
                str(exc),
                retriable=True,
                details={"uri": uri, "action_id": action_id, "audit_id": audit_id},
            ),
        )

    if resource is None:
        action_id, audit_id = _write_resource_read_audit(
            agent_identity_id=agent_identity_id,
            actor_scope=actor_scope,
            uri=uri,
            required_capabilities=required_capabilities,
            error={"code": "UNKNOWN_RESOURCE", "message": "Unknown MCP resource."},
        )
        return JSONResponse(
            status_code=404,
            content=error_response(
                "UNKNOWN_RESOURCE",
                "Unknown MCP resource.",
                retriable=False,
                details={"uri": uri, "action_id": action_id, "audit_id": audit_id},
            ),
        )

    action_id, audit_id = _write_resource_read_audit(
        agent_identity_id=agent_identity_id,
        actor_scope=actor_scope,
        uri=uri,
        required_capabilities=required_capabilities,
        result={"resource_uri": uri},
    )
    return {
        "ok": True,
        "action_id": action_id,
        "audit_id": audit_id,
        "contents": [
            {
                "uri": uri,
                "mimeType": "application/json",
                "text": json.dumps(resource, sort_keys=True),
            }
        ],
    }


async def _load_sidecar_resource(
    *,
    resource_kind: str,
    resource_id: str,
    agent_identity_id: str,
    actor_scope: list[str],
    turn_id: str | None,
) -> dict[str, Any] | None:
    store = get_control_plane_store()
    if resource_kind == "action":
        action = store.get_agent_action(resource_id)
        if action is None or action.get("agent_identity_id") != agent_identity_id:
            return None
        audits = store.get_audit_records_for_action(resource_id)
        chain = [
            row
            for row in store.trace_action_chain(resource_id)
            if row.get("agent_identity_id") == agent_identity_id
        ]
        return build_action_resource(action, audits, chain)
    if resource_kind == "artifact":
        artifact = store.get_agent_artifact(resource_id)
        if artifact is None or artifact.get("agent_identity_id") != agent_identity_id:
            return None
        return build_artifact_resource(artifact)
    if resource_kind == "analysis-run":
        analysis_run = store.get_agent_analysis_run(resource_id)
        if (
            analysis_run is None
            or analysis_run.get("agent_identity_id") != agent_identity_id
        ):
            return None
        return build_analysis_run_resource(analysis_run)
    if resource_kind == "resource-link":
        resource_link = store.get_agent_resource_link(resource_id)
        if (
            resource_link is None
            or resource_link.get("agent_identity_id") != agent_identity_id
        ):
            return None
        return build_resource_link_resource(resource_link)
    if resource_kind == "agent":
        visible_tool_names = [
            registered.spec.name for registered in registered_tool_catalog()
        ]
        return build_agent_status_resource(
            agent_identity_id=agent_identity_id,
            caller_capabilities=actor_scope,
            visible_tool_names=visible_tool_names,
            include_workspace_details=True,
        )
    if resource_kind == "workflow":
        if resource_id == "manifest":
            return workflow_manifest_resource()
        try:
            return workflow_contract_resource(resource_id)
        except RuntimeError:
            return None
    if resource_kind == "workflow-runs":
        ledger_filter = owned_workflow_ledger_filter(agent_identity_id)
        if resource_id == "summary":
            return workflow_run_summary_resource(
                workflow_ledger_root(),
                ledger_filter=ledger_filter,
            )
        if resource_id.startswith("latest/"):
            workflow_id = resource_id.removeprefix("latest/")
            resource = latest_workflow_run_resource(
                workflow_id,
                workflow_ledger_root(),
                ledger_filter=ledger_filter,
            )
            return resource if resource.get("exists") is True else None
        return None
    if resource_kind == "design":
        return await _read_renderer_tool_resource(
            tool_name="get_design",
            arguments={"designId": resource_id},
            agent_identity_id=agent_identity_id,
            actor_scope=actor_scope,
            turn_id=turn_id,
        )
    if resource_kind == "sequence":
        return await _read_renderer_tool_resource(
            tool_name="get_sequence",
            arguments={"documentId": resource_id},
            agent_identity_id=agent_identity_id,
            actor_scope=actor_scope,
            turn_id=turn_id,
        )
    return None


async def _read_renderer_tool_resource(
    *,
    tool_name: str,
    arguments: dict[str, Any],
    agent_identity_id: str,
    actor_scope: list[str],
    turn_id: str | None,
) -> dict[str, Any]:
    registered = agent_tool_registry.get(tool_name)
    if registered is None or registered.handler is None:
        raise RuntimeError(
            f"DNAForge renderer resource tool is unavailable: {tool_name}"
        )
    if not has_required_capabilities(
        actor_scope,
        registered.spec.required_capabilities,
    ):
        raise RuntimeError(f"DNAForge renderer resource scope is invalid: {tool_name}")

    job = await dispatch_tool(
        tool_name,
        arguments,
        agent_identity_id=agent_identity_id,
        agent_capabilities=actor_scope,
        turn_id=turn_id,
    )
    if job.task is not None:
        await job.task
    snapshot = get_job_manager().snapshot(job.id) or job.snapshot()
    if snapshot.get("status") != "completed":
        error = snapshot.get("error")
        message = (
            error.get("message")
            if isinstance(error, dict) and isinstance(error.get("message"), str)
            else f"DNAForge renderer resource tool failed: {tool_name}"
        )
        raise RuntimeError(message)
    result = snapshot.get("result")
    content = result.get("result") if isinstance(result, dict) else None
    if not isinstance(content, dict):
        raise RuntimeError(
            f"DNAForge renderer resource tool returned invalid content: {tool_name}"
        )
    return content


def _authorize_legacy_resource_request(
    auth_result: PersistentAgentAuthResult,
) -> tuple[AgentCallerContext | None, JSONResponse | None]:
    """Require a persistent grant and the shared MCP resource read scope."""

    agent_context, auth_error = auth_result
    if auth_error is not None:
        return None, JSONResponse(status_code=401, content=auth_error)
    assert agent_context is not None

    required = ["read-workspace"]
    provided = agent_context["effective_capabilities"]
    if not has_required_capabilities(provided, required):
        return None, JSONResponse(
            status_code=403,
            content=error_response(
                "INSUFFICIENT_SCOPE",
                "The caller does not have the capability required for MCP resources.",
                retriable=False,
                details={"required": required, "provided": provided},
            ),
        )
    return agent_context, None


@router.get("/actions/{action_id}")
async def read_mcp_action_resource(
    action_id: str,
    auth_result: PersistentAgentAuth,
):
    agent_context, auth_response = _authorize_legacy_resource_request(auth_result)
    if auth_response is not None:
        return auth_response
    assert agent_context is not None

    store = get_control_plane_store()
    action = store.get_agent_action(action_id)
    if (
        action is None
        or action.get("agent_identity_id") != agent_context["agent_identity_id"]
    ):
        return JSONResponse(
            status_code=404,
            content=error_response(
                "UNKNOWN_ACTION",
                "Unknown agent action.",
                retriable=False,
                details={"action_id": action_id},
            ),
        )

    audits = store.get_audit_records_for_action(action_id)
    chain = [
        row
        for row in store.trace_action_chain(action_id)
        if row.get("agent_identity_id") == agent_context["agent_identity_id"]
    ]
    return {
        "ok": True,
        "resource": build_action_resource(action, audits, chain),
    }


@router.get("/artifacts")
async def list_mcp_artifact_resources(
    auth_result: PersistentAgentAuth,
):
    agent_context, auth_response = _authorize_legacy_resource_request(auth_result)
    if auth_response is not None:
        return auth_response
    assert agent_context is not None

    artifacts = get_control_plane_store().list_agent_artifacts(
        agent_identity_id=agent_context["agent_identity_id"],
    )
    return {
        "ok": True,
        "resources": artifact_resources_from_rows(artifacts),
    }


@router.get("/artifacts/{artifact_id}")
async def read_mcp_artifact_resource(
    artifact_id: str,
    auth_result: PersistentAgentAuth,
):
    agent_context, auth_response = _authorize_legacy_resource_request(auth_result)
    if auth_response is not None:
        return auth_response
    assert agent_context is not None

    artifact = get_control_plane_store().get_agent_artifact(artifact_id)
    if (
        artifact is None
        or artifact.get("agent_identity_id") != agent_context["agent_identity_id"]
    ):
        return JSONResponse(
            status_code=404,
            content=error_response(
                "UNKNOWN_ARTIFACT",
                "Unknown agent artifact.",
                retriable=False,
                details={"artifact_id": artifact_id},
            ),
        )
    return {"ok": True, "resource": build_artifact_resource(artifact)}


@router.get("/analysis-runs")
async def list_mcp_analysis_run_resources(
    auth_result: PersistentAgentAuth,
):
    agent_context, auth_response = _authorize_legacy_resource_request(auth_result)
    if auth_response is not None:
        return auth_response
    assert agent_context is not None

    analysis_runs = get_control_plane_store().list_agent_analysis_runs(
        agent_identity_id=agent_context["agent_identity_id"],
    )
    return {
        "ok": True,
        "resources": analysis_run_resources_from_rows(analysis_runs),
    }


@router.get("/analysis-runs/{analysis_run_id}")
async def read_mcp_analysis_run_resource(
    analysis_run_id: str,
    auth_result: PersistentAgentAuth,
):
    agent_context, auth_response = _authorize_legacy_resource_request(auth_result)
    if auth_response is not None:
        return auth_response
    assert agent_context is not None

    analysis_run = get_control_plane_store().get_agent_analysis_run(analysis_run_id)
    if (
        analysis_run is None
        or analysis_run.get("agent_identity_id") != agent_context["agent_identity_id"]
    ):
        return JSONResponse(
            status_code=404,
            content=error_response(
                "UNKNOWN_ANALYSIS_RUN",
                "Unknown analysis run.",
                retriable=False,
                details={"analysis_run_id": analysis_run_id},
            ),
        )
    return {"ok": True, "resource": build_analysis_run_resource(analysis_run)}


@router.get("/resource-links")
async def list_mcp_resource_link_resources(
    auth_result: PersistentAgentAuth,
):
    agent_context, auth_response = _authorize_legacy_resource_request(auth_result)
    if auth_response is not None:
        return auth_response
    assert agent_context is not None

    resource_links = get_control_plane_store().list_agent_resource_links(
        agent_identity_id=agent_context["agent_identity_id"],
    )
    return {
        "ok": True,
        "resources": resource_link_resources_from_rows(resource_links),
    }


@router.get("/resource-links/{resource_link_id}")
async def read_mcp_resource_link_resource(
    resource_link_id: str,
    auth_result: PersistentAgentAuth,
):
    agent_context, auth_response = _authorize_legacy_resource_request(auth_result)
    if auth_response is not None:
        return auth_response
    assert agent_context is not None

    resource_link = get_control_plane_store().get_agent_resource_link(resource_link_id)
    if (
        resource_link is None
        or resource_link.get("agent_identity_id") != agent_context["agent_identity_id"]
    ):
        return JSONResponse(
            status_code=404,
            content=error_response(
                "UNKNOWN_RESOURCE_LINK",
                "Unknown resource link.",
                retriable=False,
                details={"resource_link_id": resource_link_id},
            ),
        )
    return {"ok": True, "resource": build_resource_link_resource(resource_link)}


@router.get("/agent/status")
async def read_mcp_agent_status_resource(
    auth_result: PersistentAgentAuth,
):
    agent_context, auth_response = _authorize_legacy_resource_request(auth_result)
    if auth_response is not None:
        return auth_response
    assert agent_context is not None

    visible_tool_names = [
        registered.spec.name for registered in registered_tool_catalog()
    ]
    return {
        "ok": True,
        "resource": build_agent_status_resource(
            agent_identity_id=agent_context["agent_identity_id"],
            caller_capabilities=agent_context["effective_capabilities"],
            visible_tool_names=visible_tool_names,
            include_workspace_details=True,
        ),
    }


@router.get("/workflows")
async def list_mcp_workflow_resources(
    auth_result: PersistentAgentAuth,
):
    _, auth_response = _authorize_legacy_resource_request(auth_result)
    if auth_response is not None:
        return auth_response

    resource = workflow_manifest_resource()
    return {
        "ok": True,
        "resource": resource,
        "resources": workflow_resources_from_manifest(resource["manifest"]),
    }


@router.get("/workflows/{workflow_id}")
async def read_mcp_workflow_resource(
    workflow_id: str,
    auth_result: PersistentAgentAuth,
):
    _, auth_response = _authorize_legacy_resource_request(auth_result)
    if auth_response is not None:
        return auth_response

    try:
        resource = workflow_contract_resource(workflow_id)
    except RuntimeError:
        return JSONResponse(
            status_code=404,
            content=error_response(
                "UNKNOWN_WORKFLOW",
                "Unknown workflow.",
                retriable=False,
                details={"workflow_id": workflow_id},
            ),
        )

    return {"ok": True, "resource": resource}


@router.get("/workflow-ledgers/summary")
async def read_mcp_workflow_ledger_summary_resource(
    auth_result: PersistentAgentAuth,
):
    agent_context, auth_response = _authorize_legacy_resource_request(auth_result)
    if auth_response is not None:
        return auth_response
    assert agent_context is not None

    return {
        "ok": True,
        "resource": workflow_run_summary_resource(
            workflow_ledger_root(),
            ledger_filter=owned_workflow_ledger_filter(
                agent_context["agent_identity_id"]
            ),
        ),
    }


@router.get("/workflow-ledgers/latest/{workflow_id}")
async def read_mcp_latest_workflow_ledger_resource(
    workflow_id: str,
    auth_result: PersistentAgentAuth,
):
    agent_context, auth_response = _authorize_legacy_resource_request(auth_result)
    if auth_response is not None:
        return auth_response
    assert agent_context is not None

    resource = latest_workflow_run_resource(
        workflow_id,
        workflow_ledger_root(),
        ledger_filter=owned_workflow_ledger_filter(agent_context["agent_identity_id"]),
    )
    if resource["exists"] is not True:
        return JSONResponse(
            status_code=404,
            content=error_response(
                "UNKNOWN_WORKFLOW_LEDGER",
                "No workflow ledger was found for this workflow.",
                retriable=False,
                details={"workflow_id": workflow_id},
            ),
        )
    return {"ok": True, "resource": resource}


def workflow_ledger_root() -> Path:
    configured = os.environ.get("DNAFORGE_WORKFLOW_LEDGER_ROOT")
    if configured:
        return Path(configured)
    return DEFAULT_RUNS_ROOT


def _parse_call_body(body: dict[str, Any]) -> dict[str, Any]:
    params = body.get("params") if isinstance(body.get("params"), dict) else body
    tool_name = params.get("tool_name") or params.get("name")
    if not isinstance(tool_name, str) or not tool_name:
        return {
            "tool_name": "",
            "args": {},
            "parent_action_id": None,
            "idempotency_key": None,
            "error": error_response(
                "BAD_INPUT",
                "MCP call body must include tool_name or name.",
                retriable=False,
            ),
        }

    args = params.get("args", params.get("arguments", {}))
    if not isinstance(args, dict):
        return {
            "tool_name": tool_name,
            "args": {},
            "parent_action_id": None,
            "idempotency_key": None,
            "error": error_response(
                "BAD_INPUT",
                "MCP call args/arguments must be a JSON object.",
                retriable=False,
            ),
        }

    parent_action_id = params.get("parent_action_id")
    if parent_action_id is not None and not isinstance(parent_action_id, str):
        parent_action_id = None

    request_idempotency_key = params.get("idempotency_key")
    if request_idempotency_key is not None and not isinstance(
        request_idempotency_key, str
    ):
        request_idempotency_key = None

    return {
        "tool_name": tool_name,
        "args": args,
        "parent_action_id": parent_action_id,
        "idempotency_key": request_idempotency_key,
        "error": None,
    }


SELECTION_RESOURCE_PREFIX = "waypoint://selection/"


def _parse_mcp_resource_uri(uri: str) -> tuple[str, str] | None:
    selection_id = _parse_selection_resource_uri(uri)
    if selection_id is not None:
        return "selection", selection_id

    parsed = urlsplit(uri)
    if parsed.scheme != "waypoint" or parsed.query or parsed.fragment:
        return None
    resource_id = unquote(parsed.path.lstrip("/"))
    if not resource_id:
        return None
    if parsed.netloc in {
        "design",
        "sequence",
        "action",
        "artifact",
        "analysis-run",
        "resource-link",
    }:
        return parsed.netloc, resource_id
    if parsed.netloc == "agent" and resource_id == "status":
        return "agent", resource_id
    if parsed.netloc == "workflow":
        return "workflow", resource_id
    if parsed.netloc == "workflow-runs" and (
        resource_id == "summary"
        or (resource_id.startswith("latest/") and len(resource_id) > len("latest/"))
    ):
        return "workflow-runs", resource_id
    return None


def _parse_selection_resource_uri(uri: str) -> str | None:
    """Extract the reference id from ``waypoint://selection/{refId}``.

    Returns None for any other scheme (so the caller can reject with a
    distinct UNSUPPORTED_RESOURCE_URI) or a malformed selection URI
    (empty or nested-path refId).
    """

    if not uri.startswith(SELECTION_RESOURCE_PREFIX):
        return None
    remainder = uri[len(SELECTION_RESOURCE_PREFIX) :]
    if not remainder or "/" in remainder:
        return None
    return unquote(remainder)


def build_action_resource(
    action: dict[str, Any],
    audits: list[dict[str, Any]],
    chain: list[dict[str, Any]],
) -> dict[str, Any]:
    action_id = str(action["id"])
    return {
        "exists": True,
        "resourceUri": f"waypoint://action/{action_id}",
        "action": public_action(action),
        "auditRecords": [public_audit_record(audit) for audit in audits],
        "actionChain": [
            {
                "id": row.get("id"),
                "toolName": row.get("tool_name"),
                "authorizationState": row.get("authorization_state"),
                "requestedAt": row.get("requested_at"),
                "completedAt": row.get("completed_at"),
            }
            for row in chain
        ],
    }


def public_action(action: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": action.get("id"),
        "agentIdentityId": action.get("agent_identity_id"),
        "toolName": action.get("tool_name"),
        "parameters": action.get("parameters_json"),
        "requestedAt": action.get("requested_at"),
        "authorizationState": action.get("authorization_state"),
        "parentActionId": action.get("parent_action_id"),
        "rootActionId": action.get("root_action_id"),
        "result": action.get("result_json"),
        "error": action.get("error_json"),
        "completedAt": action.get("completed_at"),
    }


def public_audit_record(audit: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": audit.get("id"),
        "actionId": audit.get("action_id"),
        "actorKind": audit.get("actor_kind"),
        "actorIdentity": audit.get("actor_identity"),
        "actorScope": audit.get("actor_scope_json"),
        "beforeState": audit.get("before_state_json"),
        "afterState": audit.get("after_state_json"),
        "sideEffects": audit.get("side_effects_json"),
        "capabilityCheck": audit.get("capability_check_json"),
        "pluginIdentityId": audit.get("plugin_identity_id"),
        "recordedAt": audit.get("recorded_at"),
    }
