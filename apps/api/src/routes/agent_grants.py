"""First-party grant management surface for Settings > Agent Access."""

from __future__ import annotations

import base64
import binascii
import json
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from fastapi import APIRouter, BackgroundTasks, Header, Query, Request
from pydantic import BaseModel, Field
from starlette.responses import JSONResponse

from ..capability_policy import MANAGED_OPERATION_CAPABILITIES
from ..concurrency.renderer_bridge import RENDERER_TOOL_SPECS
from ..control_plane import get_control_plane_store, new_uuid7
from ..external.contract import Capability
from ..external_access_observation import (
    committed_grant_observation,
    emit_external_access_observation,
    observations_enabled,
)
from ..organization_inventory_agent_claims import (
    Identifier,
    OrganizationInventoryAgentClaimPolicyEnrollment,
    OrganizationInventoryAgentClaimService,
    OrganizationInventoryAgentClaimUnavailable,
    OrganizationInventoryAgentLeaseRead,
    OrganizationInventoryAgentLeaseRequest,
    OrganizationInventoryAgentPolicyRead,
    OrganizationInventoryGrantAuthorityUnavailable,
)
from ..security.native_document_authority import (
    native_document_command_url,
    require_native_document_authority,
)
from .mcp_auth import (
    check_sidecar_session,
    error_response,
    generate_api_key,
    grant_environment_id,
    hash_api_key,
)

router = APIRouter(prefix="/agent-grants", tags=["Agent Grants"])

GrantKind = Literal["in-app", "stdio-mcp", "http-api-key"]
GrantOrigin = Literal["app", "tool-key", "local-mcp", "dev-test"]
KNOWN_GRANT_ORIGINS: set[str] = {"app", "tool-key", "local-mcp", "dev-test"}
DEFAULT_GRANT_PAGE_SIZE = 200
LOCAL_MCP_GRANT_LIFETIME = timedelta(hours=12)


def _schedule_grant_observation(
    background_tasks: BackgroundTasks,
    stage: str,
    row: dict[str, Any],
    *,
    local_default_expiry: bool = False,
) -> None:
    if not observations_enabled():
        return
    try:
        receipt = committed_grant_observation(
            stage, row, local_default_expiry=local_default_expiry
        )
        if receipt is not None:
            background_tasks.add_task(emit_external_access_observation, receipt)
    except Exception:
        pass


DEFAULT_LOCAL_MCP_SCOPES = frozenset(
    {
        "read-workspace",
        "read-sequences",
        "modify-tabs",
        "create-entity",
        "edit-primers",
        "edit-assembly",
        "write-workspace",
        "finalize-assembly",
        "edit-protocols",
        "external-fetch:annotation",
        "external-fetch:structure",
        "external-compute:discover",
        "submit-feedback",
    }
)

ALLOWED_API_KEY_SCOPES = frozenset(
    {
        capability
        for spec in RENDERER_TOOL_SPECS
        for capability in (
            *spec["required_capabilities"],
            *spec["conditional_required_capabilities"],
        )
    }
    | {capability.value for capability in Capability}
    | MANAGED_OPERATION_CAPABILITIES
)


class CreateApiKeyGrantRequest(BaseModel):
    label: str = Field(min_length=1, max_length=120)
    scopes: list[str] | None = Field(default=None, max_length=64)


class CreateLocalMcpGrantRequest(BaseModel):
    label: str = Field(min_length=1, max_length=120)


class BindLocalMcpGrantRequest(BaseModel):
    grant_id: str = Field(min_length=1, max_length=200, alias="grantId")
    workspace_id: str = Field(min_length=1, max_length=4096, alias="workspaceId")
    workspace_label: str = Field(min_length=1, max_length=4096, alias="workspaceLabel")


def _organization_claim_owner(request: Request) -> str | OrganizationInventoryAgentClaimUnavailable:
    owner_id = require_native_document_authority(request)
    authority = request.app.state.native_document_authority
    if (
        native_document_command_url(authority.command_url) is None
        or request.client is None
        or request.client.host not in {"127.0.0.1", "::1"}
    ):
        return OrganizationInventoryAgentClaimUnavailable(
            code="ORGANIZATION_CLAIM_CLOCK_UNAVAILABLE",
            message="A supported same-host Native claim owner is required.",
        )
    return owner_id


