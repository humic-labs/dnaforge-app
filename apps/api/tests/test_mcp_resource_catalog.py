"""Tests for shared MCP resource catalog descriptors."""

from src.mcp_resource_catalog import (
    AGENT_STATUS_RESOURCE_URI,
    agent_status_list_resource,
    mcp_resource_templates,
)


def test_mcp_resource_templates_include_core_agent_resources():
    templates = mcp_resource_templates()

    assert {template["uriTemplate"] for template in templates} == {
        "waypoint://selection/{refId}",
        "waypoint://design/{id}",
        "waypoint://sequence/{documentId}",
        "waypoint://action/{id}",
        AGENT_STATUS_RESOURCE_URI,
        "waypoint://artifact/{id}",
        "waypoint://analysis-run/{id}",
        "waypoint://resource-link/{id}",
        "waypoint://workflow/{id}",
        "waypoint://workflow-runs/summary",
        "waypoint://workflow-runs/latest/{id}",
    }
    assert all(template["mimeType"] == "application/json" for template in templates)


def test_agent_status_list_resource_matches_template_uri():
    resource = agent_status_list_resource()
    status_template = next(
        template
        for template in mcp_resource_templates()
        if template["uriTemplate"] == AGENT_STATUS_RESOURCE_URI
    )

    assert resource["uri"] == AGENT_STATUS_RESOURCE_URI
    assert resource["name"] == status_template["name"]
    assert resource["description"] == status_template["description"]
    assert resource["mimeType"] == status_template["mimeType"]
