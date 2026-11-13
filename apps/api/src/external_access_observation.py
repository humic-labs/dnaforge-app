"""Closed, optional observations from the existing local authority owners.

Only the native-launched sidecar can use the authenticated main bridge. No
credentials, identities, names, arguments, results or locators enter a receipt.
The existing request/job owns delivery; there is no new queue or retry loop.
"""

from __future__ import annotations

import asyncio
import os
import time
import uuid
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit

import httpx

from .control_plane import get_control_plane_store

ACCESS_ENUMS = {
    "access_stage": {
        "registration",
        "grant_create",
        "workspace_bind",
        "request_admitted",
        "request_outcome",
        "selected_revoke",
    },
    "access_result": {
        "registered",
        "current",
        "repaired",
        "not_installed",
        "name_conflict",
        "failed",
        "created",
        "bound",
        "revoked",
        "admitted",
        "allowed",
        "refused",
        "unknown",
    },
    "access_client": {
        "claude_code",
        "codex",
        "grok_build",
        "desktop",
        "script",
        "local_mcp",
        "unknown",
    },
    "access_transport": {"configuration", "stdio", "http", "unknown"},
    "access_scope_class": {"not_observed", "read", "write", "broad", "unknown"},
    "access_expiry_class": {
        "not_observed",
        "twelve_hours",
        "timed",
        "none",
        "expired",
        "unknown",
    },
    "access_authority": {
        "native_configuration",
        "committed_grant",
        "committed_binding",
        "admitted_job",
        "committed_action",
        "transport_gate",
        "committed_revoke",
    },
    "access_execution": {
        "not_observed",
        "queued",
        "running",
        "completed",
        "failed",
        "canceled",
    },
    "access_usefulness": {"not_attested"},
}


def valid_observation(value: Any) -> bool:
    if type(value) is not dict or set(value) != {
        "feature_area",
        "operation_id",
        "occurred_at_ms",
        *ACCESS_ENUMS,
    }:
        return False
    if type(value["feature_area"]) is not str or value["feature_area"] != "tool_usage":
        return False
    operation_id = value["operation_id"]
    if type(operation_id) is not str or len(operation_id) != 36:
        return False
    try:
        parsed = uuid.UUID(operation_id)
        if parsed.version != 4 or str(parsed) != operation_id.lower():
            return False
    except ValueError:
        return False
    clock = value["occurred_at_ms"]
    if type(clock) is not int or not 0 <= clock <= 9_007_199_254_740_991:
        return False
    if any(
        type(value[key]) is not str or value[key] not in allowed
        for key, allowed in ACCESS_ENUMS.items()
    ):
        return False
    stage, result, authority, execution = (
        value[key]
        for key in (
            "access_stage",
            "access_result",
            "access_authority",
            "access_execution",
        )
    )
    pairs = {
        "registration": (
            "native_configuration",
            {
                "registered",
                "current",
                "repaired",
                "not_installed",
                "name_conflict",
                "failed",
                "unknown",
            },
        ),
        "grant_create": ("committed_grant", {"created"}),
        "workspace_bind": ("committed_binding", {"bound"}),
        "selected_revoke": ("committed_revoke", {"revoked"}),
        "request_admitted": ("admitted_job", {"admitted"}),
    }
    if stage == "request_outcome":
        if authority == "transport_gate":
            return result == "refused" and execution == "not_observed"
        return (
            authority == "committed_action"
            and result in {"allowed", "refused", "unknown"}
            and execution in {"completed", "failed", "canceled", "not_observed"}
        )
    expected, results = pairs[stage]
    if authority != expected or result not in results:
        return False
    if execution != ("queued" if stage == "request_admitted" else "not_observed"):
        return False
    return stage != "registration" or (
        value["access_scope_class"] == "not_observed"
        and value["access_expiry_class"] == "not_observed"
    )


def observations_enabled() -> bool:
    return os.environ.get("DNAFORGE_EXTERNAL_ACCESS_OBSERVATIONS") == "1"


