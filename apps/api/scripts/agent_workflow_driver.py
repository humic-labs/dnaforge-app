#!/usr/bin/env python3
"""Agent-facing  workflow driver.

This is the thin external loop an agent can use around the MCP server:

1. read the workflow manifest through MCP resources,
2. call the read-only workflow.prepare_run tool,
3. execute the prepared console command in a subprocess, and
4. read the latest workflow ledger back through MCP resources.

The driver intentionally keeps verification generic. It does not know how to
judge every biological output; it checks whether the declared workflow ran,
whether the command boundary worked, and whether the app-produced ledger agrees
with the workflow contract.
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
from typing import Any, Callable

from src.agent_workflow_harness.mcp_calls import (
    read_mcp_json_resource as read_mcp_json_resource_base,
)
from src.agent_workflow_harness.mcp_calls import (
    require_mcp_tool_success,
)

try:
    from scripts.agent_mcp_harness import terminate_process
    from scripts.mcp_stdio_client import MCPStdioClient, start_mcp_companion
except ModuleNotFoundError:
    from agent_mcp_harness import terminate_process
    from mcp_stdio_client import MCPStdioClient, start_mcp_companion


DEFAULT_WORKFLOW_ID = "ncbi-derivative-design"


class DriverFailure(RuntimeError):
    pass


@dataclass
class DriverConfig:
    workflow_id: str
    api_url: str
    session_token: str
    agent_identity: str
    agent_capabilities: list[str]
    build_desktop: bool
    workflow_timeout_seconds: int
    command_timeout_seconds: int
    output_dir: Path
    dry_run: bool = False


CommandRunner = Callable[
    [list[str], Path, int, Path, Path],
    subprocess.CompletedProcess[Any],
]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workflow", default=DEFAULT_WORKFLOW_ID)
    parser.add_argument(
        "--api-url",
        default=os.environ.get("DNAFORGE_API_URL", "http://127.0.0.1:8000"),
        help="Running DNAForge sidecar URL used by the MCP companion.",
    )
    parser.add_argument(
        "--session-token",
        default=os.environ.get("DNAFORGE_MCP_SESSION_TOKEN", ""),
        help="MCP session token for the running sidecar.",
    )
    parser.add_argument("--agent-identity", default="agent-workflow-driver")
    parser.add_argument(
        "--agent-capabilities",
        default="read-workspace",
        help="Comma-separated capabilities forwarded to the sidecar.",
    )
    parser.add_argument(
        "--build", action="store_true", help="Ask the console to build desktop first."
    )
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument(
        "--command-timeout",
        type=int,
        default=0,
        help="Subprocess timeout. Defaults to --timeout plus 60 seconds.",
    )
    parser.add_argument("--output-dir", type=Path, default=None)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Prepare and summarize the run without executing the console command.",
    )
    args = parser.parse_args()

    output_dir = args.output_dir or Path(
        tempfile.mkdtemp(prefix="agent-workflow-driver-")
    )
    config = DriverConfig(
        workflow_id=args.workflow,
        api_url=args.api_url,
        session_token=args.session_token,
        agent_identity=args.agent_identity,
        agent_capabilities=parse_capabilities(args.agent_capabilities),
        build_desktop=args.build,
        workflow_timeout_seconds=args.timeout,
        command_timeout_seconds=args.command_timeout or args.timeout + 60,
        output_dir=output_dir,
        dry_run=args.dry_run,
    )

    try:
        summary = run_driver(config)
    except (RuntimeError, OSError, subprocess.SubprocessError) as exc:
        print(f"[agent-workflow-driver] FAIL: {exc}", file=sys.stderr)
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


def run_driver(config: DriverConfig) -> dict[str, Any]:
    if not config.session_token:
        raise DriverFailure(
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
        client = MCPStdioClient(
            companion_proc, timeout=float(config.workflow_timeout_seconds)
        )
        return drive_workflow_with_client(client, config)
    finally:
        terminate_process(companion_proc)


def drive_workflow_with_client(
    client: Any,
    config: DriverConfig,
    *,
    command_runner: CommandRunner | None = None,
) -> dict[str, Any]:
    if command_runner is None:
        command_runner = run_prepared_command

    config.output_dir.mkdir(parents=True, exist_ok=True)
    initialize_mcp_client(client)

    manifest_resource = read_mcp_json_resource(client, "waypoint://workflow/manifest")
    workflow_ids = workflow_ids_from_manifest(manifest_resource)
    before_summary = read_mcp_json_resource(client, "waypoint://workflow-runs/summary")
    prepared = prepare_workflow_run(client, config)
    command = normalize_prepared_command(prepared)

    checks = [
        check(
            "manifest_has_workflow",
            config.workflow_id in workflow_ids,
            f"{config.workflow_id} present in workflow manifest",
        ),
        check(
            "prepare_returned_command",
            bool(command["argv"]) and command["cwd"].exists(),
            f"prepared cwd={command['cwd']}",
        ),
    ]

    summary: dict[str, Any] = {
        "ok": all(item["passed"] for item in checks),
        "status": "prepared",
        "workflowId": config.workflow_id,
        "outputDir": str(config.output_dir),
        "resources": prepared.get("resources", {}),
        "preparedCommand": {
            "cwd": str(command["cwd"]),
            "argv": command["argv"],
            "shell": prepared.get("command", {}).get("shell"),
        },
        "manifestWorkflowCount": len(workflow_ids),
        "beforeRunSummary": before_summary.get("summary"),
        "checks": checks,
    }
    summary_path = config.output_dir / "agent-workflow-driver-summary.json"

    if config.dry_run:
        write_summary(summary_path, summary)
        summary["summaryPath"] = str(summary_path)
        return summary

    execution = execute_prepared_command(
        command=command,
        config=config,
        command_runner=command_runner,
    )
    summary["status"] = "completed"
    summary["execution"] = execution
    checks.append(
        check(
            "command_exited_zero",
            execution["returncode"] == 0,
            f"returncode={execution['returncode']}",
        )
    )

    latest_resource_uri = str(
        prepared.get("resources", {}).get(
            "latestRun",
            f"waypoint://workflow-runs/latest/{config.workflow_id}",
        )
    )
    try:
        latest_resource = read_mcp_json_resource(client, latest_resource_uri)
        latest_error = None
    except DriverFailure as exc:
        latest_resource = None
        latest_error = str(exc)

    latest_summary = summarize_latest_run(config.workflow_id, latest_resource)
    summary["latestRun"] = latest_summary
    if latest_error:
        summary["latestRunError"] = latest_error

    checks.append(
        check(
            "latest_ledger_matches_workflow",
            latest_summary.get("matchesWorkflow") is True,
            f"latest resource={latest_resource_uri}",
        )
    )
    checks.append(
        check(
            "latest_ledger_reports_success",
            latest_summary.get("success") is True,
            f"outcome={latest_summary.get('outcome')}",
        )
    )
    summary["ok"] = all(item["passed"] for item in checks)
    if latest_summary.get("success") is True:
        summary["nextActions"] = []
    else:
        summary["nextActions"] = latest_summary.get("nextActions") or prepared.get(
            "operatorNotes", []
        )
    write_summary(summary_path, summary)
    summary["summaryPath"] = str(summary_path)
    return summary


def initialize_mcp_client(client: Any) -> None:
    response = client.request(
        "initialize",
        {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {
                "name": "agent-workflow-driver",
                "version": "0.1.0",
            },
        },
    )
    server_name = (
        response.get("result", {}).get("serverInfo", {}).get("name")
        if isinstance(response, dict)
        else None
    )
    if server_name != "dnaforge-mcp":
        raise DriverFailure(f"MCP companion did not initialize correctly: {response}")
    client.notify("notifications/initialized", {})


def prepare_workflow_run(client: Any, config: DriverConfig) -> dict[str, Any]:
    response = client.request(
        "tools/call",
        {
            "name": "workflow.prepare_run",
            "arguments": {
                "workflowId": config.workflow_id,
                "buildDesktop": config.build_desktop,
                "timeoutSeconds": config.workflow_timeout_seconds,
            },
        },
    )
    if "error" in response:
        raise DriverFailure(f"workflow.prepare_run returned JSON-RPC error: {response}")
    prepared = require_mcp_tool_success(
        response.get("result"),
        name="workflow.prepare_run",
        failure_type=DriverFailure,
    )
    if prepared.get("ok") is not True:
        raise DriverFailure(
            f"workflow.prepare_run returned invalid content: {response}"
        )
    if prepared.get("workflowId") != config.workflow_id:
        raise DriverFailure(
            f"workflow.prepare_run returned workflow {prepared.get('workflowId')}, "
            f"expected {config.workflow_id}"
        )
    return prepared


def normalize_prepared_command(prepared: dict[str, Any]) -> dict[str, Any]:
    command = prepared.get("command")
    if not isinstance(command, dict):
        raise DriverFailure(f"prepared workflow has no command object: {prepared}")
    argv = command.get("argv")
    cwd = command.get("cwd")
    if not isinstance(argv, list) or not all(isinstance(item, str) for item in argv):
        raise DriverFailure(f"prepared workflow command argv is invalid: {command}")
    if not isinstance(cwd, str) or not cwd:
        raise DriverFailure(f"prepared workflow command cwd is invalid: {command}")
    return {"argv": argv, "cwd": Path(cwd)}


def execute_prepared_command(
    *,
    command: dict[str, Any],
    config: DriverConfig,
    command_runner: CommandRunner,
) -> dict[str, Any]:
    stdout_path = config.output_dir / f"{config.workflow_id}-stdout.log"
    stderr_path = config.output_dir / f"{config.workflow_id}-stderr.log"
    completed = command_runner(
        command["argv"],
        command["cwd"],
        config.command_timeout_seconds,
        stdout_path,
        stderr_path,
    )
    return {
        "returncode": completed.returncode,
        "stdoutPath": str(stdout_path),
        "stderrPath": str(stderr_path),
        "timeoutSeconds": config.command_timeout_seconds,
    }


def run_prepared_command(
    argv: list[str],
    cwd: Path,
    timeout_seconds: int,
    stdout_path: Path,
    stderr_path: Path,
) -> subprocess.CompletedProcess[Any]:
    with (
        stdout_path.open("w", encoding="utf-8") as stdout,
        stderr_path.open("w", encoding="utf-8") as stderr,
    ):
        return subprocess.run(
            argv,
            cwd=cwd,
            timeout=timeout_seconds,
            stdout=stdout,
            stderr=stderr,
            text=True,
            check=False,
        )


def read_mcp_json_resource(client: Any, uri: str) -> dict[str, Any]:
    return read_mcp_json_resource_base(client, uri, failure_type=DriverFailure)


def workflow_ids_from_manifest(resource: dict[str, Any]) -> list[str]:
    manifest = resource.get("manifest")
    workflows = manifest.get("workflows") if isinstance(manifest, dict) else None
    if not isinstance(workflows, list):
        return []
    return [
        workflow.get("id")
        for workflow in workflows
        if isinstance(workflow, dict) and isinstance(workflow.get("id"), str)
    ]


def summarize_latest_run(
    workflow_id: str, resource: dict[str, Any] | None
) -> dict[str, Any]:
    if resource is None:
        return {
            "exists": False,
            "workflowId": workflow_id,
            "matchesWorkflow": False,
            "success": False,
            "outcome": None,
            "nextActions": [],
        }
    ledger = (
        resource.get("ledger") if isinstance(resource.get("ledger"), dict) else None
    )
    ledger_workflow = ledger.get("workflow") if isinstance(ledger, dict) else None
    ledger_workflow_id = (
        ledger_workflow.get("id") if isinstance(ledger_workflow, dict) else None
    )
    matches = (
        resource.get("workflowId") == workflow_id and ledger_workflow_id == workflow_id
    )
    metrics = ledger.get("metrics") if isinstance(ledger, dict) else {}
    next_actions = ledger.get("next_actions") if isinstance(ledger, dict) else []
    return {
        "exists": resource.get("exists") is True,
        "workflowId": resource.get("workflowId"),
        "ledgerPath": ledger.get("_path") if isinstance(ledger, dict) else None,
        "matchesWorkflow": matches,
        "success": (
            bool(ledger)
            and (ledger.get("success") is True or ledger.get("outcome") == "passed")
        ),
        "outcome": ledger.get("outcome") if isinstance(ledger, dict) else None,
        "classification": (
            ledger.get("classification") if isinstance(ledger, dict) else None
        ),
        "failedStage": ledger.get("failed_stage") if isinstance(ledger, dict) else None,
        "metrics": metrics if isinstance(metrics, dict) else {},
        "nextActions": next_actions if isinstance(next_actions, list) else [],
    }


def check(name: str, passed: bool, detail: str) -> dict[str, Any]:
    return {"name": name, "passed": bool(passed), "detail": detail}


def write_summary(path: Path, summary: dict[str, Any]) -> None:
    path.write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    raise SystemExit(main())
