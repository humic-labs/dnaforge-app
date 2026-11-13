"""Base MCP contract and security checks for the  harness."""

from __future__ import annotations

import hashlib
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from src.agent_workflow_harness.mcp_calls import (
    call_renderer_tool_with_evidence,
    mcp_tool_error,
    read_mcp_json_resource,
    require_mcp_tool_success,
)
from src.agent_workflow_harness.runtime import (
    HarnessFailure,
    default_mcp_grant_capabilities,
    read_renderer_calls,
    require,
)
from src.agent_workflow_harness.stdio_client import MCPStdioClient, start_mcp_companion

RETAINED_RENDERER_TOOLS = [
    "list_files",
    "read_file",
    "get_file_changes",
    "open_tab",
    "close_tab",
    "create_design",
    "add_design_region",
    "draft_design_assembly",
    "import_sequence",
    "create_reference",
    "find_features",
    "get_workspace",
    "observe_app_state",
    "get_design",
    "get_sequence",
    "get_sequence_changes",
    "lims_query_entities",
    "lims_get_entity",
    "lims_resolve_open_target",
    "lims_open_entity",
    "workspace.gitStatus",
    "external.fetch",
    "external.xref",
]


@dataclass(frozen=True)
class ContractSmokeResult:
    client: MCPStdioClient
    checks: list[str]
    tool_names: set[str]
    workflow_resource: dict[str, Any]
    workflow_prepare: dict[str, Any]
    artifact_register: dict[str, Any]
    analysis_run: dict[str, Any]
    resource_link: dict[str, Any]
    forwarded_scope: list[str]
    renderer_audit_id: str | None


def run_mcp_contract_smoke(
    *,
    api_url: str,
    mcp_token: str,
    renderer_token: str,
    renderer_call_log: Path | None,
    temp_dir: Path,
    processes: list[subprocess.Popen[Any]],
    timeout: float,
    client_class: type[MCPStdioClient] = MCPStdioClient,
) -> ContractSmokeResult:
    checks: list[str] = []
    contract_capabilities = default_mcp_grant_capabilities()

    companion_proc = start_mcp_companion(
        api_url=api_url,
        session_token=mcp_token,
        agent_identity="harness-agent",
        capabilities=contract_capabilities,
        stderr_log=temp_dir / "mcp-companion.log",
    )
    processes.append(companion_proc)
    client = client_class(companion_proc, timeout=timeout)
    initialize = client.request(
        "initialize",
        {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "dnaforge-agent-harness", "version": "0.1.0"},
        },
    )
    require(
        initialize["result"]["serverInfo"]["name"] == "dnaforge-mcp",
        "MCP companion did not initialize as dnaforge-mcp",
    )
    client.notify("notifications/initialized", {})
    checks.append("stdio MCP companion initializes with newline-delimited JSON-RPC")

    workflow_resource = check_resource_catalog(client)
    checks.extend(
        [
            "MCP resources/templates/list exposes open resource templates",
            "MCP resources/read exposes agent workflow contracts and ledger summary",
        ]
    )

    tool_names = check_tool_catalog(client)
    checks.append("MCP tools/list exposes renderer tools without legacy file tools")

    workflow_prepare = check_workflow_prepare(client)
    checks.append("MCP tools/call prepares workflow run commands")

    artifact_register, analysis_run, resource_link = check_artifact_resource_lifecycle(
        api_url=api_url,
        mcp_token=mcp_token,
        temp_dir=temp_dir,
        processes=processes,
        timeout=timeout,
        client_class=client_class,
    )
    checks.extend(
        [
            "MCP artifact.register persists readable artifact resources",
            "MCP analysis_run.create links artifacts into run records",
            "MCP resource_link.create connects run records to workflows",
        ]
    )

    forwarded_scope, renderer_audit_id = check_renderer_bridge(
        client=client,
        renderer_call_log=renderer_call_log,
        renderer_token=renderer_token,
        expected_scope=contract_capabilities,
    )
    checks.append("MCP tools/call reaches renderer bridge through companion")
    if renderer_call_log is not None:
        checks.append("renderer call carries session, action id, identity, and scope")
    else:
        checks.append("real desktop renderer bridge returns workspace state")

    return ContractSmokeResult(
        client=client,
        checks=checks,
        tool_names=tool_names,
        workflow_resource=workflow_resource,
        workflow_prepare=workflow_prepare,
        artifact_register=artifact_register,
        analysis_run=analysis_run,
        resource_link=resource_link,
        forwarded_scope=forwarded_scope,
        renderer_audit_id=renderer_audit_id,
    )


