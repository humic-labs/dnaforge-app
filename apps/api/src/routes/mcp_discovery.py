"""Authenticated discovery projection for the local MCP companion."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Body, Header
from starlette.responses import JSONResponse

from ..control_plane import get_control_plane_store
from ..mcp_discovery import (
    WorkspaceResourceDiscoveryError,
    add_open_workspace_resources,
    build_mcp_discovery_projection,
    registered_tool_catalog,
)
from ..mcp_tool_names import canonical_renderer_tool_name, portable_tool_catalog
from .mcp_auth import MCPClientInfo, error_response, resolve_authenticated_agent_context

router = APIRouter(prefix="/mcp/discover", tags=["MCP"])


@router.get("")
async def discover_mcp_surface(
    agent_identity_id: str = Header(
        default="local-agent", alias="X-DNAForge-Agent-Identity"
    ),
    agent_capabilities: str | None = Header(
        default=None, alias="X-DNAForge-Agent-Capabilities"
    ),
    session_token: str | None = Header(default=None, alias="X-DNAForge-Session"),
    api_key: str | None = Header(default=None, alias="X-DNAForge-API-Key"),
):
    """Return one deterministic catalog without request-specific context."""

    return await _discover_mcp_surface(
        body=None,
        agent_identity_id=agent_identity_id,
        agent_capabilities=agent_capabilities,
        session_token=session_token,
        api_key=api_key,
    )


@router.post("")
async def discover_mcp_surface_with_context(
    body: Annotated[Any, Body()] = None,
    agent_identity_id: str = Header(
        default="local-agent", alias="X-DNAForge-Agent-Identity"
    ),
    agent_capabilities: str | None = Header(
        default=None, alias="X-DNAForge-Agent-Capabilities"
    ),
    session_token: str | None = Header(default=None, alias="X-DNAForge-Session"),
    api_key: str | None = Header(default=None, alias="X-DNAForge-API-Key"),
):
    """Return one deterministic catalog with optional client context.

    Modern companions may send ``clientInfo`` in the POST body. It is request
    context only: identity and authority always come from the launch-owned
    authentication headers and the current persistent grant row.
    """

    return await _discover_mcp_surface(
        body=body,
        agent_identity_id=agent_identity_id,
        agent_capabilities=agent_capabilities,
        session_token=session_token,
        api_key=api_key,
    )


async def _discover_mcp_surface(
    *,
    body: Any,
    agent_identity_id: str,
    agent_capabilities: str | None,
    session_token: str | None,
    api_key: str | None,
):
    """Build the authenticated projection shared by GET and POST."""

    client_info, client_info_error = _parse_client_info(body)
    if client_info_error is not None:
        return JSONResponse(status_code=400, content=client_info_error)

    agent_context, auth_error = resolve_authenticated_agent_context(
        session_token=session_token,
        api_key=api_key,
        agent_identity_id=agent_identity_id,
        raw_capabilities=agent_capabilities,
        require_persistent_grant=True,
        client_info=client_info,
    )
    if auth_error is not None:
        return JSONResponse(status_code=401, content=auth_error)
    assert agent_context is not None
    if client_info is not None:
        get_control_plane_store().update_agent_identity_client(
            agent_context["agent_identity_id"],
            client_name=client_info["name"],
            client_version=client_info["version"],
        )
    if isinstance(body, dict) and "toolLookup" in body:
        lookup = body["toolLookup"]
        if (
            not isinstance(lookup, dict)
            or not isinstance(lookup.get("name"), str)
            or not 1 <= len(lookup["name"]) <= 128
            or not isinstance(lookup.get("portableNames", False), bool)
        ):
            return JSONResponse(
                status_code=400,
                content=error_response(
                    "BAD_TOOL_LOOKUP",
                    "toolLookup requires a bounded name and boolean portableNames.",
                    retriable=False,
                ),
            )

        tools = [
            {
                "name": item.spec.name,
                "annotations": {"cancelable": item.spec.category.cancelable},
            }
            for item in registered_tool_catalog()
        ]
        name = lookup["name"]
        if lookup.get("portableNames") is True:
            _, names = portable_tool_catalog(tools)
            name = names.get(name, name)
        tool = next(
            (
                tool
                for tool in tools
                if (
                    tool["name"] == name
                    or canonical_renderer_tool_name(tool["name"]) == name
                )
            ),
            None,
        )
        return {
            "ok": True,
            "tool": (
                None
                if tool is None
                else {
                    "name": canonical_renderer_tool_name(name),
                    "cancelable": tool.get("annotations", {}).get("cancelable") is True,
                }
            ),
        }
    projection = build_mcp_discovery_projection(agent_context)
    if _include_open_workspace_resources(body):
        try:
            await add_open_workspace_resources(projection, agent_context)
        except WorkspaceResourceDiscoveryError as exc:
            return JSONResponse(
                status_code=502,
                content=error_response(
                    "WORKSPACE_DISCOVERY_UNAVAILABLE",
                    str(exc),
                    retriable=True,
                ),
            )
    return projection


def _parse_client_info(
    body: Any,
) -> tuple[MCPClientInfo | None, dict[str, Any] | None]:
    if body is None:
        return None, None
    if not isinstance(body, dict):
        return None, _bad_client_info()
    if "clientInfo" not in body:
        return None, None

    raw_client_info = body["clientInfo"]
    if not isinstance(raw_client_info, dict):
        return None, _bad_client_info()
    name = raw_client_info.get("name")
    version = raw_client_info.get("version")
    if (
        not isinstance(name, str)
        or not name.strip()
        or not isinstance(version, str)
        or not version.strip()
    ):
        return None, _bad_client_info()
    return {"name": name.strip(), "version": version.strip()}, None


def _bad_client_info() -> dict[str, Any]:
    return error_response(
        "BAD_CLIENT_INFO",
        "clientInfo must contain non-empty string name and version fields.",
        retriable=False,
    )


def _include_open_workspace_resources(body: Any) -> bool:
    """Return whether this is the companion's dynamic resources/list projection."""

    return isinstance(body, dict) and body.get("includeOpenWorkspaceResources") is True
