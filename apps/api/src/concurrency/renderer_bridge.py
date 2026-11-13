"""Renderer-backed tool specs and HTTP forwarding handlers for Phase 1b."""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import httpx

from ..agent_manifest_paths import agent_tool_manifest_path
from ..agent_workspace_authority import agent_project_scope
from ..control_plane import get_control_plane_store
from .schema import (
    DNAForgeTool,
    ExpectedLatency,
    PoolName,
    ToolCategory,
    ToolDuration,
    ToolEffect,
    ToolHome,
    ToolRuntime,
    ToolShape,
)
from .tool_errors import ToolExecutionFailure
from .tool_registry import ToolContext, ToolHandler, agent_tool_registry

RENDERER_TOOL_MANIFEST_FILENAME = "renderer-tool-manifest.json"
RENDERER_TOOL_MANIFEST_PATH = agent_tool_manifest_path(RENDERER_TOOL_MANIFEST_FILENAME)


def load_renderer_tool_manifest(
    path: Path = RENDERER_TOOL_MANIFEST_PATH,
) -> dict[str, Any]:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != 1:
        raise RuntimeError("Renderer tool manifest schemaVersion must be 1.")
    tools = manifest.get("tools")
    if not isinstance(tools, list) or not tools:
        raise RuntimeError(
            "Renderer tool manifest must include a non-empty tools list."
        )
    return manifest


def load_renderer_tool_specs(
    path: Path = RENDERER_TOOL_MANIFEST_PATH,
) -> tuple[dict[str, Any], ...]:
    manifest = load_renderer_tool_manifest(path)
    specs: list[dict[str, Any]] = []
    seen_names: set[str] = set()

    for raw_tool in manifest["tools"]:
        if not isinstance(raw_tool, dict):
            raise RuntimeError("Renderer tool manifest entries must be objects.")

        name = raw_tool.get("name")
        description = raw_tool.get("description")
        input_schema = raw_tool.get("inputSchema")
        shape = raw_tool.get("shape")
        effects = raw_tool.get("effects")
        required_capabilities = raw_tool.get("required_capabilities")
        conditional_required_capabilities = raw_tool.get(
            "conditional_required_capabilities", []
        )
        requires_workspace = raw_tool.get("requiresWorkspace", False)
        conditionally_requires_workspace = raw_tool.get(
            "conditionallyRequiresWorkspace", False
        )
        mcp_annotations = raw_tool.get("mcpAnnotations", {})
        exposure = raw_tool.get("exposure")
        sidecar_orchestrated = raw_tool.get("sidecarOrchestrated", False)

        if not isinstance(name, str) or not name:
            raise RuntimeError("Renderer tool manifest entry must include name.")
        if name in seen_names:
            raise RuntimeError(f"Duplicate renderer tool manifest entry: {name}")
        seen_names.add(name)

        if not isinstance(description, str) or not description:
            raise RuntimeError(f"Renderer tool {name} must include description.")
        if not isinstance(input_schema, dict):
            raise RuntimeError(f"Renderer tool {name} must include inputSchema.")
        if not isinstance(shape, str):
            raise RuntimeError(f"Renderer tool {name} must include shape.")
        if not isinstance(effects, list) or not all(
            isinstance(effect, str) for effect in effects
        ):
            raise RuntimeError(f"Renderer tool {name} must include effects.")
        if not isinstance(required_capabilities, list) or not all(
            isinstance(capability, str) for capability in required_capabilities
        ):
            raise RuntimeError(
                f"Renderer tool {name} must include required_capabilities."
            )
        if not isinstance(conditional_required_capabilities, list) or not all(
            isinstance(capability, str)
            for capability in conditional_required_capabilities
        ):
            raise RuntimeError(
                f"Renderer tool {name} conditional_required_capabilities must be a list."
            )
        if not isinstance(requires_workspace, bool):
            raise RuntimeError(
                f"Renderer tool {name} requiresWorkspace must be boolean."
            )
        if not isinstance(conditionally_requires_workspace, bool):
            raise RuntimeError(
                f"Renderer tool {name} conditionallyRequiresWorkspace must be boolean."
            )
        if mcp_annotations is None:
            mcp_annotations = {}
        if not isinstance(mcp_annotations, dict):
            raise RuntimeError(
                f"Renderer tool {name} mcpAnnotations must be an object."
            )
        if not isinstance(exposure, dict):
            raise RuntimeError(f"Renderer tool {name} must declare exposure.")
        exposure_kind = exposure.get("kind")
        if exposure_kind == "shared":
            if set(exposure) != {"kind"}:
                raise RuntimeError(
                    f"Renderer tool {name} shared exposure must contain only kind."
                )
        elif exposure_kind == "mcp-only":
            reason = exposure.get("reason")
            if (
                set(exposure) != {"kind", "reason"}
                or not isinstance(reason, str)
                or not reason.strip()
            ):
                raise RuntimeError(
                    f"Renderer tool {name} mcp-only exposure requires a reason."
                )
        else:
            raise RuntimeError(
                f"Renderer tool {name} exposure kind must be shared or mcp-only."
            )
        if not isinstance(sidecar_orchestrated, bool):
            raise RuntimeError(
                f"Renderer tool {name} sidecarOrchestrated must be boolean."
            )
        if "operations.start" in required_capabilities and not sidecar_orchestrated:
            raise RuntimeError(
                f"Renderer tool {name} starts a managed operation but has no sidecar owner."
            )

        output_schema = raw_tool.get("outputSchema")
        if not isinstance(output_schema, dict) or not output_schema.get("properties"):
            raise RuntimeError(
                f"Renderer tool {name} must declare a detailed outputSchema."
            )

        specs.append(
            {
                "name": name,
                "description": description,
                "inputs": input_schema,
                "outputs": raw_tool["outputSchema"],
                "shape": shape,
                "effects": effects,
                "required_capabilities": required_capabilities,
                "conditional_required_capabilities": conditional_required_capabilities,
                "requires_workspace": requires_workspace,
                "conditionally_requires_workspace": conditionally_requires_workspace,
                "mcp_annotations": mcp_annotations,
                "exposure": exposure,
                "sidecar_orchestrated": sidecar_orchestrated,
            }
        )

    return tuple(specs)