def check_resource_catalog(client: MCPStdioClient) -> dict[str, Any]:
    resource_template_response = client.request("resources/templates/list")
    require(
        "error" not in resource_template_response,
        f"MCP resources/templates/list returned JSON-RPC error: {resource_template_response}",
    )
    resource_templates = resource_template_response.get("result", {}).get(
        "resourceTemplates"
    )
    require(
        isinstance(resource_templates, list)
        and any(
            isinstance(template, dict)
            and template.get("uriTemplate") == "waypoint://design/{id}"
            for template in resource_templates
        ),
        f"MCP resource templates did not include design resources: {resource_templates}",
    )
    require(
        any(
            isinstance(template, dict)
            and template.get("uriTemplate") == "waypoint://sequence/{documentId}"
            for template in resource_templates
        ),
        f"MCP resource templates did not include sequence resources: {resource_templates}",
    )
    require(
        any(
            isinstance(template, dict)
            and template.get("uriTemplate") == "waypoint://workflow/{id}"
            for template in resource_templates
        ),
        f"MCP resource templates did not include workflow resources: {resource_templates}",
    )
    require(
        any(
            isinstance(template, dict)
            and template.get("uriTemplate") == "waypoint://artifact/{id}"
            for template in resource_templates
        ),
        f"MCP resource templates did not include artifact resources: {resource_templates}",
    )
    require(
        any(
            isinstance(template, dict)
            and template.get("uriTemplate") == "waypoint://analysis-run/{id}"
            for template in resource_templates
        ),
        f"MCP resource templates did not include analysis-run resources: {resource_templates}",
    )
    require(
        any(
            isinstance(template, dict)
            and template.get("uriTemplate") == "waypoint://resource-link/{id}"
            for template in resource_templates
        ),
        f"MCP resource templates did not include resource-link resources: {resource_templates}",
    )

    workflow_manifest_resource = read_mcp_json_resource(
        client, "waypoint://workflow/manifest"
    )
    workflow_manifest = workflow_manifest_resource.get("manifest")
    workflow_entries = (
        workflow_manifest.get("workflows")
        if isinstance(workflow_manifest, dict)
        else None
    )
    require(
        isinstance(workflow_entries, list) and workflow_entries,
        f"MCP workflow manifest resource was invalid: {workflow_manifest_resource}",
    )
    workflow_ids = [
        workflow.get("id")
        for workflow in workflow_entries
        if isinstance(workflow, dict) and isinstance(workflow.get("id"), str)
    ]
    require(
        "ncbi-derivative-design" in workflow_ids,
        f"MCP workflow manifest did not include ncbi-derivative-design: {workflow_ids}",
    )
    workflow_summary_resource = read_mcp_json_resource(
        client, "waypoint://workflow-runs/summary"
    )
    workflow_summary = workflow_summary_resource.get("summary")
    require(
        isinstance(workflow_summary, dict)
        and isinstance(workflow_summary.get("total_runs"), int),
        f"MCP workflow run summary resource was invalid: {workflow_summary_resource}",
    )
    return {
        "workflow_ids": workflow_ids,
        "manifest_workflow_count": len(workflow_entries),
        "ledger_summary_total_runs": workflow_summary.get("total_runs"),
    }


def check_tool_catalog(client: MCPStdioClient) -> set[str]:
    tools = client.request("tools/list")["result"]["tools"]
    tool_names = {tool["name"] for tool in tools}
    for renderer_tool in RETAINED_RENDERER_TOOLS:
        require(
            renderer_tool in tool_names,
            f"{renderer_tool} not registered",
        )
    require(
        "workflow.prepare_run" in tool_names,
        "workflow.prepare_run not registered",
    )
    require(
        "artifact.register" in tool_names,
        "artifact.register not registered",
    )
    require(
        "analysis_run.create" in tool_names,
        "analysis_run.create not registered",
    )
    require(
        "resource_link.create" in tool_names,
        "resource_link.create not registered",
    )
    return tool_names


