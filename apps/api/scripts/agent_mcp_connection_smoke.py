#!/usr/bin/env python3
"""Minimal agent-facing MCP connection smoke test.

This script assumes the DNAForge sidecar is already running. It connects through
the same stdio MCP companion an external agent would use, then performs the
smallest useful lifecycle:

1. list tools,
2. read agent status,
3. read the workflow manifest,
4. register a tiny artifact,
5. create an analysis run around that artifact,
6. link the run to a workflow, and
7. read the created resources back through MCP.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from src.agent_workflow_harness.mcp_calls import (
    mcp_tool_job_metadata,
    require_mcp_tool_success,
)

try:
    from scripts.mcp_stdio_client import MCPStdioClient, start_mcp_companion
except ModuleNotFoundError:
    from mcp_stdio_client import MCPStdioClient, start_mcp_companion

DEFAULT_WORKFLOW_ID = "ncbi-derivative-design"


class ConnectionSmokeFailure(RuntimeError):
    pass


@dataclass
class ConnectionSmokeConfig:
    api_url: str
    session_token: str
    agent_identity: str
    agent_capabilities: list[str]
    workflow_id: str
    output_dir: Path
    timeout_seconds: float


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--api-url",
        default=os.environ.get("DNAFORGE_API_URL", "http://127.0.0.1:8000"),
    )
    parser.add_argument(
        "--session-token",
        default=os.environ.get("DNAFORGE_MCP_SESSION_TOKEN", ""),
    )
    parser.add_argument("--agent-identity", default="agent-connection-smoke")
    parser.add_argument(
        "--agent-capabilities",
        default="read-workspace,write-workspace",
        help="Comma-separated capabilities forwarded to the sidecar.",
    )
    parser.add_argument("--workflow", default=DEFAULT_WORKFLOW_ID)
    parser.add_argument("--output-dir", type=Path, default=None)
    parser.add_argument("--timeout", type=float, default=20.0)
    args = parser.parse_args()

    output_dir = args.output_dir or Path(
        tempfile.mkdtemp(prefix="agent-mcp-connection-smoke-")
    )
    config = ConnectionSmokeConfig(
        api_url=args.api_url,
        session_token=args.session_token,
        agent_identity=args.agent_identity,
        agent_capabilities=parse_capabilities(args.agent_capabilities),
        workflow_id=args.workflow,
        output_dir=output_dir,
        timeout_seconds=args.timeout,
    )

    try:
        summary = run_connection_smoke(config)
    except (ConnectionSmokeFailure, OSError, subprocess.SubprocessError) as exc:
        print(f"[agent-mcp-connection-smoke] FAIL: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0 if summary.get("ok") is True else 1


def parse_capabilities(raw: str) -> list[str]:
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        parsed = raw
    if isinstance(parsed, list):
        return [str(item).strip() for item in parsed if str(item).strip()]
    return [item.strip() for item in str(parsed).split(",") if item.strip()]


def run_connection_smoke(config: ConnectionSmokeConfig) -> dict[str, Any]:
    if not config.session_token:
        raise ConnectionSmokeFailure(
            "DNAFORGE_MCP_SESSION_TOKEN is required. Start/connect to a sidecar "
            "first, or pass --session-token."
        )

    config.output_dir.mkdir(parents=True, exist_ok=True)
    companion_proc = start_mcp_companion(
        api_url=config.api_url,
        session_token=config.session_token,
        agent_identity=config.agent_identity,
        capabilities=config.agent_capabilities,
        stderr_log=config.output_dir / "mcp-companion.log",
    )
    try:
        client = MCPStdioClient(companion_proc, timeout=config.timeout_seconds)
        return run_connection_smoke_with_client(client, config)
    finally:
        terminate_process(companion_proc)


def run_connection_smoke_with_client(
    client: Any,
    config: ConnectionSmokeConfig,
) -> dict[str, Any]:
    config.output_dir.mkdir(parents=True, exist_ok=True)
    checks: list[dict[str, Any]] = []

    initialize = client.request(
        "initialize",
        {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "agent-mcp-connection-smoke", "version": "0.1.0"},
        },
    )
    server_name = initialize.get("result", {}).get("serverInfo", {}).get("name")
    checks.append(check("initialize", server_name == "dnaforge-mcp", server_name))
    client.notify("notifications/initialized", {})

    tools = client.request("tools/list")["result"].get("tools", [])
    tool_names = sorted(
        tool["name"]
        for tool in tools
        if isinstance(tool, dict) and isinstance(tool.get("name"), str)
    )
    required_tools = [
        "artifact.register",
        "analysis_run.create",
        "resource_link.create",
    ]
    checks.append(
        check(
            "tools_available",
            all(name in tool_names for name in required_tools),
            {"required": required_tools, "available": tool_names},
        )
    )

    status_before = read_json_resource(client, "waypoint://agent/status")
    checks.append(
        check(
            "status_resource_readable",
            status_before.get("resourceUri") == "waypoint://agent/status",
            status_before.get("caller"),
        )
    )

    manifest = read_json_resource(client, "waypoint://workflow/manifest")
    workflow_ids = workflow_ids_from_manifest(manifest)
    checks.append(
        check(
            "workflow_manifest_readable",
            config.workflow_id in workflow_ids,
            {"workflowId": config.workflow_id, "workflowIds": workflow_ids},
        )
    )

    artifact_path = config.output_dir / "connection-smoke-output.tsv"
    artifact_path.write_text("gene\tcount\nlacZ\t12\n")
    artifact = call_tool(
        client,
        "artifact.register",
        {
            "kind": "file",
            "path": str(artifact_path),
            "name": "Connection smoke output",
            "description": "Temporary artifact produced by agent_mcp_connection_smoke.py.",
            "metadata": {"smoke": "connection"},
            "provenance": {
                "command": "write connection-smoke-output.tsv",
                "cwd": str(config.output_dir),
            },
            "tags": ["connection-smoke"],
        },
    )
    artifact_uri = require_string(artifact, "resourceUri", "artifact.register")
    artifact_resource = read_json_resource(client, artifact_uri)
    checks.append(
        check(
            "artifact_round_trip",
            artifact_resource.get("resourceUri") == artifact_uri,
            artifact_resource.get("artifact", {}).get("name"),
        )
    )

    analysis_run = call_tool(
        client,
        "analysis_run.create",
        {
            "name": "Connection smoke analysis run",
            "status": "completed",
            "command": ["python", "agent_mcp_connection_smoke.py"],
            "outputArtifacts": [artifact_uri],
            "metrics": {"outputFiles": 1},
            "metadata": {"smoke": "connection"},
        },
    )
    analysis_run_uri = require_string(
        analysis_run, "resourceUri", "analysis_run.create"
    )
    analysis_run_resource = read_json_resource(client, analysis_run_uri)
    outputs = analysis_run_resource.get("analysisRun", {}).get("outputs", [])
    checks.append(
        check(
            "analysis_run_round_trip",
            bool(outputs) and outputs[0].get("resourceUri") == artifact_uri,
            analysis_run_uri,
        )
    )

    resource_link = call_tool(
        client,
        "resource_link.create",
        {
            "sourceUri": analysis_run_uri,
            "targetUri": f"waypoint://workflow/{config.workflow_id}",
            "relationship": "implements_workflow",
            "metadata": {"smoke": "connection"},
        },
    )
    resource_link_uri = require_string(
        resource_link, "resourceUri", "resource_link.create"
    )
    resource_link_resource = read_json_resource(client, resource_link_uri)
    checks.append(
        check(
            "resource_link_round_trip",
            resource_link_resource.get("resourceLink", {}).get("sourceUri")
            == analysis_run_uri,
            resource_link_uri,
        )
    )

    status_after = read_json_resource(client, "waypoint://agent/status")
    latest = status_after.get("latestResources", {})
    checks.append(
        check(
            "status_reports_latest_resources",
            latest.get("artifact", {}).get("resourceUri") == artifact_uri
            and latest.get("analysisRun", {}).get("resourceUri") == analysis_run_uri
            and latest.get("resourceLink", {}).get("resourceUri") == resource_link_uri,
            latest,
        )
    )

    summary = {
        "ok": all(item["passed"] for item in checks),
        "status": "passed" if all(item["passed"] for item in checks) else "failed",
        "outputDir": str(config.output_dir),
        "apiUrl": config.api_url,
        "agentIdentity": config.agent_identity,
        "workflowId": config.workflow_id,
        "resources": {
            "status": "waypoint://agent/status",
            "artifact": artifact_uri,
            "analysisRun": analysis_run_uri,
            "resourceLink": resource_link_uri,
        },
        "checks": checks,
    }
    summary_path = config.output_dir / "connection-smoke-summary.json"
    summary["summaryPath"] = str(summary_path)
    summary_path.write_text(json.dumps(summary, indent=2, sort_keys=True))
    return summary


def call_tool(client: Any, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    response = client.request(
        "tools/call",
        {"name": name, "arguments": arguments},
    )
    tool_result = response.get("result")
    structured = require_mcp_tool_success(
        tool_result,
        name=name,
        failure_type=ConnectionSmokeFailure,
    )
    if structured.get("ok") is not True:
        raise ConnectionSmokeFailure(f"{name} did not complete: {structured}")
    job = mcp_tool_job_metadata(
        tool_result,
        name=name,
        failure_type=ConnectionSmokeFailure,
    )
    if (
        job.get("status") != "completed"
        or job.get("toolName") != name
        or not isinstance(job.get("jobId"), str)
        or not job["jobId"]
    ):
        raise ConnectionSmokeFailure(
            f"{name} returned invalid DNAForge job metadata: {job}"
        )
    return structured


def read_json_resource(client: Any, uri: str) -> dict[str, Any]:
    response = client.request("resources/read", {"uri": uri})
    result = response.get("result", {})
    contents = result.get("contents")
    if not isinstance(contents, list) or not contents:
        raise ConnectionSmokeFailure(f"resource read returned no contents: {uri}")
    text = contents[0].get("text") if isinstance(contents[0], dict) else None
    if not isinstance(text, str):
        raise ConnectionSmokeFailure(f"resource read returned non-text content: {uri}")
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise ConnectionSmokeFailure(
            f"resource read returned invalid JSON content: {uri}"
        ) from exc


def require_string(payload: dict[str, Any], key: str, context: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value:
        raise ConnectionSmokeFailure(f"{context} did not return {key}: {payload}")
    return value


def workflow_ids_from_manifest(resource: dict[str, Any]) -> list[str]:
    manifest = resource.get("manifest")
    workflows = manifest.get("workflows") if isinstance(manifest, dict) else []
    return [
        workflow["id"]
        for workflow in workflows
        if isinstance(workflow, dict) and isinstance(workflow.get("id"), str)
    ]


def check(name: str, passed: bool, evidence: Any) -> dict[str, Any]:
    return {"name": name, "passed": bool(passed), "evidence": evidence}


def terminate_process(process: subprocess.Popen[Any]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


if __name__ == "__main__":
    raise SystemExit(main())