@router.post(
    "/{agent_id}/organization-inventory/claim-policy",
    response_model=OrganizationInventoryAgentPolicyRead,
)
async def enroll_organization_inventory_claim_policy(
    agent_id: Identifier,
    body: OrganizationInventoryAgentClaimPolicyEnrollment,
    request: Request,
):
    owner = _organization_claim_owner(request)
    if isinstance(owner, OrganizationInventoryAgentClaimUnavailable):
        return owner
    try:
        return OrganizationInventoryAgentClaimService(get_control_plane_store()).enroll(
            agent_id, owner
        )
    except (sqlite3.Error, OrganizationInventoryGrantAuthorityUnavailable):
        return OrganizationInventoryAgentClaimUnavailable(
            code="GRANT_AUTHORITY_UNAVAILABLE", message="The grant claim policy is unavailable."
        )


@router.get(
    "/{agent_id}/organization-inventory/claim-policy",
    response_model=OrganizationInventoryAgentPolicyRead,
)
async def organization_inventory_claim_policy_status(agent_id: Identifier, request: Request):
    owner = _organization_claim_owner(request)
    if isinstance(owner, OrganizationInventoryAgentClaimUnavailable):
        return owner
    try:
        return OrganizationInventoryAgentClaimService(get_control_plane_store()).status(
            agent_id, owner
        )
    except (sqlite3.Error, OrganizationInventoryGrantAuthorityUnavailable):
        return OrganizationInventoryAgentClaimUnavailable(
            code="GRANT_AUTHORITY_UNAVAILABLE", message="The grant claim policy is unavailable."
        )


@router.post(
    "/{agent_id}/organization-inventory/lease",
    response_model=OrganizationInventoryAgentLeaseRead,
)
async def acquire_organization_inventory_agent_lease(
    agent_id: Identifier,
    body: OrganizationInventoryAgentLeaseRequest,
    request: Request,
):
    owner = _organization_claim_owner(request)
    if isinstance(owner, OrganizationInventoryAgentClaimUnavailable):
        return owner
    try:
        return OrganizationInventoryAgentClaimService(get_control_plane_store()).lease(
            agent_id, owner, body
        )
    except (sqlite3.Error, OrganizationInventoryGrantAuthorityUnavailable):
        return OrganizationInventoryAgentClaimUnavailable(
            code="GRANT_AUTHORITY_UNAVAILABLE",
            message="Current grant claim admission is unavailable.",
        )


@router.get("")
async def list_agent_grants(
    include_dev_test: bool = Query(default=False, alias="includeDevTest"),
    cursor: str | None = Query(default=None),
    page_size: int = Query(
        default=DEFAULT_GRANT_PAGE_SIZE,
        ge=1,
        le=DEFAULT_GRANT_PAGE_SIZE,
        alias="pageSize",
    ),
    session_token: str | None = Header(default=None, alias="X-DNAForge-Session"),
):
    session_error = check_sidecar_session(session_token)
    if session_error is not None:
        return JSONResponse(status_code=401, content=session_error)

    after = _decode_page_cursor(cursor)
    if cursor is not None and after is None:
        return JSONResponse(
            status_code=400,
            content=error_response(
                "BAD_GRANT_CURSOR",
                "Agent grant page cursor is invalid.",
                retriable=False,
            ),
        )

    store = get_control_plane_store()
    managed_identity_id = os.environ.get("DNAFORGE_MCP_AGENT_IDENTITY")
    rows = store.list_active_agent_identities_for_settings(
        include_development=include_dev_test,
        managed_identity_id=managed_identity_id,
        limit=page_size + 1,
        after=after,
    )
    has_more = len(rows) > page_size
    page_rows = rows[:page_size]
    hidden_development_grant_count = (
        0
        if include_dev_test
        else store.count_active_development_agent_identities(
            managed_identity_id=managed_identity_id
        )
    )
    return {
        "ok": True,
        "grants": [_grant_from_row(row) for row in page_rows],
        "hiddenDevelopmentGrantCount": hidden_development_grant_count,
        "hasMore": has_more,
        "nextCursor": (
            _encode_page_cursor(page_rows[-1]["sort_at"], page_rows[-1]["id"])
            if has_more
            else None
        ),
    }