RENDERER_TOOL_SPECS = load_renderer_tool_specs()


def load_renderer_provider_tool_names(
    path: Path = RENDERER_TOOL_MANIFEST_PATH,
) -> dict[str, str]:
    """Return provider-safe aliases for legacy renderer tool names."""

    manifest = load_renderer_tool_manifest(path)
    raw_aliases = manifest.get("providerToolNames", {})
    if not isinstance(raw_aliases, dict):
        raise RuntimeError(
            "Renderer tool manifest providerToolNames must be an object."
        )
    renderer_names = {spec["name"] for spec in load_renderer_tool_specs(path)}
    provider_names: set[str] = set()
    aliases: dict[str, str] = {}
    for renderer_name, provider_name in raw_aliases.items():
        if renderer_name not in renderer_names or not isinstance(provider_name, str):
            raise RuntimeError("Invalid renderer provider tool-name alias.")
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", provider_name):
            raise RuntimeError(
                f"Renderer provider tool name is not provider-safe: {provider_name}"
            )
        if provider_name in renderer_names or provider_name in provider_names:
            raise RuntimeError(
                f"Duplicate renderer provider tool name: {provider_name}"
            )
        provider_names.add(provider_name)
        aliases[renderer_name] = provider_name
    return aliases


RENDERER_PROVIDER_TOOL_NAMES = load_renderer_provider_tool_names()


def register_renderer_agent_tools() -> None:
    for spec_config in RENDERER_TOOL_SPECS:
        spec = _renderer_tool_spec(spec_config)
        if spec_config["sidecar_orchestrated"]:
            registered = agent_tool_registry.get(spec.name)
            if registered is None or registered.handler is None:
                raise RuntimeError(
                    f"Sidecar-orchestrated renderer tool has no sidecar handler: {spec.name}"
                )
            provider_name = RENDERER_PROVIDER_TOOL_NAMES.get(spec.name)
            if provider_name:
                agent_tool_registry.register(
                    registered.spec.model_copy(update={"name": provider_name}),
                    registered.handler,
                    replay_policy=registered.replay_policy,
                    audit_parameter_projector=registered.audit_parameter_projector,
                    audit_result_projector=registered.audit_result_projector,
                )
            continue
        agent_tool_registry.register(spec, _make_renderer_handler(spec.name))
        provider_name = RENDERER_PROVIDER_TOOL_NAMES.get(spec.name)
        if provider_name:
            provider_spec = spec.model_copy(update={"name": provider_name})
            agent_tool_registry.register(
                provider_spec, _make_renderer_handler(spec.name)
            )


