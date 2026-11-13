"""Shared MCP resource descriptors and templates."""

from __future__ import annotations

JSON_MIME_TYPE = "application/json"

AGENT_STATUS_RESOURCE_URI = "waypoint://agent/status"


def json_resource(
    *,
    uri: str,
    name: str,
    description: str,
) -> dict[str, str]:
    return {
        "uri": uri,
        "name": name,
        "description": description,
        "mimeType": JSON_MIME_TYPE,
    }


def json_resource_template(
    *,
    uri_template: str,
    name: str,
    description: str,
) -> dict[str, str]:
    return {
        "uriTemplate": uri_template,
        "name": name,
        "description": description,
        "mimeType": JSON_MIME_TYPE,
    }


def agent_status_list_resource() -> dict[str, str]:
    return json_resource(
        uri=AGENT_STATUS_RESOURCE_URI,
        name="DNAForge agent status",
        description="Current MCP sidecar, caller, tools, and latest resource state.",
    )


def mcp_resource_templates() -> list[dict[str, str]]:
    return [
        json_resource_template(
            uri_template="waypoint://selection/{refId}",
            name="DNAForge selection",
            description="Measured DNAForge selection descriptor by reference id.",
        ),
        json_resource_template(
            uri_template="waypoint://design/{id}",
            name="DNAForge design",
            description="Canonical DNAForge design state by id.",
        ),
        json_resource_template(
            uri_template="waypoint://sequence/{documentId}",
            name="DNAForge sequence",
            description="Canonical DNAForge sequence state by stable document id.",
        ),
        json_resource_template(
            uri_template="waypoint://action/{id}",
            name="DNAForge agent action",
            description="Agent command lifecycle and audit record by action id.",
        ),
        json_resource_template(
            uri_template=AGENT_STATUS_RESOURCE_URI,
            name="DNAForge agent status",
            description="Current MCP sidecar, caller, tools, and latest resource state.",
        ),
        json_resource_template(
            uri_template="waypoint://artifact/{id}",
            name="DNAForge agent artifact",
            description="Registered external output or file artifact by id.",
        ),
        json_resource_template(
            uri_template="waypoint://analysis-run/{id}",
            name="DNAForge analysis run",
            description="External command or analysis provenance record by id.",
        ),
        json_resource_template(
            uri_template="waypoint://resource-link/{id}",
            name="DNAForge resource link",
            description="Typed edge between two DNAForge resources by id.",
        ),
        json_resource_template(
            uri_template="waypoint://workflow/{id}",
            name="DNAForge agent workflow",
            description="Registered agent workflow contract by workflow id.",
        ),
        json_resource_template(
            uri_template="waypoint://workflow-runs/summary",
            name="DNAForge workflow run summary",
            description="Aggregated outcomes from prior workflow-ledger.json files.",
        ),
        json_resource_template(
            uri_template="waypoint://workflow-runs/latest/{id}",
            name="DNAForge latest workflow run",
            description="Latest workflow-ledger.json record for a workflow id.",
        ),
    ]