def _clock(value: Any) -> int | None:
    if not isinstance(value, str) or len(value) > 64:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            return None
        delta = parsed.astimezone(timezone.utc) - datetime(
            1970, 1, 1, tzinfo=timezone.utc
        )
        return (
            delta.days * 86_400_000
            + delta.seconds * 1_000
            + delta.microseconds // 1_000
        )
    except (ValueError, OverflowError, OSError):
        return None


def _identity_classes(
    row: dict[str, Any], *, observed_at_ms: int | None = None
) -> dict[str, str] | None:
    kind = row.get("kind")
    if kind not in {"stdio-mcp", "http-api-key"} or row.get("origin") == "dev-test":
        return None
    scopes = row.get("scope_json")
    scope = "unknown"
    if (
        isinstance(scopes, list)
        and len(scopes) <= 256
        and all(isinstance(s, str) for s in scopes)
    ):
        if "*" in scopes:
            scope = "broad"
        elif set(scopes) & {
            "write-workspace",
            "create-entity",
            "modify-tabs",
            "edit-primers",
            "finalize-assembly",
            "modify-settings",
        }:
            scope = "write"
        elif scopes and all(
            s.startswith(("read-", "list-", "external-fetch:")) for s in scopes
        ):
            scope = "read"
    expiry = "none" if row.get("expires_at") is None else "unknown"
    expires_at = _clock(row.get("expires_at"))
    if expires_at is not None:
        observed = (
            observed_at_ms
            if observed_at_ms is not None
            else time.time_ns() // 1_000_000
        )
        expiry = "expired" if expires_at <= observed else "timed"
    return {
        "access_client": "local_mcp" if kind == "stdio-mcp" else "script",
        "access_transport": "stdio" if kind == "stdio-mcp" else "http",
        "access_scope_class": scope,
        "access_expiry_class": expiry,
    }


def _receipt(
    *,
    stage: str,
    result: str,
    authority: str,
    classes: dict[str, str],
    operation_id: str | None = None,
    occurred_at_ms: int | None = None,
    execution: str = "not_observed",
) -> dict[str, Any] | None:
    try:
        correlation = operation_id or str(uuid.uuid4())
    except Exception:
        return None
    receipt = {
        "feature_area": "tool_usage",
        "operation_id": correlation,
        "occurred_at_ms": (
            occurred_at_ms
            if occurred_at_ms is not None
            else time.time_ns() // 1_000_000
        ),
        "access_stage": stage,
        "access_result": result,
        "access_client": classes["access_client"],
        "access_transport": classes["access_transport"],
        "access_scope_class": classes["access_scope_class"],
        "access_expiry_class": classes["access_expiry_class"],
        "access_authority": authority,
        "access_execution": execution,
        "access_usefulness": "not_attested",
    }
    return receipt if valid_observation(receipt) else None


def committed_grant_observation(
    stage: str,
    row: dict[str, Any],
    *,
    local_default_expiry: bool = False,
) -> dict[str, Any] | None:
    stages = {
        "grant_create": ("created", "committed_grant", "created_at"),
        "workspace_bind": ("bound", "committed_binding", None),
        "selected_revoke": ("revoked", "committed_revoke", "revoked_at"),
    }
    if stage not in stages:
        return None
    result, authority, clock_field = stages[stage]
    clock = _clock(row.get(clock_field)) if clock_field else time.time_ns() // 1_000_000
    if clock is None:
        return None
    classes = _identity_classes(row, observed_at_ms=clock)
    if classes is None:
        return None
    if local_default_expiry:
        classes["access_expiry_class"] = "twelve_hours"
    return _receipt(
        stage=stage,
        result=result,
        authority=authority,
        classes=classes,
        occurred_at_ms=clock,
    )