def _renderer_tool_spec(config: dict[str, Any]) -> DNAForgeTool:
    return DNAForgeTool(
        name=config["name"],
        description=config["description"],
        inputs=config["inputs"],
        outputs=config["outputs"],
        home=ToolHome.RENDERER,
        runtime=ToolRuntime.SERVICE,
        handler_ref=f"renderer_bridge.{config['name']}",
        pool=PoolName.CPU_FAST,
        expected_latency=ExpectedLatency.SUB_SECOND,
        idempotency_keyable=False,
        streams_progress=False,
        category=ToolCategory(
            shape=ToolShape(config["shape"]),
            duration=ToolDuration.IMMEDIATE,
            effects=[ToolEffect(effect) for effect in config["effects"]],
            cancelable=False,
            approval_gated=False,
            read_only_hint=config["mcp_annotations"].get("readOnlyHint"),
            destructive_hint=config["mcp_annotations"].get("destructiveHint"),
            idempotent_hint=config["mcp_annotations"].get("idempotentHint"),
            open_world_hint=config["mcp_annotations"].get("openWorldHint"),
        ),
        required_capabilities=config["required_capabilities"],
        conditional_required_capabilities=config["conditional_required_capabilities"],
        requires_workspace=config["requires_workspace"],
        conditionally_requires_workspace=config["conditionally_requires_workspace"],
        audit_required=True,
    )


def _make_renderer_handler(tool_name: str) -> ToolHandler:
    async def handler(args: dict[str, Any], context: ToolContext) -> dict[str, Any]:
        return await call_renderer_bridge(tool_name, args, context)

    return handler


