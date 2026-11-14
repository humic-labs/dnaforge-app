"""Renderer-owned audit recording for sidecar-mediated tool calls."""

from __future__ import annotations

import hashlib
import json
import time
from functools import lru_cache
from typing import Any

from fastapi import APIRouter
from starlette.responses import JSONResponse

from ..capability_policy import has_required_capabilities
from ..concurrency.job_manager import get_job_manager
from ..concurrency.renderer_bridge import (
    RENDERER_PROVIDER_TOOL_NAMES,
    load_renderer_tool_manifest,
    validate_renderer_bridge_response,
)
from ..concurrency.tool_registry import agent_tool_registry
from ..control_plane import get_control_plane_store
from .mcp_auth import error_response

router = APIRouter(prefix="/mcp", tags=["MCP"])
TERMINAL_RENDERER_AUDIT_STATUSES = {"completed", "failed", "rejected"}


@router.post("/renderer-audit")
async def record_renderer_audit(body: dict[str, Any]):
    parsed = _parse_renderer_audit_body(body)
    if parsed["error"] is not None:
        return JSONResponse(status_code=400, content=parsed["error"])

    store = get_control_plane_store()
    action = store.get_agent_action(parsed["action_id"])
    if action is None:
        return JSONResponse(
            status_code=404,
            content=error_response(
                "UNKNOWN_ACTION",
                "Renderer audit references an unknown sidecar action.",
                retriable=False,
            ),
        )
    declared_provider_name = RENDERER_PROVIDER_TOOL_NAMES.get(
        parsed["tool_name"], parsed["tool_name"]
    )
    if action["tool_name"] not in {parsed["tool_name"], declared_provider_name}:
        return JSONResponse(
            status_code=400,
            content=error_response(
                "BAD_INPUT",
                "Renderer audit tool_name does not match the sidecar action.",
                retriable=False,
            ),
        )
    if action["agent_identity_id"] != parsed["actor_identity"]:
        return JSONResponse(
            status_code=400,
            content=error_response(
                "BAD_INPUT",
                "Renderer audit actor_identity does not match the sidecar action.",
                retriable=False,
            ),
        )
    if action["authorization_state"] not in {"granted", "approved"}:
        return JSONResponse(
            status_code=400,
            content=error_response(
                "BAD_INPUT",
                "Renderer audit action was not authorized for renderer execution.",
                retriable=False,
            ),
        )
    trusted_scope = _trusted_actor_scope(store, action)
    if not _scopes_equal(parsed["actor_scope"], trusted_scope):
        return JSONResponse(
            status_code=400,
            content=error_response(
                "BAD_INPUT",
                "Renderer audit actor_scope does not match the sidecar-authorized scope.",
                retriable=False,
            ),
        )
    parsed["actor_scope"] = trusted_scope

    manifest_error = _validate_against_renderer_manifest(parsed, trusted_scope)
    if manifest_error is not None:
        return JSONResponse(status_code=400, content=manifest_error)

    after_state = parsed["after_state"]
    if after_state is None:
        after_state = {"status": parsed["status"]}
        if parsed["error_payload"] is not None:
            after_state["error"] = parsed["error_payload"]
    elif "status" not in after_state:
        after_state = {**after_state, "status": parsed["status"]}

    outcome = body.get("outcome")
    if outcome is not None:
        expected_ok = parsed["status"] == "completed"
        if (
            parsed["status"] not in TERMINAL_RENDERER_AUDIT_STATUSES
            or not isinstance(outcome, dict)
            or outcome.get("ok") is not expected_ok
            or (expected_ok and "result" not in outcome)
            or (not expected_ok and outcome.get("error") != parsed["error_payload"])
            or (not expected_ok and not isinstance(outcome.get("error"), dict))
        ):
            return JSONResponse(
                status_code=400,
                content=error_response(
                    "BAD_INPUT",
                    "Renderer outcome must agree with its terminal audit.",
                    retriable=False,
                ),
            )
        try:
            validate_renderer_bridge_response(
                {**outcome, "audit_id": "validated-after-insert"}
            )
        except RuntimeError as exc:
            return JSONResponse(
                status_code=400,
                content=error_response(
                    "BAD_INPUT",
                    str(exc),
                    retriable=False,
                ),
            )
        after_state = {
            **after_state,
            "outcome": {"ok": outcome["ok"], "action_id": parsed["action_id"]},
            "outcome_fingerprint": hashlib.sha256(
                json.dumps(outcome, sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest(),
        }

    terminal_outcome = outcome is not None and action["completion_owner"] == "renderer"
    with store.transaction():
        if outcome is not None:
            for record in store.get_audit_records_for_action(parsed["action_id"]):
                recorded = record.get("after_state_json") or {}
                if (
                    record["actor_kind"] != "renderer"
                    or "outcome_fingerprint" not in recorded
                ):
                    continue
                if (
                    recorded["outcome_fingerprint"]
                    == after_state["outcome_fingerprint"]
                ):
                    return {"ok": True, "audit_id": record["id"]}
                return _completion_conflict()
        current = store.get_agent_action(parsed["action_id"])
        if terminal_outcome and current["completion_state"] == "settled":
            return _completion_conflict()
        lifecycle_error = _validate_renderer_audit_lifecycle(store, parsed)
        if lifecycle_error is not None:
            return JSONResponse(status_code=400, content=lifecycle_error)
        audit_id = store.insert_audit_record(
            action_id=parsed["action_id"],
            actor_kind="renderer",
            actor_identity=parsed["actor_identity"],
            actor_scope=parsed["actor_scope"],
            side_effects=parsed["side_effects"],
            capability_check=parsed["capability_check"],
            before_state=parsed["before_state"],
            after_state=after_state,
        )
        if terminal_outcome:
            result = {**outcome, "audit_id": audit_id} if outcome["ok"] else None
            error = (
                None
                if outcome["ok"]
                else {
                    **outcome["error"],
                    "details": {
                        **(outcome["error"].get("details") or {}),
                        "renderer_audit_id": audit_id,
                    },
                }
            )
            registered = agent_tool_registry.get(action["tool_name"])
            persisted_result = (
                registered.persisted_result(result)
                if result is not None
                and registered is not None
                and registered.audit_result_projector is not None
                else result
            )
            settled = store.complete_agent_action(
                parsed["action_id"],
                result=persisted_result,
                error=error,
                completion_owner="renderer",
                terminal_expires_at=time.time() + get_job_manager().ttl_seconds,
            )
            if not settled:
                raise RuntimeError("Renderer completion lost its admitted owner")
    if terminal_outcome:
        manager = get_job_manager()
        if result is not None and persisted_result is not result:
            manager.retain_delivery_result(parsed["action_id"], result)
        manager.reconcile_renderer_action(parsed["action_id"])
    return {"ok": True, "audit_id": audit_id}


def _completion_conflict() -> JSONResponse:
    return JSONResponse(
        status_code=409,
        content=error_response(
            "OUTCOME_CONFLICT",
            "The action already has a different settled outcome.",
            retriable=False,
        ),
    )


def _parse_renderer_audit_body(body: dict[str, Any]) -> dict[str, Any]:
    action_id = body.get("action_id")
    tool_name = body.get("tool_name")
    actor_kind = body.get("actor_kind")
    actor_identity = body.get("actor_identity")
    actor_scope = body.get("actor_scope")
    side_effects = body.get("side_effects")
    capability_check = body.get("capability_check")
    status = body.get("status")
    error_payload = body.get("error")
    before_state = body.get("before_state")
    after_state = body.get("after_state")

    if not isinstance(action_id, str) or not action_id:
        return _bad_renderer_audit("Renderer audit must include action_id.")
    if not isinstance(tool_name, str) or not tool_name:
        return _bad_renderer_audit("Renderer audit must include tool_name.")
    if actor_kind != "renderer":
        return _bad_renderer_audit("Renderer audit actor_kind must be renderer.")
    if not isinstance(actor_identity, str) or not actor_identity:
        return _bad_renderer_audit("Renderer audit must include actor_identity.")
    if not _is_string_list(actor_scope):
        return _bad_renderer_audit("Renderer audit actor_scope must be a string list.")
    if not _is_string_list(side_effects):
        return _bad_renderer_audit("Renderer audit side_effects must be a string list.")
    if not isinstance(capability_check, dict):
        return _bad_renderer_audit(
            "Renderer audit capability_check must be a JSON object."
        )
    if not _is_string_list(capability_check.get("required")):
        return _bad_renderer_audit(
            "Renderer audit capability_check.required must be a string list."
        )
    if not isinstance(capability_check.get("satisfied"), bool):
        return _bad_renderer_audit(
            "Renderer audit capability_check.satisfied must be a boolean."
        )
    if not isinstance(capability_check.get("reason"), str):
        return _bad_renderer_audit(
            "Renderer audit capability_check.reason must be a string."
        )
    if status not in {"accepted", "completed", "rejected", "failed"}:
        return _bad_renderer_audit("Renderer audit status is invalid.")
    if error_payload is not None and not isinstance(error_payload, dict):
        return _bad_renderer_audit("Renderer audit error must be a JSON object.")
    if before_state is not None and not isinstance(before_state, dict):
        return _bad_renderer_audit("Renderer audit before_state must be a JSON object.")
    if after_state is not None and not isinstance(after_state, dict):
        return _bad_renderer_audit("Renderer audit after_state must be a JSON object.")
    if (
        after_state is not None
        and "status" in after_state
        and after_state["status"] != status
    ):
        return _bad_renderer_audit(
            "Renderer audit after_state.status must match status."
        )

    return {
        "action_id": action_id,
        "tool_name": tool_name,
        "actor_identity": actor_identity,
        "actor_scope": actor_scope,
        "side_effects": side_effects,
        "capability_check": capability_check,
        "status": status,
        "error_payload": error_payload,
        "before_state": before_state,
        "after_state": after_state,
        "error": None,
    }


def _bad_renderer_audit(message: str) -> dict[str, Any]:
    return {
        "action_id": "",
        "tool_name": "",
        "actor_identity": "",
        "actor_scope": [],
        "side_effects": [],
        "capability_check": {},
        "status": "",
        "error_payload": None,
        "before_state": None,
        "after_state": None,
        "error": error_response("BAD_INPUT", message, retriable=False),
    }


def _is_string_list(value: Any) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def _validate_against_renderer_manifest(
    parsed: dict[str, Any],
    trusted_scope: list[str],
) -> dict[str, Any] | None:
    tool = _renderer_manifest_tool(parsed["tool_name"])
    if tool is None:
        return error_response(
            "BAD_INPUT",
            "Renderer audit tool_name is not declared in the renderer tool manifest.",
            retriable=False,
        )

    expected_effects = tool["effects"]
    expected_capabilities = tool["required_capabilities"]
    capability_check = parsed["capability_check"]
    if (
        parsed["status"] in {"accepted", "completed"}
        and not capability_check["satisfied"]
    ):
        return error_response(
            "BAD_INPUT",
            "Renderer audit accepted/completed statuses require satisfied capabilities.",
            retriable=False,
        )
    if parsed["side_effects"] != expected_effects:
        return error_response(
            "BAD_INPUT",
            "Renderer audit side_effects do not match the renderer tool manifest.",
            retriable=False,
        )
    if capability_check["required"] != expected_capabilities:
        return error_response(
            "BAD_INPUT",
            "Renderer audit capability_check.required does not match the renderer tool manifest.",
            retriable=False,
        )
    effective_capabilities = capability_check.get(
        "effective_required", expected_capabilities
    )
    declared_capabilities = set(expected_capabilities) | set(
        tool.get("conditional_required_capabilities", [])
    )
    if (
        not _is_string_list(effective_capabilities)
        or not set(expected_capabilities).issubset(effective_capabilities)
        or not set(effective_capabilities).issubset(declared_capabilities)
    ):
        return error_response(
            "BAD_INPUT",
            "Renderer audit effective capabilities do not match the declared tool capabilities.",
            retriable=False,
        )
    if capability_check["satisfied"] and not _scope_satisfies(
        trusted_scope, effective_capabilities
    ):
        return error_response(
            "BAD_INPUT",
            "Renderer audit claims satisfied capabilities outside the actor scope.",
            retriable=False,
        )
    return None


def _validate_renderer_audit_lifecycle(
    store: Any,
    parsed: dict[str, Any],
) -> dict[str, Any] | None:
    if not any(effect != "read-only" for effect in parsed["side_effects"]):
        return None

    has_prior_acceptance = False
    for record in store.get_audit_records_for_action(parsed["action_id"]):
        if record.get("actor_kind") != "renderer":
            continue
        if record.get("actor_identity") != parsed["actor_identity"]:
            continue
        after_state = record.get("after_state_json")
        if not isinstance(after_state, dict):
            continue
        recorded_status = after_state.get("status")
        if recorded_status in TERMINAL_RENDERER_AUDIT_STATUSES:
            return error_response(
                "BAD_INPUT",
                "Renderer audit side-effecting records cannot be appended after a terminal audit.",
                retriable=False,
            )
        if recorded_status == "accepted":
            has_prior_acceptance = True

    if parsed["status"] not in {"completed", "failed"} or has_prior_acceptance:
        return None

    return error_response(
        "BAD_INPUT",
        "Renderer audit completed/failed side-effecting records require a prior accepted audit.",
        retriable=False,
    )


@lru_cache(maxsize=1)
def _renderer_manifest_tools() -> dict[str, dict[str, Any]]:
    tools: dict[str, dict[str, Any]] = {}
    for tool in load_renderer_tool_manifest()["tools"]:
        if not isinstance(tool, dict):
            continue
        name = tool.get("name")
        effects = tool.get("effects")
        capabilities = tool.get("required_capabilities")
        conditional_capabilities = tool.get("conditional_required_capabilities", [])
        if (
            isinstance(name, str)
            and _is_string_list(effects)
            and _is_string_list(capabilities)
            and _is_string_list(conditional_capabilities)
        ):
            tools[name] = {
                "effects": list(effects),
                "required_capabilities": list(capabilities),
                "conditional_required_capabilities": list(conditional_capabilities),
                "sidecar_orchestrated": tool.get("sidecarOrchestrated", False),
            }
    return tools


def _renderer_manifest_tool(tool_name: str) -> dict[str, Any] | None:
    return _renderer_manifest_tools().get(tool_name)


def _trusted_actor_scope(store: Any, action: dict[str, Any]) -> list[str]:
    action_scope = action.get("authorized_scope_json")
    if _is_string_list(action_scope):
        return _canonical_scope(action_scope)

    job = get_job_manager().get(action["id"])
    if (
        job is not None
        and job.agent_identity_id == action["agent_identity_id"]
        and job.tool_name == action["tool_name"]
    ):
        return _canonical_scope(job.agent_capabilities)

    return []


def _scopes_equal(left: list[str], right: list[str]) -> bool:
    return set(left) == set(right)


def _canonical_scope(scope: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for capability in scope:
        if capability in seen:
            continue
        seen.add(capability)
        out.append(capability)
    return out


def _scope_satisfies(actor_scope: list[str], required_capabilities: list[str]) -> bool:
    return has_required_capabilities(actor_scope, required_capabilities)