def action_observation(
    action_id: str,
    *,
    admitted: bool = False,
    operation_id: str | None = None,
    execution: str = "not_observed",
) -> dict[str, Any] | None:
    """Read committed evidence; queued work alone never proves authorization."""
    store = get_control_plane_store()
    action = store.get_agent_action(action_id)
    if action is None:
        return None
    clock = _clock(action.get("requested_at" if admitted else "completed_at"))
    if clock is None:
        return None
    identity = store.get_agent_identity(action["agent_identity_id"])
    classes = (
        _identity_classes(
            {**identity, "scope_json": action.get("authorized_scope_json")},
            observed_at_ms=clock,
        )
        if identity
        else None
    )
    if classes is None:
        return None
    if admitted:
        return _receipt(
            stage="request_admitted",
            result="admitted",
            authority="admitted_job",
            classes=classes,
            operation_id=operation_id,
            occurred_at_ms=clock,
            execution="queued",
        )
    audits = store.get_audit_records_for_action(action_id)
    authority_audits = [
        audit for audit in audits if audit.get("actor_kind") == "renderer"
    ] or audits
    check = (
        authority_audits[-1].get("capability_check_json") if authority_audits else None
    )
    satisfied = check.get("satisfied") if isinstance(check, dict) else None
    state = action.get("authorization_state")
    result = "unknown"
    if state in {"denied", "rejected"} or satisfied is False:
        result = "refused"
    elif state in {"granted", "approved"} and satisfied is True:
        result = "allowed"
    if execution not in {"completed", "failed", "canceled"} or not action.get(
        "job_pool"
    ):
        execution = "not_observed"
    elif execution == "completed" and action.get("error_json") is not None:
        execution = "not_observed"
    elif execution in {"failed", "canceled"} and action.get("error_json") is None:
        execution = "not_observed"
    return _receipt(
        stage="request_outcome",
        result=result,
        authority="committed_action",
        classes=classes,
        operation_id=operation_id,
        occurred_at_ms=clock,
        execution=execution,
    )


def transport_refusal_observation(code: str) -> dict[str, Any] | None:
    return _receipt(
        stage="request_outcome",
        result="refused",
        authority="transport_gate",
        classes={
            "access_client": "unknown",
            "access_transport": "http",
            "access_scope_class": "unknown",
            "access_expiry_class": "expired" if code == "GRANT_EXPIRED" else "unknown",
        },
    )


async def emit_external_access_observation(receipt: dict[str, Any] | None) -> bool:
    """Delivery acknowledgment is not an SDK acknowledgment or domain result."""
    if not observations_enabled() or not valid_observation(receipt):
        return False
    url = os.environ.get("DNAFORGE_RENDERER_BRIDGE_URL", "")
    token = os.environ.get("DNAFORGE_RENDERER_BRIDGE_TOKEN", "")
    source = os.environ.get("DNAFORGE_MCP_SESSION_TOKEN", "")
    try:
        parsed = urlsplit(url)
        if (
            parsed.scheme != "http"
            or parsed.hostname != "127.0.0.1"
            or not parsed.port
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or parsed.path not in {"", "/"}
            or not token
            or not source
        ):
            return False
        async with asyncio.timeout(0.5):
            async with httpx.AsyncClient(
                timeout=0.25, trust_env=False, follow_redirects=False
            ) as client:
                async with client.stream(
                    "POST",
                    url.rstrip("/") + "/__external-access/observe",
                    headers={
                        "X-DNAForge-Session": token,
                        "X-DNAForge-Sidecar-Session": source,
                    },
                    json=receipt,
                ) as response:
                    return response.status_code == 200
    except Exception:
        return False


async def observe_action(
    action_id: str,
    *,
    admitted: bool = False,
    operation_id: str | None = None,
    execution: str = "not_observed",
) -> None:
    if not observations_enabled():
        return
    try:
        receipt = action_observation(
            action_id, admitted=admitted, operation_id=operation_id, execution=execution
        )
        await emit_external_access_observation(receipt)
    except Exception:
        return
