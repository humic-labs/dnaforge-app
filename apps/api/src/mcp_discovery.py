"""Caller-scoped MCP tool and resource discovery projections.

The stdio companion runs in a separate process from the HTTP sidecar, so the
sidecar remains the authorization and registry authority.  This module keeps
that policy independent from FastAPI and from MCP transport/version details.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from urllib.parse import quote

from .agent_analysis_runs import analysis_run_resources_from_rows
from .agent_artifacts import artifact_resources_from_rows
from .agent_resource_links import resource_link_resources_from_rows
from .agent_workflows import (
    workflow_manifest_resource,
    workflow_resources_from_manifest,
)
from .capability_policy import has_required_capabilities
from .concurrency.dispatcher import dispatch_tool
from .concurrency.job_manager import get_job_manager
from .concurrency.schema import to_mcp_format
from .concurrency.tool_registry import RegisteredTool, agent_tool_registry
from .control_plane import get_control_plane_store
from .mcp_resource_catalog import agent_status_list_resource, mcp_resource_templates

RESOURCE_READ_CAPABILITIES = ["read-workspace"]
RESOURCE_TEMPLATE_CAPABILITIES = {
    "waypoint://sequence/{documentId}": ["read-sequences"],
}


class WorkspaceResourceDiscoveryError(RuntimeError):
    """Raised when an available renderer workspace catalog fails closed."""


def registered_tool_catalog() -> list[RegisteredTool]:
    """Return the complete authenticated tool catalog in stable name order.

    Discovery describes what DNAForge can do. Authorization happens once, when
    the caller executes a tool, so a narrow grant no longer sees a misleadingly
    incomplete product surface.
    """

    return sorted(
        agent_tool_registry.list(), key=lambda registered: registered.spec.name
    )


def build_mcp_discovery_projection(
    agent_context: Mapping[str, Any],
) -> dict[str, Any]:
    """Build the compact authenticated projection consumed by stdio MCP."""

    agent_identity_id = str(agent_context["agent_identity_id"])
    effective_capabilities = list(agent_context["effective_capabilities"])
    requested_capabilities = (
        list(agent_context["requested_capabilities"])
        if agent_context.get("requested_capabilities_supplied") is True
        else None
    )
    granted_capabilities = agent_context.get("granted_capabilities")
    if isinstance(granted_capabilities, list):
        granted_projection: list[str] | None = list(granted_capabilities)
    else:
        granted_projection = None
    client_info = agent_context.get("client_info")
    client_info_projection = (
        {
            "name": client_info["name"],
            "version": client_info["version"],
        }
        if isinstance(client_info, Mapping)
        and isinstance(client_info.get("name"), str)
        and isinstance(client_info.get("version"), str)
        else None
    )

    tools = [to_mcp_format(registered.spec) for registered in registered_tool_catalog()]
    resources, resource_templates = _scoped_resources(
        agent_identity_id=agent_identity_id,
        effective_capabilities=effective_capabilities,
    )
    return {
        "ok": True,
        "caller": {
            "agentIdentityId": agent_identity_id,
            "label": agent_context.get("agent_label"),
            "authMethod": agent_context.get("auth_method"),
            "clientInfo": client_info_projection,
            "requestedCapabilities": requested_capabilities,
            "grantedCapabilities": granted_projection,
            "effectiveCapabilities": effective_capabilities,
        },
        "tools": tools,
        "resources": resources,
        "resourceTemplates": resource_templates,
    }


async def add_open_workspace_resources(
    projection: dict[str, Any],
    agent_context: Mapping[str, Any],
) -> None:
    """Preserve legacy open design/sequence resources through scoped discovery."""

    effective_capabilities = list(agent_context["effective_capabilities"])
    if not has_required_capabilities(effective_capabilities, ["read-workspace"]):
        return
    registered = agent_tool_registry.get("get_workspace")
    if registered is None or registered.handler is None:
        return

    try:
        job = await dispatch_tool(
            "get_workspace",
            {},
            agent_identity_id=str(agent_context["agent_identity_id"]),
            agent_capabilities=effective_capabilities,
        )
        if job.task is not None:
            await job.task
        snapshot = get_job_manager().snapshot(job.id) or job.snapshot()
    except Exception as exc:  # noqa: BLE001 - normalized at the route boundary
        raise WorkspaceResourceDiscoveryError(
            "DNAForge renderer workspace discovery failed."
        ) from exc

    result = snapshot.get("result")
    workspace = result.get("result") if isinstance(result, dict) else None
    if snapshot.get("status") != "completed" or not isinstance(workspace, dict):
        raise WorkspaceResourceDiscoveryError(
            "DNAForge renderer workspace discovery returned an invalid result."
        )

    open_resources = open_resources_from_workspace(workspace)
    if not has_required_capabilities(effective_capabilities, ["read-sequences"]):
        open_resources = [
            resource
            for resource in open_resources
            if not resource["uri"].startswith("waypoint://sequence/")
        ]
    resources = projection.get("resources")
    if not isinstance(resources, list):
        raise WorkspaceResourceDiscoveryError(
            "DNAForge scoped discovery returned an invalid resource catalog."
        )
    resources.extend(open_resources)
    projection["resources"] = sorted(
        {resource["uri"]: resource for resource in resources}.values(),
        key=lambda resource: (resource["uri"], resource["name"]),
    )


def open_resources_from_workspace(workspace: Mapping[str, Any]) -> list[dict[str, str]]:
    """Project unique open design and sequence tabs into MCP resources."""

    resources: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    folders = _workspace_folders(workspace)
    panels = workspace.get("panels")
    if not isinstance(panels, list):
        return resources
    for panel in panels:
        if not isinstance(panel, Mapping):
            continue
        tabs = panel.get("tabs")
        if not isinstance(tabs, list):
            continue
        for tab in tabs:
            if not isinstance(tab, Mapping):
                continue
            tab_type = tab.get("type")
            entity_id = tab.get("entityId")
            if tab_type not in {"design", "sequence"} or not isinstance(entity_id, str):
                continue
            if not entity_id:
                continue
            resource_id = (
                _sequence_resource_id(entity_id, folders)
                if tab_type == "sequence"
                else entity_id
            )
            key = (tab_type, resource_id)
            if key in seen:
                continue
            seen.add(key)
            raw_label = tab.get("label")
            name = (
                raw_label if isinstance(raw_label, str) and raw_label else resource_id
            )
            resources.append(
                {
                    "uri": f"waypoint://{tab_type}/{quote(resource_id, safe='')}",
                    "name": name,
                    "description": (
                        "Canonical DNAForge design state for an open design."
                        if tab_type == "design"
                        else "Canonical DNAForge sequence state for an open sequence."
                    ),
                    "mimeType": "application/json",
                }
            )
    return resources


def _workspace_folders(workspace: Mapping[str, Any]) -> list[dict[str, str]]:
    raw_folders = workspace.get("folders")
    if not isinstance(raw_folders, list):
        return []
    folders: list[dict[str, str]] = []
    for folder in raw_folders:
        if not isinstance(folder, Mapping):
            continue
        name = folder.get("name")
        path = folder.get("path")
        if isinstance(name, str) and name and isinstance(path, str) and path:
            folders.append({"name": name, "path": path.rstrip("/")})
    return folders


def _sequence_resource_id(entity_id: str, folders: list[dict[str, str]]) -> str:
    if not entity_id.startswith("/") or not folders:
        return entity_id
    matching_folder = max(
        (
            folder
            for folder in folders
            if entity_id == folder["path"] or entity_id.startswith(f"{folder['path']}/")
        ),
        key=lambda folder: len(folder["path"]),
        default=None,
    )
    if matching_folder is None:
        return entity_id
    relative_path = entity_id[len(matching_folder["path"]) :].lstrip("/")
    if not relative_path:
        return entity_id
    if len(folders) == 1:
        return relative_path
    folder_name = matching_folder["name"]
    if sum(1 for folder in folders if folder["name"] == folder_name) > 1:
        return entity_id
    return f"{folder_name}/{relative_path}"


def _scoped_resources(
    *,
    agent_identity_id: str,
    effective_capabilities: list[str],
) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    templates = sorted(
        (
            template
            for template in mcp_resource_templates()
            if has_required_capabilities(
                effective_capabilities,
                RESOURCE_TEMPLATE_CAPABILITIES.get(
                    template["uriTemplate"], RESOURCE_READ_CAPABILITIES
                ),
            )
        ),
        key=lambda template: (template["uriTemplate"], template["name"]),
    )
    if not has_required_capabilities(
        effective_capabilities,
        RESOURCE_READ_CAPABILITIES,
    ):
        return [], templates

    store = get_control_plane_store()
    artifacts = store.list_agent_artifacts(
        limit=500,
        agent_identity_id=agent_identity_id,
    )
    analysis_runs = store.list_agent_analysis_runs(
        limit=500,
        agent_identity_id=agent_identity_id,
    )
    resource_links = store.list_agent_resource_links(
        limit=500,
        agent_identity_id=agent_identity_id,
    )
    manifest = workflow_manifest_resource()["manifest"]
    resources = [
        agent_status_list_resource(),
        *artifact_resources_from_rows(artifacts),
        *analysis_run_resources_from_rows(analysis_runs),
        *resource_link_resources_from_rows(resource_links),
        *workflow_resources_from_manifest(manifest),
    ]
    resources.sort(key=lambda resource: (resource["uri"], resource["name"]))

    return resources, templates