async def call_renderer_bridge(
    tool_name: str,
    args: dict[str, Any],
    context: ToolContext,
    *,
    post: Callable[..., Awaitable[httpx.Response]] | None = None,
    trusted_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    bridge_url = os.environ.get("DNAFORGE_RENDERER_BRIDGE_URL")
    session_token = os.environ.get("DNAFORGE_RENDERER_BRIDGE_TOKEN")
    if not bridge_url or not session_token:
        raise RuntimeError("Renderer bridge is not configured.")

    url = f"{bridge_url.rstrip('/')}/__tools/call"
    body = {
        "tool_name": tool_name,
        "args": args,
        "agent_identity": context.agent_identity_id,
        "action_id": context.job_id,
    }
    if trusted_context is not None:
        body["trusted_context"] = trusted_context
    headers = {
        "X-DNAForge-Session": session_token,
        "X-DNAForge-Agent-Identity": context.agent_identity_id,
        "X-DNAForge-Action-Id": context.job_id,
        "X-DNAForge-Agent-Capabilities": json.dumps(context.agent_capabilities),
        "X-DNAForge-Cancelable": str(context.cancelable).lower(),
    }
    if context.turn_id:
        headers["X-DNAForge-Turn-Id"] = context.turn_id
    identity = get_control_plane_store().get_agent_identity(context.agent_identity_id)
    headers["X-DNAForge-Project-Scope"] = json.dumps(agent_project_scope(identity))
    if identity is not None and isinstance(identity.get("bound_workspace_id"), str):
        headers["X-DNAForge-Bound-Workspace"] = identity["bound_workspace_id"]

    async def receive(send):
        endpoint = url
        failures = 0
        deadline = time.monotonic() + 3600
        while time.monotonic() < deadline:
            try:
                response = await send(endpoint, json=body, headers=headers)
                payload = validate_renderer_bridge_response(response.json())
                if response.status_code >= 400 and payload.get("ok") is True:
                    raise ValueError("Renderer bridge returned HTTP error for success")
                failures = 0
                code = payload.get("error", {}).get("code")
                if code == "OPERATION_PENDING":
                    endpoint = f"{bridge_url.rstrip('/')}/__tools/result"
                    continue
                if code == "OUTCOME_UNRESOLVED":
                    return _persisted_renderer_outcome(context) or payload
                return payload
            except (httpx.TransportError, ValueError, RuntimeError):
                endpoint = f"{bridge_url.rstrip('/')}/__tools/result"
                retained = _persisted_renderer_outcome(context)
                if retained is not None:
                    return retained
                failures += 1
                if failures >= 3:
                    break
                await asyncio.sleep(min(failures, 2))
        return {
            "ok": False,
            "error": {
                "code": "OUTCOME_UNRESOLVED",
                "message": "Renderer outcome is unresolved. Check the original action and audit before repeating work.",
                "retriable": False,
                "details": {"actionId": context.job_id, "stateMayHaveChanged": True},
            },
        }

    if post is not None:
        validated = await receive(post)
    else:
        async with httpx.AsyncClient(timeout=30.0) as client:
            validated = await receive(client.post)

    if validated["ok"] is False:
        error = validated["error"]
        details = error.get("details") if isinstance(error.get("details"), dict) else {}
        audit_id = validated.get("audit_id")
        if audit_id is not None:
            details = {**details, "renderer_audit_id": audit_id}
        raise ToolExecutionFailure(
            code=error["code"],
            message=error["message"],
            retriable=error["retriable"],
            details=details or None,
        )
    return validated


def _persisted_renderer_outcome(context: ToolContext) -> dict[str, Any] | None:
    from .job_manager import get_job_manager

    delivery = get_job_manager().peek_delivery_result(context.job_id)
    if isinstance(delivery, dict) and isinstance(delivery.get("audit_id"), str):
        try:
            return validate_renderer_bridge_response(delivery)
        except RuntimeError:
            pass
    action = get_control_plane_store().get_agent_action(context.job_id)
    if action is None or action["agent_identity_id"] != context.agent_identity_id:
        return None
    result = action.get("result_json")
    if isinstance(result, dict) and result.get("audit_id"):
        return result
    error = action.get("error_json")
    if isinstance(error, dict) and error.get("details", {}).get("renderer_audit_id"):
        return {
            "ok": False,
            "error": error,
            "audit_id": error["details"]["renderer_audit_id"],
        }
    return None


async def read_renderer_resource(
    reference_id: str,
    *,
    agent_identity_id: str,
    agent_capabilities: list[str],
    turn_id: str | None = None,
    post: Callable[..., Awaitable[httpx.Response]] | None = None,
) -> dict[str, Any]:
    """ Phase-A RA2: read a cached selection descriptor from the renderer.

    Mirrors ``call_renderer_bridge`` (same loopback bridge, same session +
    grant headers) but targets the sibling ``/__resources/read`` verb instead
    of ``/__tools/call``. The renderer bridge answers with the parsed
    ``entity_references`` row descriptor (``{"ok": true, "reference": {...}}``)
    or a structured not-found (``{"ok": false, "error": {...}}``). This helper
    performs the transport only; the ``/mcp/resources/read`` route interprets
    the payload into MCP ``contents`` or an error envelope.
    """

    bridge_url = os.environ.get("DNAFORGE_RENDERER_BRIDGE_URL")
    session_token = os.environ.get("DNAFORGE_RENDERER_BRIDGE_TOKEN")
    if not bridge_url or not session_token:
        raise RuntimeError("Renderer bridge is not configured.")

    url = f"{bridge_url.rstrip('/')}/__resources/read"
    body = {"reference_id": reference_id}
    headers = {
        "X-DNAForge-Session": session_token,
        "X-DNAForge-Agent-Identity": agent_identity_id,
        "X-DNAForge-Agent-Capabilities": json.dumps(agent_capabilities),
    }
    if turn_id:
        headers["X-DNAForge-Turn-Id"] = turn_id
    identity = get_control_plane_store().get_agent_identity(agent_identity_id)
    headers["X-DNAForge-Project-Scope"] = json.dumps(agent_project_scope(identity))
    if identity is not None and isinstance(identity.get("bound_workspace_id"), str):
        headers["X-DNAForge-Bound-Workspace"] = identity["bound_workspace_id"]

    if post is not None:
        response = await post(url, json=body, headers=headers)
    else:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(url, json=body, headers=headers)

    try:
        payload = response.json()
    except ValueError as exc:
        raise RuntimeError("Renderer bridge returned a non-JSON response.") from exc

    return {"status_code": response.status_code, "payload": payload}


def validate_renderer_bridge_response(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise RuntimeError("Renderer bridge returned an invalid response shape.")

    ok = payload.get("ok")
    if not isinstance(ok, bool):
        raise RuntimeError("Renderer bridge response must include boolean ok.")

    if ok:
        if "result" not in payload:
            raise RuntimeError("Renderer bridge success response must include result.")
        audit_id = payload.get("audit_id")
        if not isinstance(audit_id, str) or not audit_id:
            raise RuntimeError(
                "Renderer bridge success response must include audit_id."
            )
        return payload

    error = payload.get("error")
    if not isinstance(error, dict):
        raise RuntimeError("Renderer bridge error response must include error.")
    if not isinstance(error.get("code"), str) or not error["code"]:
        raise RuntimeError("Renderer bridge error response must include error.code.")
    if not isinstance(error.get("message"), str) or not error["message"]:
        raise RuntimeError("Renderer bridge error response must include error.message.")
    if not isinstance(error.get("retriable"), bool):
        raise RuntimeError(
            "Renderer bridge error response must include error.retriable."
        )
    details = error.get("details")
    if details is not None and not isinstance(details, dict):
        raise RuntimeError("Renderer bridge error.details must be an object.")
    audit_id = payload.get("audit_id")
    if audit_id is not None and (not isinstance(audit_id, str) or not audit_id):
        raise RuntimeError("Renderer bridge audit_id must be a non-empty string.")
    return payload
