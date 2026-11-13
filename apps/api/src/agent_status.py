"""Agent-facing MCP status resource."""

from __future__ import annotations

import os
from typing import Any

from .agent_workflows import workflow_manifest_resource
from .concurrency.job_manager import get_job_manager
from .concurrency.pools import get_pool_manager
from .concurrency.tool_registry import agent_tool_registry
from .control_plane import get_control_plane_store
from .mcp_resource_catalog import AGENT_STATUS_RESOURCE_URI


def build_agent_status_resource(
    *,
    agent_identity_id: str,
    caller_capabilities: list[str],
    visible_tool_names: list[str] | None = None,
    include_workspace_details: bool = True,
) -> dict[str, Any]:
    store = get_control_plane_store()
    tool_names = (
        sorted(tool.spec.name for tool in agent_tool_registry.list())
        if visible_tool_names is None
        else sorted(set(visible_tool_names))
    )
    manifest = workflow_manifest_resource()["manifest"]
    workflows = (
        [
            workflow
            for workflow in manifest.get("workflows", [])
            if isinstance(workflow, dict)
        ]
        if include_workspace_details
        else []
    )
    latest_artifact = _latest_owned_row(
        store.list_agent_artifacts(
            limit=1,
            agent_identity_id=agent_identity_id,
        ),
        agent_identity_id,
        include=include_workspace_details,
    )
    latest_analysis_run = _latest_owned_row(
        store.list_agent_analysis_runs(
            limit=1,
            agent_identity_id=agent_identity_id,
        ),
        agent_identity_id,
        include=include_workspace_details,
    )
    latest_resource_link = _latest_owned_row(
        store.list_agent_resource_links(
            limit=1,
            agent_identity_id=agent_identity_id,
        ),
        agent_identity_id,
        include=include_workspace_details,
    )

    return {
        "exists": True,
        "resourceUri": AGENT_STATUS_RESOURCE_URI,
        "sidecar": {
            "ok": True,
            "database": "ready",
        },
        "mcp": {
            "sessionConfigured": bool(os.environ.get("DNAFORGE_MCP_SESSION_TOKEN")),
            "resourceUri": AGENT_STATUS_RESOURCE_URI,
        },
        "caller": {
            "agentIdentityId": agent_identity_id,
            "capabilities": caller_capabilities,
        },
        "tools": {
            "registered": len(tool_names),
            "names": tool_names,
        },
        "jobs": get_job_manager().counts(agent_identity_id=agent_identity_id),
        "pools": get_pool_manager().stats(),
        "workflows": {
            "resourceUri": "waypoint://workflow/manifest",
            "count": len(workflows),
            "ids": [
                workflow["id"]
                for workflow in workflows
                if isinstance(workflow.get("id"), str)
            ],
        },
        "latestResources": {
            "artifact": _summary(
                latest_artifact,
                id_key="id",
                uri_key="resource_uri",
                name_key="name",
                extra_keys=("created_at", "kind"),
            ),
            "analysisRun": _summary(
                latest_analysis_run,
                id_key="id",
                uri_key="resource_uri",
                name_key="name",
                extra_keys=("created_at", "status"),
            ),
            "resourceLink": _summary(
                latest_resource_link,
                id_key="id",
                uri_key="resource_uri",
                name_key="relationship",
                extra_keys=("created_at", "source_uri", "target_uri"),
            ),
        },
    }


def _latest_owned_row(
    rows: list[dict[str, Any]],
    agent_identity_id: str,
    *,
    include: bool,
) -> dict[str, Any] | None:
    if not include:
        return None
    return next(
        (row for row in rows if row.get("agent_identity_id") == agent_identity_id),
        None,
    )


def _summary(
    row: dict[str, Any] | None,
    *,
    id_key: str,
    uri_key: str,
    name_key: str,
    extra_keys: tuple[str, ...],
) -> dict[str, Any] | None:
    if row is None:
        return None
    summary = {
        "id": row.get(id_key),
        "resourceUri": row.get(uri_key),
        "name": row.get(name_key),
    }
    for key in extra_keys:
        summary[_camelize(key)] = row.get(key)
    return summary


def _camelize(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(item[:1].upper() + item[1:] for item in tail)