def check_workflow_prepare(client: MCPStdioClient) -> dict[str, Any]:
    prepared_workflow = client.request(
        "tools/call",
        {
            "name": "workflow.prepare_run",
            "arguments": {
                "workflowId": "ncbi-derivative-design",
                "buildDesktop": False,
                "timeoutSeconds": 120,
            },
        },
    )
    prepared = require_mcp_tool_success(
        prepared_workflow.get("result"),
        name="workflow.prepare_run",
        failure_type=HarnessFailure,
    )
    require(
        isinstance(prepared, dict)
        and prepared.get("workflowId") == "ncbi-derivative-design",
        f"workflow.prepare_run returned invalid result: {prepared}",
    )
    prepared_command = prepared.get("command")
    require(
        isinstance(prepared_command, dict)
        and "--workflow" in prepared_command.get("argv", [])
        and "ncbi-derivative-design" in prepared_command.get("argv", []),
        f"workflow.prepare_run did not return a runnable command: {prepared}",
    )
    return {
        "workflow_id": prepared.get("workflowId"),
        "contract_resource": prepared.get("resources", {}).get("contract"),
        "latest_run_resource": prepared.get("resources", {}).get("latestRun"),
        "command_argv": prepared_command.get("argv"),
    }


def check_artifact_resource_lifecycle(
    *,
    api_url: str,
    mcp_token: str,
    temp_dir: Path,
    processes: list[subprocess.Popen[Any]],
    timeout: float,
    client_class: type[MCPStdioClient],
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    artifact_proc = start_mcp_companion(
        api_url=api_url,
        session_token=mcp_token,
        agent_identity="harness-artifact-agent",
        capabilities=["read-workspace", "write-workspace"],
        stderr_log=temp_dir / "mcp-companion-artifact.log",
    )
    processes.append(artifact_proc)
    artifact_client = client_class(artifact_proc, timeout=timeout)
    artifact_client.request("initialize", {"protocolVersion": "2024-11-05"})
    artifact_client.notify("notifications/initialized", {})
    artifact_path = temp_dir / "agent-output.tsv"
    artifact_path.write_text("gene\tcount\nlacZ\t12\n")
    artifact_register = artifact_client.request(
        "tools/call",
        {
            "name": "artifact.register",
            "arguments": {
                "kind": "file",
                "path": str(artifact_path),
                "name": "Harness output table",
                "description": "Temporary artifact produced by the MCP harness.",
                "metadata": {"assay": "mcp_contract_smoke"},
                "provenance": {
                    "command": "printf gene/count",
                    "cwd": str(temp_dir),
                },
                "tags": ["harness"],
            },
        },
    )
    registered_artifact = require_mcp_tool_success(
        artifact_register.get("result"),
        name="artifact.register",
        failure_type=HarnessFailure,
    )
    require(
        isinstance(registered_artifact, dict) and registered_artifact.get("ok") is True,
        f"artifact.register returned invalid result: {registered_artifact}",
    )
    artifact_uri = registered_artifact.get("resourceUri")
    require(
        isinstance(artifact_uri, str)
        and artifact_uri.startswith("waypoint://artifact/"),
        f"artifact.register did not return an artifact resource URI: {registered_artifact}",
    )
    artifact_resource = read_mcp_json_resource(artifact_client, artifact_uri)
    artifact_payload = artifact_resource.get("artifact")
    require(
        isinstance(artifact_payload, dict)
        and artifact_payload.get("resourceUri") == artifact_uri,
        f"artifact resource read did not match registration: {artifact_resource}",
    )
    expected_sha = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
    require(
        artifact_payload.get("sha256") == expected_sha,
        f"artifact resource did not record file sha256: {artifact_payload}",
    )
    artifact_evidence = {
        "resource_uri": artifact_uri,
        "name": artifact_payload.get("name"),
        "sha256": artifact_payload.get("sha256"),
        "size_bytes": artifact_payload.get("sizeBytes"),
        "metadata": artifact_payload.get("metadata"),
        "provenance_command": artifact_payload.get("provenance", {}).get("command"),
    }

    analysis_run_create = artifact_client.request(
        "tools/call",
        {
            "name": "analysis_run.create",
            "arguments": {
                "name": "Harness analysis run",
                "status": "completed",
                "command": ["python", "analyze.py"],
                "cwd": str(temp_dir),
                "outputArtifacts": [artifact_uri],
                "metrics": {"outputFiles": 1},
                "metadata": {"assay": "mcp_contract_smoke"},
            },
        },
    )
    registered_analysis_run = require_mcp_tool_success(
        analysis_run_create.get("result"),
        name="analysis_run.create",
        failure_type=HarnessFailure,
    )
    require(
        isinstance(registered_analysis_run, dict)
        and registered_analysis_run.get("ok") is True,
        f"analysis_run.create returned invalid result: {registered_analysis_run}",
    )
    analysis_run_uri = registered_analysis_run.get("resourceUri")
    require(
        isinstance(analysis_run_uri, str)
        and analysis_run_uri.startswith("waypoint://analysis-run/"),
        f"analysis_run.create did not return a resource URI: {registered_analysis_run}",
    )
    analysis_run_resource = read_mcp_json_resource(artifact_client, analysis_run_uri)
    analysis_run_payload = analysis_run_resource.get("analysisRun")
    require(
        isinstance(analysis_run_payload, dict)
        and analysis_run_payload.get("resourceUri") == analysis_run_uri,
        f"analysis-run resource read did not match registration: {analysis_run_resource}",
    )
    outputs = analysis_run_payload.get("outputs")
    require(
        isinstance(outputs, list)
        and outputs
        and outputs[0].get("resourceUri") == artifact_uri,
        f"analysis-run resource did not link artifact output: {analysis_run_payload}",
    )
    analysis_run_evidence = {
        "resource_uri": analysis_run_uri,
        "name": analysis_run_payload.get("name"),
        "status": analysis_run_payload.get("status"),
        "output_resource_uri": outputs[0].get("resourceUri"),
        "metrics": analysis_run_payload.get("metrics"),
    }

    resource_link_create = artifact_client.request(
        "tools/call",
        {
            "name": "resource_link.create",
            "arguments": {
                "sourceUri": analysis_run_uri,
                "targetUri": "waypoint://workflow/ncbi-derivative-design",
                "relationship": "implements_workflow",
                "metadata": {"assay": "mcp_contract_smoke"},
            },
        },
    )
    registered_resource_link = require_mcp_tool_success(
        resource_link_create.get("result"),
        name="resource_link.create",
        failure_type=HarnessFailure,
    )
    require(
        isinstance(registered_resource_link, dict)
        and registered_resource_link.get("ok") is True,
        f"resource_link.create returned invalid result: {registered_resource_link}",
    )
    resource_link_uri = registered_resource_link.get("resourceUri")
    require(
        isinstance(resource_link_uri, str)
        and resource_link_uri.startswith("waypoint://resource-link/"),
        f"resource_link.create did not return a resource URI: {registered_resource_link}",
    )
    resource_link_resource = read_mcp_json_resource(artifact_client, resource_link_uri)
    resource_link_payload = resource_link_resource.get("resourceLink")
    require(
        isinstance(resource_link_payload, dict)
        and resource_link_payload.get("resourceUri") == resource_link_uri,
        f"resource-link read did not match registration: {resource_link_resource}",
    )
    require(
        resource_link_payload.get("sourceUri") == analysis_run_uri,
        f"resource-link source did not match analysis run: {resource_link_payload}",
    )
    resource_link_evidence = {
        "resource_uri": resource_link_uri,
        "source_uri": resource_link_payload.get("sourceUri"),
        "target_uri": resource_link_payload.get("targetUri"),
        "relationship": resource_link_payload.get("relationship"),
    }
    return artifact_evidence, analysis_run_evidence, resource_link_evidence


def check_renderer_bridge(
    *,
    client: MCPStdioClient,
    renderer_call_log: Path | None,
    renderer_token: str,
    expected_scope: list[str],
) -> tuple[list[str], str | None]:
    renderer_result, renderer_payload, job = call_renderer_tool_with_evidence(
        client,
        "get_workspace",
        {},
        failure_type=HarnessFailure,
    )
    require(
        "panels" in renderer_result,
        "renderer result did not return workspace panel state",
    )
    action_id = job.get("jobId")
    require(
        isinstance(action_id, str) and bool(action_id),
        f"get_workspace did not return an action id in MCP metadata: {job}",
    )
    renderer_audit_id = renderer_payload.get("audit_id")
    require(
        isinstance(renderer_audit_id, str) and bool(renderer_audit_id),
        "renderer bridge did not return a renderer audit id",
    )

    action_resource = read_mcp_json_resource(
        client,
        f"waypoint://action/{action_id}",
        failure_type=HarnessFailure,
    )
    action = action_resource.get("action")
    audits = action_resource.get("auditRecords")
    action_result = action.get("result") if isinstance(action, dict) else None
    require(
        isinstance(action, dict)
        and action.get("id") == action_id
        and action.get("toolName") == "get_workspace",
        f"renderer call did not correlate to its action resource: {action_resource}",
    )
    require(
        isinstance(action_result, dict)
        and action_result.get("audit_id") == renderer_audit_id,
        f"renderer audit did not correlate to the action result: {action_resource}",
    )
    require(
        isinstance(audits, list)
        and bool(audits)
        and all(
            isinstance(audit, dict) and audit.get("actionId") == action_id
            for audit in audits
        ),
        f"action resource did not retain correlated audit evidence: {action_resource}",
    )

    if renderer_call_log is not None:
        calls_after_happy = read_renderer_calls(renderer_call_log)
        require(
            len(calls_after_happy) == 1,
            "expected one renderer call after happy path",
        )
        renderer_call = calls_after_happy[0]
        require(
            renderer_call["headers"]["x-dnaforge-session"] == renderer_token,
            "sidecar did not forward renderer session token",
        )
        require(
            renderer_call["headers"]["x-dnaforge-action-id"] == action_id
            and renderer_call["body"].get("action_id") == action_id,
            "sidecar did not correlate action id to renderer bridge",
        )
        require(
            sorted(
                json.loads(renderer_call["headers"]["x-dnaforge-agent-capabilities"])
            )
            == sorted(expected_scope),
            "sidecar did not forward caller scope",
        )
        forwarded_scope = json.loads(
            renderer_call["headers"]["x-dnaforge-agent-capabilities"]
        )
        return forwarded_scope, renderer_audit_id

    return [], renderer_audit_id


def run_mcp_security_rejection_checks(
    *,
    api_url: str,
    mcp_token: str,
    renderer_call_log: Path | None,
    temp_dir: Path,
    processes: list[subprocess.Popen[Any]],
    timeout: float,
    client_class: type[MCPStdioClient] = MCPStdioClient,
) -> list[str]:
    checks: list[str] = []

    denied_proc = start_mcp_companion(
        api_url=api_url,
        session_token=mcp_token,
        agent_identity="harness-agent",
        capabilities=["read-sequences"],
        stderr_log=temp_dir / "mcp-companion-denied.log",
    )
    processes.append(denied_proc)
    denied_client = client_class(denied_proc, timeout=timeout)
    denied_client.request("initialize", {"protocolVersion": "2024-11-05"})
    denied_client.notify("notifications/initialized", {})

    denied = denied_client.request("tools/call", {"name": "echo", "arguments": {}})
    denied_result = denied["result"]
    require(
        denied_result.get("isError") is True,
        "insufficient-scope call did not return MCP tool error",
    )
    denied_error = mcp_tool_error(
        denied_result,
        name="echo",
        failure_type=HarnessFailure,
    )
    require(
        denied_error.get("code") == "INSUFFICIENT_SCOPE",
        f"denied call did not return INSUFFICIENT_SCOPE: {denied_error}",
    )
    if renderer_call_log is not None:
        require(
            len(read_renderer_calls(renderer_call_log)) == 1,
            "insufficient-scope call reached renderer",
        )
    checks.append("insufficient scope is rejected before renderer dispatch")

    bad_session_proc = start_mcp_companion(
        api_url=api_url,
        session_token="wrong-token",
        agent_identity="harness-agent",
        capabilities=["read-workspace"],
        stderr_log=temp_dir / "mcp-companion-bad-session.log",
    )
    processes.append(bad_session_proc)
    bad_session_client = client_class(bad_session_proc, timeout=timeout)
    bad_session_client.request("initialize", {"protocolVersion": "2024-11-05"})
    bad_session_client.notify("notifications/initialized", {})
    bad_session = bad_session_client.request(
        "tools/call", {"name": "get_workspace", "arguments": {}}
    )
    bad_session_result = bad_session["result"]
    require(
        bad_session_result.get("isError") is True,
        "bad session did not return MCP tool error",
    )
    bad_session_error = mcp_tool_error(
        bad_session_result,
        name="get_workspace",
        failure_type=HarnessFailure,
    )
    require(
        bad_session_error.get("code") == "BAD_SESSION",
        f"bad session did not return BAD_SESSION: {bad_session_error}",
    )
    if renderer_call_log is not None:
        require(
            len(read_renderer_calls(renderer_call_log)) == 1,
            "bad MCP session reached renderer",
        )
    checks.append("bad MCP session is rejected before renderer dispatch")
    return checks