@router.post("/api-keys")
async def create_api_key_grant(
    body: CreateApiKeyGrantRequest,
    background_tasks: BackgroundTasks,
    session_token: str | None = Header(default=None, alias="X-DNAForge-Session"),
):
    session_error = check_sidecar_session(session_token)
    if session_error is not None:
        return JSONResponse(status_code=401, content=session_error)

    label = body.label.strip()
    scopes = (
        sorted(ALLOWED_API_KEY_SCOPES)
        if body.scopes is None
        else _dedupe_scopes(body.scopes)
    )
    invalid_scopes = [scope for scope in scopes if scope not in ALLOWED_API_KEY_SCOPES]
    if not label:
        return JSONResponse(
            status_code=400,
            content=error_response(
                "BAD_GRANT_LABEL",
                "API key name is required.",
                retriable=False,
            ),
        )
    if not scopes:
        return JSONResponse(
            status_code=400,
            content=error_response(
                "BAD_GRANT_SCOPE",
                "Select at least one scope.",
                retriable=False,
            ),
        )
    if invalid_scopes:
        return JSONResponse(
            status_code=400,
            content=error_response(
                "BAD_GRANT_SCOPE",
                "API key request includes unsupported scopes.",
                retriable=False,
                details={"invalid_scopes": invalid_scopes},
            ),
        )

    api_key = generate_api_key()
    identity_id = f"agent_http_{new_uuid7()}"
    store = get_control_plane_store()
    store.create_agent_identity(
        identity_id=identity_id,
        scope=scopes,
        label=label,
        kind="http-api-key",
        api_key_hash=hash_api_key(api_key),
        origin="tool-key",
        environment_id=grant_environment_id(),
        created_by="local-human",
    )
    row = store.get_agent_identity(identity_id) or {}
    grant = _grant_from_row(row)
    _schedule_grant_observation(background_tasks, "grant_create", row)
    return {"ok": True, "grant": grant, "apiKey": api_key}


@router.post("/local-mcp")
async def create_local_mcp_grant(
    body: CreateLocalMcpGrantRequest,
    background_tasks: BackgroundTasks,
    session_token: str | None = Header(default=None, alias="X-DNAForge-Session"),
):
    session_error = check_sidecar_session(session_token)
    if session_error is not None:
        return JSONResponse(status_code=401, content=session_error)

    label = body.label.strip()
    if not label:
        return JSONResponse(
            status_code=400,
            content=error_response(
                "BAD_GRANT_LABEL",
                "Local MCP client name is required.",
                retriable=False,
            ),
        )
    scopes = sorted(DEFAULT_LOCAL_MCP_SCOPES)
    if not set(scopes).issubset(ALLOWED_API_KEY_SCOPES):
        raise RuntimeError("Default local MCP grant includes unsupported scopes.")

    api_key = generate_api_key()
    identity_id = f"agent_stdio_{new_uuid7()}"
    expires_at = (
        (datetime.now(timezone.utc) + LOCAL_MCP_GRANT_LIFETIME)
        .isoformat()
        .replace("+00:00", "Z")
    )
    store = get_control_plane_store()
    store.create_agent_identity(
        identity_id=identity_id,
        scope=scopes,
        expires_at=expires_at,
        label=label,
        kind="stdio-mcp",
        api_key_hash=hash_api_key(api_key),
        origin="local-mcp",
        environment_id=grant_environment_id(),
        created_by="app-owned-mcp-bootstrap",
    )
    row = store.get_agent_identity(identity_id) or {}
    grant = _grant_from_row(row)
    _schedule_grant_observation(
        background_tasks, "grant_create", row, local_default_expiry=True
    )
    return {"ok": True, "grant": grant, "apiKey": api_key}


@router.post("/local-mcp/bind")
async def bind_local_mcp_grant(
    body: BindLocalMcpGrantRequest,
    background_tasks: BackgroundTasks,
    session_token: str | None = Header(default=None, alias="X-DNAForge-Session"),
):
    session_error = check_sidecar_session(session_token)
    if session_error is not None:
        return JSONResponse(status_code=401, content=session_error)
    if not get_control_plane_store().bind_local_mcp_workspace(
        body.grant_id,
        workspace_id=body.workspace_id,
        workspace_label=body.workspace_label,
    ):
        return JSONResponse(
            status_code=404,
            content=error_response(
                "UNKNOWN_GRANT",
                "The active local MCP grant was not found.",
                retriable=False,
            ),
        )
    try:
        row = get_control_plane_store().get_agent_identity(body.grant_id) or {}
        _schedule_grant_observation(background_tasks, "workspace_bind", row)
    except Exception:
        pass
    return {"ok": True}


@router.delete("/{grant_id}")
async def revoke_agent_grant(
    grant_id: str,
    background_tasks: BackgroundTasks,
    session_token: str | None = Header(default=None, alias="X-DNAForge-Session"),
):
    session_error = check_sidecar_session(session_token)
    if session_error is not None:
        return JSONResponse(status_code=401, content=session_error)

    try:
        revoked = await OrganizationInventoryAgentClaimService(get_control_plane_store()).revoke(
            grant_id
        )
    except OrganizationInventoryGrantAuthorityUnavailable:
        return JSONResponse(
            status_code=503,
            content=error_response(
                "GRANT_REVOCATION_PENDING",
                "Grant revocation is not yet confirmed complete.",
                retriable=True,
            ),
        )
    if not revoked:
        return JSONResponse(
            status_code=404,
            content=error_response(
                "UNKNOWN_GRANT",
                "Agent grant was not found.",
                retriable=False,
                details={"grant_id": grant_id},
            ),
        )
    try:
        row = get_control_plane_store().get_agent_identity(grant_id) or {}
        _schedule_grant_observation(background_tasks, "selected_revoke", row)
    except Exception:
        pass
    return {"ok": True}


