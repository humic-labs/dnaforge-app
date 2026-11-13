"""Tests for the  MCP connection smoke runner."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from scripts.agent_mcp_connection_smoke import (
    ConnectionSmokeConfig,
    parse_capabilities,
    run_connection_smoke_with_client,
)


def test_parse_capabilities_accepts_json_and_csv():
    assert parse_capabilities('["read-workspace", "write-workspace"]') == [
        "read-workspace",
        "write-workspace",
    ]
    assert parse_capabilities("read-workspace, write-workspace") == [
        "read-workspace",
        "write-workspace",
    ]


def test_connection_smoke_runs_minimal_mcp_resource_lifecycle(tmp_path):
    client = FakeConnectionSmokeClient()
    config = ConnectionSmokeConfig(
        api_url="http://127.0.0.1:8000",
        session_token="session",
        agent_identity="smoke-agent",
        agent_capabilities=["read-workspace", "write-workspace"],
        workflow_id="ncbi-derivative-design",
        output_dir=tmp_path,
        timeout_seconds=5,
    )

    summary = run_connection_smoke_with_client(client, config)

    assert summary["ok"] is True
    assert summary["status"] == "passed"
    assert summary["resources"] == {
        "status": "waypoint://agent/status",
        "artifact": "waypoint://artifact/artifact-1",
        "analysisRun": "waypoint://analysis-run/run-1",
        "resourceLink": "waypoint://resource-link/link-1",
    }
    assert [item["name"] for item in summary["checks"]] == [
        "initialize",
        "tools_available",
        "status_resource_readable",
        "workflow_manifest_readable",
        "artifact_round_trip",
        "analysis_run_round_trip",
        "resource_link_round_trip",
        "status_reports_latest_resources",
    ]
    assert all(item["passed"] for item in summary["checks"])
    assert client.notifications == [("notifications/initialized", {})]
    assert [call["name"] for call in client.tool_calls] == [
        "artifact.register",
        "analysis_run.create",
        "resource_link.create",
    ]
    summary_path = Path(summary["summaryPath"])
    assert summary_path.exists()
    saved_summary = json.loads(summary_path.read_text())
    assert saved_summary["status"] == "passed"
    assert saved_summary["summaryPath"] == str(summary_path)
    assert (tmp_path / "connection-smoke-output.tsv").read_text() == (
        "gene\tcount\nlacZ\t12\n"
    )


class FakeConnectionSmokeClient:
    def __init__(self):
        self.notifications: list[tuple[str, dict[str, Any]]] = []
        self.tool_calls: list[dict[str, Any]] = []
        self.artifact_uri: str | None = None
        self.analysis_run_uri: str | None = None
        self.resource_link_uri: str | None = None

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        self.notifications.append((method, params or {}))

    def request(
        self, method: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        params = params or {}
        if method == "initialize":
            return {
                "result": {
                    "serverInfo": {"name": "dnaforge-mcp"},
                    "capabilities": {"tools": {}, "resources": {}},
                }
            }
        if method == "tools/list":
            return {
                "result": {
                    "tools": [
                        {"name": "artifact.register"},
                        {"name": "analysis_run.create"},
                        {"name": "resource_link.create"},
                    ]
                }
            }
        if method == "resources/read":
            uri = params["uri"]
            return {"result": {"contents": [self._resource_content(uri)]}}
        if method == "tools/call":
            return {"result": self._call_tool(params)}
        raise AssertionError(f"unexpected MCP method: {method}")

    def _call_tool(self, params: dict[str, Any]) -> dict[str, Any]:
        name = params["name"]
        arguments = params["arguments"]
        self.tool_calls.append({"name": name, "arguments": arguments})

        if name == "artifact.register":
            artifact_path = Path(arguments["path"])
            assert artifact_path.exists()
            self.artifact_uri = "waypoint://artifact/artifact-1"
            return self._tool_result(
                name,
                {
                    "resourceUri": self.artifact_uri,
                    "artifactId": "artifact-1",
                },
            )
        if name == "analysis_run.create":
            assert arguments["outputArtifacts"] == [self.artifact_uri]
            self.analysis_run_uri = "waypoint://analysis-run/run-1"
            return self._tool_result(
                name,
                {
                    "resourceUri": self.analysis_run_uri,
                    "analysisRunId": "run-1",
                },
            )
        if name == "resource_link.create":
            assert arguments["sourceUri"] == self.analysis_run_uri
            assert arguments["targetUri"] == (
                "waypoint://workflow/ncbi-derivative-design"
            )
            self.resource_link_uri = "waypoint://resource-link/link-1"
            return self._tool_result(
                name,
                {
                    "resourceUri": self.resource_link_uri,
                    "resourceLinkId": "link-1",
                },
            )
        raise AssertionError(f"unexpected tool call: {name}")

    def _tool_result(self, name: str, result: dict[str, Any]) -> dict[str, Any]:
        return {
            "isError": False,
            "structuredContent": {"ok": True, **result},
            "_meta": {
                "com.dnaforge/job": {
                    "jobId": f"job-{len(self.tool_calls)}",
                    "toolName": name,
                    "status": "completed",
                    "pool": "cpu_fast",
                }
            },
        }

    def _resource_content(self, uri: str) -> dict[str, Any]:
        resources = {
            "waypoint://agent/status": {
                "exists": True,
                "resourceUri": "waypoint://agent/status",
                "caller": {
                    "agentIdentityId": "smoke-agent",
                    "capabilities": ["read-workspace", "write-workspace"],
                },
                "latestResources": {
                    "artifact": self._latest("artifact", self.artifact_uri),
                    "analysisRun": self._latest("analysisRun", self.analysis_run_uri),
                    "resourceLink": self._latest(
                        "resourceLink", self.resource_link_uri
                    ),
                },
            },
            "waypoint://workflow/manifest": {
                "exists": True,
                "resourceUri": "waypoint://workflow/manifest",
                "manifest": {
                    "workflows": [
                        {"id": "ncbi-derivative-design"},
                        {"id": "mini-derivative-design"},
                    ]
                },
            },
        }
        if uri == self.artifact_uri:
            resources[uri] = {
                "exists": True,
                "resourceUri": uri,
                "artifact": {"name": "Connection smoke output"},
            }
        if uri == self.analysis_run_uri:
            resources[uri] = {
                "exists": True,
                "resourceUri": uri,
                "analysisRun": {
                    "outputs": [{"resourceUri": self.artifact_uri}],
                },
            }
        if uri == self.resource_link_uri:
            resources[uri] = {
                "exists": True,
                "resourceUri": uri,
                "resourceLink": {"sourceUri": self.analysis_run_uri},
            }
        if uri not in resources:
            raise AssertionError(f"unexpected resource read: {uri}")
        return {
            "uri": uri,
            "mimeType": "application/json",
            "text": json.dumps(resources[uri], sort_keys=True),
        }

    def _latest(self, name: str, uri: str | None) -> dict[str, str] | None:
        if uri is None:
            return None
        return {"name": name, "resourceUri": uri}