def _grant_from_row(row: dict[str, Any]) -> dict[str, Any]:
    grant_id = str(row.get("id") or "")
    kind = _coerce_kind(row.get("kind"), grant_id)
    origin = _coerce_origin(row, kind, grant_id)
    scopes = row.get("scope_json")
    return {
        "id": grant_id,
        "label": _coerce_label(row.get("label"), kind, grant_id),
        "kind": kind,
        "origin": origin,
        "isDevelopment": origin == "dev-test",
        "environmentId": _optional_string(row.get("environment_id")),
        "createdBy": _optional_string(row.get("created_by")),
        "scopes": scopes if isinstance(scopes, list) else [],
        "createdAt": row.get("created_at"),
        "lastUsedAt": row.get("last_used_at"),
        "lastCallStatus": _optional_string(row.get("last_call_status")),
        "lastToolName": _optional_string(row.get("last_tool_name")),
        "clientName": _optional_string(row.get("client_name")),
        "clientVersion": _optional_string(row.get("client_version")),
        "boundWorkspace": _optional_string(row.get("bound_workspace_label")),
        "expiresAt": row.get("expires_at"),
        "revokedAt": row.get("revoked_at"),
    }


def _coerce_kind(value: Any, grant_id: str) -> GrantKind:
    if grant_id == os.environ.get("DNAFORGE_MCP_AGENT_IDENTITY"):
        return "in-app"
    if value in {"in-app", "stdio-mcp", "http-api-key"}:
        return value
    if grant_id.startswith("agent_http_"):
        return "http-api-key"
    return "stdio-mcp"


def _coerce_origin(row: dict[str, Any], kind: GrantKind, grant_id: str) -> GrantOrigin:
    value = row.get("origin")
    if isinstance(value, str) and value in KNOWN_GRANT_ORIGINS:
        return value
    if _is_development_identity(row, kind, grant_id):
        return "dev-test"
    if kind == "in-app":
        return "app"
    if kind == "http-api-key":
        return "tool-key"
    return "local-mcp"


def _is_development_identity(
    row: dict[str, Any], kind: GrantKind, grant_id: str
) -> bool:
    if row.get("origin") == "dev-test":
        return True
    if kind in {"in-app", "http-api-key"}:
        return False
    label = row.get("label")
    candidates = [grant_id.lower()]
    if isinstance(label, str):
        candidates.append(label.strip().lower())
    exact = {"local-agent", "test-agent", "smoke-agent"}
    prefixes = ("dna82-", "dna114-", "harness-", "smoke-", "test-")
    needles = ("-e2e", "e2e", "harness", "smoke")
    return any(
        candidate in exact
        or candidate.startswith(prefixes)
        or any(needle in candidate for needle in needles)
        for candidate in candidates
    )


def _coerce_label(value: Any, kind: GrantKind, grant_id: str) -> str:
    if isinstance(value, str) and value.strip():
        return value.strip()
    if kind == "in-app":
        return "In-app Strider"
    if kind == "http-api-key":
        return "API key"
    return grant_id or "MCP stdio bridge"


def _optional_string(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


def _dedupe_scopes(scopes: list[str]) -> list[str]:
    seen: set[str] = set()
    deduped: list[str] = []
    for scope in scopes:
        if not isinstance(scope, str):
            continue
        scope = scope.strip()
        if not scope or scope in seen:
            continue
        seen.add(scope)
        deduped.append(scope)
    return deduped


def _decode_page_cursor(cursor: str | None) -> tuple[str, str] | None:
    if cursor is None:
        return None
    try:
        padding = "=" * (-len(cursor) % 4)
        decoded = json.loads(base64.urlsafe_b64decode(cursor + padding))
    except (UnicodeDecodeError, ValueError, binascii.Error):
        return None
    if not isinstance(decoded, list) or len(decoded) != 2:
        return None
    if not all(isinstance(value, str) for value in decoded) or not decoded[1]:
        return None
    return decoded[0], decoded[1]


def _encode_page_cursor(created_at: str, identity_id: str) -> str:
    return (
        base64.urlsafe_b64encode(json.dumps([created_at, identity_id]).encode("utf-8"))
        .decode("ascii")
        .rstrip("=")
    )
