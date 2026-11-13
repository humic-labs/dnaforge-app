#!/usr/bin/env python3
"""Interactive  desktop MCP console.

This is the manual feedback loop for the real app. It launches the packaged
test Electron app, connects the MCP stdio companion to the real sidecar and
renderer bridge, then lets a developer call MCP tools while watching the app
window change.

Usage:
    cd apps/api
    uv run python scripts/agent_mcp_console.py --build --demo
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote

from src.agent_workflows import (
    DEFAULT_RUNS_ROOT,
    build_workflow_contract,
    build_workflow_run_ledger,
    load_workflow_contracts,
    render_workflow_ledger_summary,
    summarize_workflow_run_metrics,
)
from src.agent_workflows import (
    dict_entries as _dict_entries,
)
from src.agent_workflow_harness.mcp_calls import call_renderer_tool_with_evidence

try:
    from scripts.agent_mcp_harness import (
        DESKTOP_BUILD_HINT,
        HarnessFailure,
        MCPStdioClient,
        create_desktop_git_workspace,
        find_free_port,
        node_tool_env,
        observe_desktop_ui,
        prepare_startup_fixtures,
        require,
        restore_desktop_build_env,
        start_desktop_app,
        start_mcp_companion,
        terminate_process,
        wait_for_health,
    )
except ModuleNotFoundError:
    from agent_mcp_harness import (
        DESKTOP_BUILD_HINT,
        HarnessFailure,
        MCPStdioClient,
        create_desktop_git_workspace,
        find_free_port,
        node_tool_env,
        observe_desktop_ui,
        prepare_startup_fixtures,
        require,
        restore_desktop_build_env,
        start_desktop_app,
        start_mcp_companion,
        terminate_process,
        wait_for_health,
    )


DEFAULT_SEQUENCE_PATH = "plasmids/pUC19.gb"
IMPORTED_SEQUENCE_PATH = "imports/pUC19-agent-import.gb"
NCBI_SMOKE_ACCESSION = "L09137"
NCBI_SMOKE_IMPORTED_SEQUENCE_PATH = "imports/L09137-ncbi-import.gb"
NCBI_SMOKE_LABEL = "Imported NCBI L09137"
NCBI_DERIVATIVE_IMPORTED_SEQUENCE_PATH = "imports/L09137-ncbi-design-source.gb"
NCBI_DERIVATIVE_LABEL = "NCBI L09137 design source"
DEFAULT_DESIGN_NAME = "Console derivative design"
NCBI_DERIVATIVE_DESIGN_NAME = "NCBI derivative design"
WORKFLOW_MINI_DERIVATIVE_DESIGN = "mini-derivative-design"
WORKFLOW_NCBI_IMPORT_SMOKE = "ncbi-import-smoke"
WORKFLOW_NCBI_DERIVATIVE_DESIGN = "ncbi-derivative-design"
WORKFLOW_CONTRACTS: dict[str, dict[str, Any]] = load_workflow_contracts()
CONSOLE_CAPABILITIES = [
    "read-workspace",
    "read-sequences",
    "modify-tabs",
    "create-entity",
]

HELP_TEXT = """Commands:
  help                         Show this help.
  tools                        List available MCP tools.
  workspace                    Inspect current app workspace state.
  resources                    List MCP resources for open tabs.
  read-resource <uri>          Read any MCP resource by URI.
  read-design [id-or-uri]      Read canonical design state through MCP resources.
  status                       Inspect git status for the test workspace.
  open                         Open the pUC19 sequence tab and leave it visible.
  import <source> [target]     Import a local GenBank/FASTA file into the workspace.
  close                        Close the focused tab.
  find <query>                 Search pUC19 features, for example: find AmpR promoter
  design mini                  Create a design, add two pUC19 regions, draft assembly.
  contract                     Show the workflow contract this console is proving.
  observe                      Observe the last design tab, or pUC19 if no design exists.
  observe <label>              Observe a visible tab label.
  call <tool> <json>           Call any MCP tool directly.
  quit                         Stop the app and exit.
"""


@dataclass
class ConsoleState:
    client: MCPStdioClient
    api_url: str
    renderer_port: int
    renderer_token: str
    transcript_path: Path
    echo_tools: bool = True
    last_design_id: str | None = None
    last_design_name: str | None = None
    tool_annotations: dict[str, dict[str, Any]] = field(default_factory=dict)
    command_lifecycle: list[dict[str, Any]] = field(default_factory=list)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--build",
        action="store_true",
        help="Build the desktop test bundle before launching the app.",
    )
    parser.add_argument(
        "--desktop-main",
        type=Path,
        default=None,
        help="Path to the built Electron main entry.",
    )
    parser.add_argument("--timeout", type=float, default=60.0)
    parser.add_argument(
        "--keep-artifacts",
        action="store_true",
        help="Keep the temporary workspace and Electron user data after exit.",
    )
    parser.add_argument(
        "--run-dir",
        type=Path,
        default=None,
        help="Directory for logs and transcript. Defaults to ~/.waypoint-test.",
    )
    parser.add_argument(
        "--once",
        default=None,
        help="Run one console command non-interactively, then exit.",
    )
    parser.add_argument(
        "--demo",
        action="store_true",
        help="Run the mini design workflow immediately, then keep the app open.",
    )
    parser.add_argument(
        "--workflow",
        choices=list(WORKFLOW_CONTRACTS.keys()),
        default=None,
        help="Run a named workflow, write a report, then exit.",
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=None,
        help="Markdown report path for --workflow. Defaults to the run directory.",
    )
    parser.add_argument(
        "--describe-workflow",
        choices=list(WORKFLOW_CONTRACTS.keys()),
        default=None,
        help="Print the workflow contract without launching Electron.",
    )
    parser.add_argument(
        "--summarize-workflows",
        action="store_true",
        help="Summarize prior workflow-ledger.json files without launching Electron.",
    )
    parser.add_argument(
        "--workflow-ledger-root",
        type=Path,
        default=None,
        help="Root directory or single workflow-ledger.json for --summarize-workflows.",
    )
    args = parser.parse_args()
    if args.workflow and (args.demo or args.once):
        parser.error("--workflow cannot be combined with --demo or --once")
    if args.describe_workflow and (args.workflow or args.demo or args.once):
        parser.error(
            "--describe-workflow cannot be combined with --workflow, --demo, or --once"
        )
    if args.summarize_workflows and (
        args.workflow or args.demo or args.once or args.describe_workflow
    ):
        parser.error(
            "--summarize-workflows cannot be combined with app-launching commands"
        )
    if args.describe_workflow:
        print(render_workflow_contract(args.describe_workflow))
        return 0
    if args.summarize_workflows:
        root = args.workflow_ledger_root or DEFAULT_RUNS_ROOT
        print(render_workflow_ledger_summary(root))
        return 0

    try:
        run_console(args)
    except (HarnessFailure, KeyboardInterrupt) as exc:
        if isinstance(exc, KeyboardInterrupt):
            print("\n[agent-mcp-console] interrupted")
        else:
            print(f"[agent-mcp-console] FAIL: {exc}", file=sys.stderr)
        return 1
    return 0


def run_console(args: argparse.Namespace) -> None:
    api_dir = Path(__file__).resolve().parents[1]
    desktop_dir = api_dir.parent / "desktop"
    repo_root = api_dir.parents[1]

    if args.build:
        build_desktop_test_bundle(desktop_dir)

    run_dir = args.run_dir or create_run_dir()
    run_dir.mkdir(parents=True, exist_ok=True)
    transcript_path = run_dir / "transcript.jsonl"

    api_port = find_free_port()
    renderer_port = find_free_port()
    mcp_token = "agent-console-mcp-session"
    renderer_token = "agent-console-renderer-session"
    db_path = run_dir / "control-plane.sqlite3"
    data_dir = run_dir / "data"
    binaries_dir = run_dir / "binaries"
    prepare_startup_fixtures(data_dir, binaries_dir)

    processes: list[subprocess.Popen[Any]] = []
    desktop_env_backup: tuple[Path, bytes | None] | None = None
    desktop_user_data_dir: Path | None = None
    desktop_workspace_dir: Path | None = None

    try:
        desktop_workspace_dir = create_desktop_git_workspace()
        desktop_proc, desktop_env_backup, desktop_user_data_dir = start_desktop_app(
            desktop_dir=desktop_dir,
            desktop_main=args.desktop_main,
            api_port=api_port,
            renderer_port=renderer_port,
            renderer_token=renderer_token,
            mcp_token=mcp_token,
            db_path=db_path,
            data_dir=data_dir,
            binaries_dir=binaries_dir,
            workspace_dir=desktop_workspace_dir,
            stdout_log=run_dir / "desktop.log",
        )
        processes.append(desktop_proc)

        api_url = f"http://127.0.0.1:{api_port}"
        wait_for_health(f"{api_url}/health", args.timeout)
        companion_proc = start_mcp_companion(
            api_url=api_url,
            session_token=mcp_token,
            agent_identity="agent-console-agent",
            capabilities=CONSOLE_CAPABILITIES,
            stderr_log=run_dir / "mcp-companion.log",
        )
        processes.append(companion_proc)
        client = MCPStdioClient(companion_proc, timeout=args.timeout)
        initialize = client.request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "agent-mcp-console", "version": "0.1.0"},
            },
        )
        require(
            initialize["result"]["serverInfo"]["name"] == "dnaforge-mcp",
            "MCP companion did not initialize as dnaforge-mcp",
        )
        client.notify("notifications/initialized", {})

        state = ConsoleState(
            client=client,
            api_url=api_url,
            renderer_port=renderer_port,
            renderer_token=renderer_token,
            transcript_path=transcript_path,
            echo_tools=args.workflow is None,
        )
        write_transcript(
            transcript_path,
            "session_start",
            {
                "repo_root": str(repo_root),
                "api_url": api_url,
                "workspace": str(desktop_workspace_dir),
                "run_dir": str(run_dir),
            },
        )

        print_intro(
            run_dir,
            transcript_path,
            desktop_workspace_dir,
            workflow_mode=args.workflow is not None,
        )
        if args.workflow:
            run_workflow_and_report(
                state,
                args.workflow,
                report_path=args.report or run_dir / "workflow-report.md",
                raise_on_failure=True,
            )
            return
        if args.demo:
            run_workflow_and_report(
                state,
                WORKFLOW_MINI_DERIVATIVE_DESIGN,
                report_path=run_dir / "workflow-report.md",
                raise_on_failure=True,
            )
            print_demo_next_steps()
        if args.once:
            handle_command(state, args.once, interactive=False)
            return

        while True:
            try:
                line = input("agent-mcp> ")
            except EOFError:
                print()
                break
            if not handle_command(state, line):
                break
    finally:
        for proc in reversed(processes):
            terminate_process(proc)
        if desktop_env_backup:
            restore_desktop_build_env(desktop_env_backup)
        if not args.keep_artifacts:
            if desktop_user_data_dir:
                shutil.rmtree(desktop_user_data_dir, ignore_errors=True)
            if desktop_workspace_dir:
                shutil.rmtree(desktop_workspace_dir, ignore_errors=True)


def create_run_dir() -> Path:
    stamp = datetime.now(tz=UTC).strftime("%Y%m%dT%H%M%SZ")
    return DEFAULT_RUNS_ROOT / stamp


def build_desktop_test_bundle(desktop_dir: Path) -> None:
    print("[agent-mcp-console] building desktop test bundle...")
    result = subprocess.run(
        [
            "pnpm",
            "--dir",
            str(desktop_dir),
            "exec",
            "electron-vite",
            "build",
            "--mode",
            "test",
        ],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env=node_tool_env(),
        check=False,
    )
    if result.returncode != 0:
        raise HarnessFailure(
            "desktop build failed\n"
            f"{result.stdout[-4000:]}\n"
            f"{DESKTOP_BUILD_HINT}"
        )


def print_intro(
    run_dir: Path,
    transcript_path: Path,
    workspace_dir: Path,
    *,
    workflow_mode: bool = False,
) -> None:
    if workflow_mode:
        print("\nDNA-82 MCP workflow runner is connected to the desktop runtime.")
    else:
        print("\nDNA-82 MCP console is connected to the visible desktop app.")
    print(f"Workspace: {workspace_dir}")
    print(f"Run logs:   {run_dir}")
    print(f"Transcript: {transcript_path}")
    if workflow_mode:
        print("\nNo visible app window is required for this mode.")
        print("The workflow report below is the feedback artifact.\n")
        return
    print("\nThe terminal is the remote control. The Electron app is the thing")
    print("being controlled; if you do not see it, switch to the app window.")
    print("\nTry: design mini")
    print("Then watch the app for the new design tab and drafted assembly state.")
    print("Type help for commands.\n")


def print_demo_next_steps() -> None:
    print("\nThe demo workflow has run, and the app should still be open.")
    print("Look for the tab named: Console derivative design")
    print("The terminal stays open so you can keep calling tools.")
    print("Try: observe")
    print("Type quit when you want to close the app.\n")


def handle_command(state: ConsoleState, line: str, *, interactive: bool = True) -> bool:
    line = line.strip()
    if not line:
        return True

    command, _, rest = line.partition(" ")
    command = command.lower()
    rest = rest.strip()

    try:
        if command in {"quit", "exit"}:
            return False
        if command == "help":
            print(HELP_TEXT)
            return True
        if command == "tools":
            list_tools(state)
            return True
        if command == "workspace":
            call_tool(state, "get_workspace", {})
            return True
        if command == "resources":
            list_resources(state)
            return True
        if command == "read-resource":
            read_resource_command(state, rest)
            return True
        if command in {"read-design", "design-state"}:
            read_design_resource_command(state, rest)
            return True
        if command == "status":
            call_tool(
                state,
                "workspace.gitStatus",
                {"includeLog": True, "includeDiff": True},
            )
            return True
        if command == "open":
            call_tool(
                state,
                "open_tab",
                {
                    "type": "sequence",
                    "entityId": DEFAULT_SEQUENCE_PATH,
                    "label": "pUC19",
                },
            )
            return True
        if command == "import":
            source_path, target_path = parse_import_command(rest)
            arguments: dict[str, Any] = {"sourcePath": source_path}
            if target_path:
                arguments["targetPath"] = target_path
            call_tool(state, "import_sequence", arguments)
            return True
        if command == "close":
            call_tool(state, "close_tab", {})
            return True
        if command == "find":
            query = rest or "AmpR promoter"
            call_tool(
                state, "find_features", {"path": DEFAULT_SEQUENCE_PATH, "query": query}
            )
            return True
        if command in {"design", "recipe"} and rest in {"mini", "mini-design"}:
            run_workflow_and_report(
                state,
                WORKFLOW_MINI_DERIVATIVE_DESIGN,
                report_path=state.transcript_path.with_name("workflow-report.md"),
                raise_on_failure=False,
            )
            return True
        if command in {"contract", "plan"}:
            workflow = rest or WORKFLOW_MINI_DERIVATIVE_DESIGN
            print(render_workflow_contract(workflow))
            return True
        if command == "observe":
            observe_label = rest or state.last_design_name or "pUC19"
            observe_current_ui(state, observe_label)
            return True
        if command == "call":
            tool_name, arguments = parse_call_command(rest)
            call_tool(state, tool_name, arguments)
            return True
    except (HarnessFailure, ValueError, KeyError) as exc:
        write_transcript(
            state.transcript_path, "command_error", {"line": line, "error": str(exc)}
        )
        if not interactive:
            raise
        print(f"Error: {exc}")
        return True

    if not interactive:
        raise ValueError(f"unknown command: {command}")
    print(f"Unknown command: {command}. Type help for commands.")
    return True


def parse_call_command(rest: str) -> tuple[str, dict[str, Any]]:
    tool_name, _, raw_arguments = rest.strip().partition(" ")
    if not tool_name:
        raise ValueError("usage: call <tool> <json>")
    arguments = parse_json_object(raw_arguments or "{}")
    return tool_name, arguments


def parse_import_command(rest: str) -> tuple[str, str | None]:
    parts = rest.split()
    if not parts:
        raise ValueError("usage: import <source> [target]")
    if len(parts) > 2:
        raise ValueError(
            "usage: import <source> [target]. Use call import_sequence {...} for paths with spaces."
        )
    return parts[0], parts[1] if len(parts) == 2 else None


def parse_json_object(raw: str) -> dict[str, Any]:
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON arguments: {exc.msg}") from exc
    if not isinstance(parsed, dict):
        raise ValueError("arguments must be a JSON object")
    return parsed


def ensure_tool_annotations(state: ConsoleState) -> dict[str, dict[str, Any]]:
    if state.tool_annotations:
        return state.tool_annotations

    try:
        response = state.client.request("tools/list")
        tools = response["result"]["tools"]
        if not isinstance(tools, list):
            raise HarnessFailure(f"tools/list returned invalid shape: {response}")
        annotations: dict[str, dict[str, Any]] = {}
        for tool in tools:
            if not isinstance(tool, dict):
                continue
            name = tool.get("name")
            raw_annotations = tool.get("annotations")
            if isinstance(name, str) and isinstance(raw_annotations, dict):
                annotations[name] = raw_annotations
        state.tool_annotations = annotations
        write_transcript(
            state.transcript_path,
            "tools_metadata",
            {"tools": sorted(annotations.keys())},
        )
    except Exception as exc:  # noqa: BLE001 - metadata must not block tool calls
        write_transcript(
            state.transcript_path,
            "tools_metadata_error",
            {"error": str(exc)},
        )
    return state.tool_annotations


def list_tools(state: ConsoleState) -> None:
    response = state.client.request("tools/list")
    tools = response["result"]["tools"]
    names = [tool["name"] for tool in tools]
    state.tool_annotations = {
        tool["name"]: tool.get("annotations", {})
        for tool in tools
        if isinstance(tool, dict) and isinstance(tool.get("name"), str)
    }
    write_transcript(state.transcript_path, "tools_list", {"tools": names})
    print("Available tools:")
    for name in names:
        print(f"  {name}")


def list_resources(state: ConsoleState) -> list[dict[str, Any]]:
    response = state.client.request("resources/list")
    if "error" in response:
        raise HarnessFailure(f"resources/list failed: {response['error']}")
    resources = response["result"].get("resources", [])
    if not isinstance(resources, list):
        raise HarnessFailure(f"resources/list returned invalid shape: {response}")
    write_transcript(state.transcript_path, "resources_list", {"resources": resources})
    print("Resources:")
    if not resources:
        print("  (none)")
        return resources
    for resource in resources:
        if not isinstance(resource, dict):
            continue
        print(f"  {resource.get('uri')} - {resource.get('name')}")
    return resources


def read_design_resource_command(
    state: ConsoleState, raw_design_id_or_uri: str
) -> dict[str, Any]:
    resource_uri = resolve_design_resource_uri(
        raw_design_id_or_uri, last_design_id=state.last_design_id
    )
    return read_resource_command(state, resource_uri)


def read_resource_command(state: ConsoleState, resource_uri: str) -> dict[str, Any]:
    resource_uri = resource_uri.strip()
    if not resource_uri:
        raise ValueError("usage: read-resource <waypoint://...>")
    response = state.client.request("resources/read", {"uri": resource_uri})
    if "error" in response:
        raise HarnessFailure(f"resources/read failed: {response['error']}")
    resource = parse_single_json_resource(response.get("result", {}), resource_uri)
    write_transcript(
        state.transcript_path,
        "resource_read",
        {"resourceUri": resource_uri, "resource": resource},
    )
    print_json_resource(resource)
    return resource


def resolve_design_resource_uri(
    raw_design_id_or_uri: str, *, last_design_id: str | None
) -> str:
    value = raw_design_id_or_uri.strip()
    if value.startswith("waypoint://"):
        return value
    if value:
        return design_resource_uri(value)
    if last_design_id:
        return design_resource_uri(last_design_id)
    raise ValueError("No design id is available. Run design mini or pass an id/URI.")


def print_json_resource(resource: dict[str, Any]) -> None:
    resource_uri = resource.get("resourceUri")
    if isinstance(resource_uri, str) and resource_uri.startswith("waypoint://action/"):
        print_action_resource(resource)
        return
    if isinstance(resource_uri, str) and resource_uri.startswith(
        "waypoint://sequence/"
    ):
        print_sequence_resource(resource)
        return
    if isinstance(resource_uri, str) and resource_uri.startswith(
        "waypoint://workflow/"
    ):
        print_workflow_resource(resource)
        return
    if isinstance(resource_uri, str) and resource_uri.startswith(
        "waypoint://workflow-runs/"
    ):
        print_workflow_run_resource(resource)
        return
    if isinstance(resource_uri, str) and resource_uri.startswith("waypoint://design/"):
        print_design_resource(resource)
        return
    print_generic_resource(resource)


def print_design_resource(resource: dict[str, Any]) -> None:
    if resource.get("exists") is not True:
        print(f"Design not found: {resource.get('error')}")
        return
    print(f"Design resource: {resource.get('name')} ({resource.get('designId')})")
    print(
        "State: "
        f"{resource.get('regionCount')} regions, "
        f"{resource.get('primerPairCount')} primer pairs, "
        f"assembly state {resource.get('assemblyState')}"
    )


def print_action_resource(resource: dict[str, Any]) -> None:
    if resource.get("exists") is not True:
        print(f"Action not found: {resource.get('error')}")
        return
    action = resource.get("action")
    if not isinstance(action, dict):
        print("Action resource returned no action details.")
        return
    audit_records = resource.get("auditRecords")
    audit_count = len(audit_records) if isinstance(audit_records, list) else 0
    print(f"Action resource: {action.get('toolName')} ({action.get('id')})")
    print(
        "State: "
        f"{action.get('authorizationState')}, "
        f"{audit_count} audit records, "
        f"completed {action.get('completedAt') or 'not completed'}"
    )


def print_sequence_resource(resource: dict[str, Any]) -> None:
    if resource.get("exists") is not True:
        print(f"Sequence not found: {resource.get('error')}")
        return
    print(f"Sequence resource: {resource.get('name')} ({resource.get('path')})")
    print(
        "State: "
        f"{resource.get('length')} bp, "
        f"{resource.get('featureCount')} features, "
        f"format {resource.get('format')}"
    )


def print_workflow_resource(resource: dict[str, Any]) -> None:
    if resource.get("exists") is not True:
        print(f"Workflow not found: {resource.get('error')}")
        return
    manifest = resource.get("manifest")
    if isinstance(manifest, dict):
        workflows = manifest.get("workflows")
        workflow_count = len(workflows) if isinstance(workflows, list) else 0
        print(f"Workflow manifest: {workflow_count} workflows")
        return
    workflow = resource.get("workflow")
    if not isinstance(workflow, dict):
        print_generic_resource(resource)
        return
    demand = workflow.get("demand") if isinstance(workflow.get("demand"), dict) else {}
    print(f"Workflow: {workflow.get('title') or workflow.get('id')}")
    print(
        "State: "
        f"id {workflow.get('id')}, "
        f"mode {workflow.get('mode')}, "
        f"demand {demand.get('level', 'unknown')}"
    )


def print_workflow_run_resource(resource: dict[str, Any]) -> None:
    if resource.get("exists") is not True:
        print(f"Workflow run not found: {resource.get('error')}")
        return
    summary = resource.get("summary")
    if isinstance(summary, dict):
        print(f"Workflow run summary: {summary.get('total_runs', 0)} runs")
        return
    ledger = resource.get("ledger")
    if isinstance(ledger, dict):
        workflow = (
            ledger.get("workflow") if isinstance(ledger.get("workflow"), dict) else {}
        )
        print(f"Workflow run: {workflow.get('id') or resource.get('workflowId')}")
        print(
            "State: "
            f"outcome {ledger.get('outcome')}, "
            f"classification {ledger.get('classification')}"
        )
        return
    print_generic_resource(resource)


def print_generic_resource(resource: dict[str, Any]) -> None:
    print(f"Resource: {resource.get('resourceUri', '(unknown URI)')}")
    print("State: JSON resource read through MCP resources/read")


def call_mcp_renderer_tool_with_sidecar(
    client: MCPStdioClient, name: str, arguments: dict[str, Any]
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    return call_renderer_tool_with_evidence(
        client,
        name,
        arguments,
        failure_type=HarnessFailure,
    )


def append_command_lifecycle(
    state: ConsoleState,
    entry: dict[str, Any],
) -> None:
    state.command_lifecycle.append(entry)
    write_transcript(state.transcript_path, "command_lifecycle", entry)


def build_command_lifecycle_entry(
    *,
    tool: str,
    arguments: dict[str, Any],
    status: str,
    elapsed_ms: int,
    started_at: str,
    result: dict[str, Any] | None = None,
    renderer: dict[str, Any] | None = None,
    job: dict[str, Any] | None = None,
    annotations: dict[str, Any] | None = None,
    error: str | None = None,
) -> dict[str, Any]:
    result = result or {}
    renderer = renderer or {}
    job = job or {}
    annotations = annotations or {}

    mutation = result.get("mutation")
    if not isinstance(mutation, dict):
        mutation = {}
    target = mutation.get("target")
    if not isinstance(target, dict):
        target = {}

    action_id = first_nonempty_string(job.get("jobId"))
    entry: dict[str, Any] = {
        "tool": tool,
        "status": status,
        "started_at": started_at,
        "elapsed_ms": elapsed_ms,
        "argument_keys": sorted(arguments.keys()),
        "action_id": action_id,
        "action_resource_uri": (
            f"waypoint://action/{quote(action_id, safe='')}" if action_id else None
        ),
        "sidecar_status": first_nonempty_string(job.get("status")),
        "pool": first_nonempty_string(job.get("pool")),
        "renderer_audit_id": first_nonempty_string(renderer.get("audit_id")),
        "cancelable": bool(annotations.get("cancelable", False)),
        "effects": annotations.get("effects", []),
        "summary": (
            summarize_tool_call(tool, arguments, result)
            if status == "completed"
            else f"Call to {tool} failed."
        ),
    }

    operation_id = first_nonempty_string(mutation.get("operationId"))
    resource_uri = first_nonempty_string(
        mutation.get("resourceUri"), result.get("resourceUri")
    )
    if operation_id or resource_uri or target:
        entry["mutation"] = {
            "operation_id": operation_id,
            "effect": first_nonempty_string(mutation.get("effect")),
            "resource_uri": resource_uri,
            "target": {
                "type": first_nonempty_string(target.get("type")),
                "id": first_nonempty_string(target.get("id")),
            },
            "before_version": mutation.get("beforeVersion"),
            "after_version": mutation.get("afterVersion"),
        }
    if error:
        entry["error"] = error
    return entry


def first_nonempty_string(*values: Any) -> str | None:
    for value in values:
        if isinstance(value, str) and value:
            return value
    return None


def summarize_tool_call(
    tool: str, arguments: dict[str, Any], result: dict[str, Any]
) -> str:
    if tool == "import_sequence":
        source = summarize_import_source(arguments)
        target = result.get("path") or arguments.get("targetPath")
        if target:
            return f"Imported {source} into {target}."
        return f"Imported {source}."
    if tool == "create_design":
        name = result.get("name") or arguments.get("name")
        design_id = result.get("designId")
        if design_id:
            return f'Created design "{name}" ({design_id}).'
        return f'Created design "{name}".'
    if tool == "find_features":
        return (
            f'Found {result.get("matchCount", 0)} matches for '
            f'"{arguments.get("query")}" in {arguments.get("path")}.'
        )
    if tool == "plan_design_regions":
        return (
            f"Planned {result.get('regionCount', 0)} design regions from "
            f"{arguments.get('path')}."
        )
    if tool == "add_design_region":
        label = arguments.get("label") or result.get("label") or "region"
        return (
            f'Added "{label}" to design {arguments.get("designId")}; '
            f"region count is now {result.get('regionCount')}."
        )
    if tool == "draft_design_assembly":
        return (
            f"Drafted assembly for {arguments.get('designId')}; "
            f"state is {result.get('assemblyState')} with "
            f"{result.get('primerPairCount')} primer pairs."
        )
    if tool == "open_tab":
        return (
            f"Opened {arguments.get('type', 'tab')} tab "
            f"{arguments.get('label') or arguments.get('entityId')}."
        )
    if tool == "close_tab":
        return "Closed the focused tab."
    if tool == "get_workspace":
        return "Read the current workspace state."
    return f"Called {tool}."


def summarize_import_source(arguments: dict[str, Any]) -> str:
    source = arguments.get("source")
    if isinstance(source, dict):
        kind = source.get("kind")
        if kind == "ncbi":
            accession = source.get("accession")
            return f"NCBI {accession}" if accession else "NCBI sequence"
        if kind == "local_file":
            path = source.get("path")
            return str(path) if path else "local file"
        if kind == "addgene":
            plasmid_id = source.get("plasmidId")
            return f"Addgene {plasmid_id}" if plasmid_id else "Addgene plasmid"
        if kind == "url":
            url = source.get("url")
            return str(url) if url else "URL sequence"
    return str(arguments.get("sourcePath") or "sequence")


def format_command_lifecycle_line(entry: dict[str, Any]) -> str:
    details = [
        f"{entry.get('status', 'unknown')}: {entry.get('tool')}",
        f"{entry.get('elapsed_ms')} ms",
    ]
    for label, key in (
        ("action", "action_id"),
        ("audit", "renderer_audit_id"),
        ("pool", "pool"),
    ):
        value = entry.get(key)
        if isinstance(value, str) and value:
            details.append(f"{label}={value}")
    details.append(f"cancelable={entry.get('cancelable') is True}")

    mutation = entry.get("mutation")
    if isinstance(mutation, dict):
        resource_uri = mutation.get("resource_uri")
        if isinstance(resource_uri, str) and resource_uri:
            details.append(f"target={resource_uri}")

    summary = entry.get("summary")
    if isinstance(summary, str) and summary:
        details.append(summary)
    error = entry.get("error")
    if isinstance(error, str) and error:
        details.append(f"error={error}")
    return "- " + " - ".join(details)


def call_tool(
    state: ConsoleState,
    name: str,
    arguments: dict[str, Any],
) -> dict[str, Any]:
    write_transcript(
        state.transcript_path,
        "tool_call",
        {"tool": name, "arguments": arguments},
    )
    started = time.monotonic()
    started_at = datetime.now(tz=UTC).isoformat()
    annotations = ensure_tool_annotations(state).get(name, {})
    try:
        result, renderer, job = call_mcp_renderer_tool_with_sidecar(
            state.client, name, arguments
        )
    except Exception as exc:
        append_command_lifecycle(
            state,
            build_command_lifecycle_entry(
                tool=name,
                arguments=arguments,
                status="failed",
                elapsed_ms=round((time.monotonic() - started) * 1000),
                started_at=started_at,
                annotations=annotations,
                error=str(exc),
            ),
        )
        raise

    entry = build_command_lifecycle_entry(
        tool=name,
        arguments=arguments,
        status="completed",
        elapsed_ms=round((time.monotonic() - started) * 1000),
        started_at=started_at,
        result=result,
        renderer=renderer,
        job=job,
        annotations=annotations,
    )
    append_command_lifecycle(state, entry)
    write_transcript(
        state.transcript_path,
        "tool_result",
        {
            "tool": name,
            "ok": True,
            "elapsed_ms": entry["elapsed_ms"],
            "action_id": entry.get("action_id"),
            "renderer_audit_id": entry.get("renderer_audit_id"),
            "result": result,
        },
    )
    if state.echo_tools:
        print_compact_result(name, result)
        print_command_lifecycle_hint(entry)
    return result


def run_workflow_and_report(
    state: ConsoleState,
    workflow: str,
    *,
    report_path: Path,
    raise_on_failure: bool,
) -> dict[str, Any]:
    if workflow == WORKFLOW_MINI_DERIVATIVE_DESIGN:
        report = run_mini_derivative_design_workflow(state)
    elif workflow == WORKFLOW_NCBI_IMPORT_SMOKE:
        report = run_ncbi_import_smoke_workflow(state)
    elif workflow == WORKFLOW_NCBI_DERIVATIVE_DESIGN:
        report = run_ncbi_derivative_design_workflow(state)
    else:
        raise HarnessFailure(f"unknown workflow: {workflow}")
    report["workflow_contract"] = build_workflow_contract(workflow)
    report["transcript_path"] = str(state.transcript_path)
    report["report_path"] = str(report_path)
    report["workflow_ledger_path"] = str(report_path.with_name("workflow-ledger.json"))
    markdown = render_workflow_report(report)
    workflow_run_ledger = build_workflow_run_ledger(report)
    report["workflow_run_ledger"] = workflow_run_ledger
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(markdown)
    Path(report["workflow_ledger_path"]).write_text(
        json.dumps(workflow_run_ledger, indent=2, sort_keys=True) + "\n"
    )
    write_transcript(state.transcript_path, "workflow_run_ledger", workflow_run_ledger)
    write_transcript(state.transcript_path, "workflow_report", report)
    print(markdown)

    if raise_on_failure and report["outcome"] != "passed":
        raise HarnessFailure(
            f"{workflow} failed: {report['classification']} at {report['failed_stage']}"
        )
    return report


def run_mini_derivative_design_workflow(state: ConsoleState) -> dict[str, Any]:
    steps: list[dict[str, Any]] = []
    ledger: list[dict[str, Any]] = []
    started = datetime.now(tz=UTC)
    design_name = DEFAULT_DESIGN_NAME
    current_stage = "import_sequence"
    source_path = IMPORTED_SEQUENCE_PATH
    try:
        import_result = call_tool(
            state,
            "import_sequence",
            {
                "sourcePath": DEFAULT_SEQUENCE_PATH,
                "targetPath": IMPORTED_SEQUENCE_PATH,
                "label": "Imported pUC19",
                "overwrite": True,
            },
        )
        if import_result.get("imported") is not True:
            raise_workflow_failure(
                "import_sequence",
                "sequence_import_failed",
                f"import_sequence did not import the source sequence: {import_result}",
            )
        resource_uri = import_result.get("resourceUri")
        if not isinstance(resource_uri, str) or not resource_uri.startswith(
            "waypoint://sequence/"
        ):
            raise_workflow_failure(
                "import_sequence",
                "sequence_import_failed",
                f"import_sequence did not return a sequence resource URI: {import_result}",
            )
        source_path = str(import_result.get("path") or IMPORTED_SEQUENCE_PATH)
        sequence_snapshot = read_sequence_resource_snapshot(
            state, resource_uri=resource_uri
        )
        if sequence_snapshot.get("exists") is not True:
            raise_workflow_failure(
                "read_sequence_resource",
                "resource_read_failed",
                f"Imported sequence resource was not readable: {sequence_snapshot}",
            )
        steps.append(
            {
                "stage": "import_sequence",
                "status": "passed",
                "summary": "Imported the pUC19 source fixture into the workspace.",
                "evidence": {
                    "source_path": DEFAULT_SEQUENCE_PATH,
                    "imported_path": source_path,
                    "resource_uri": resource_uri,
                    "opened": import_result.get("opened"),
                    "length": sequence_snapshot.get("length"),
                    "feature_count": sequence_snapshot.get("featureCount"),
                },
            }
        )

        current_stage = "observe_imported_sequence_render"
        sequence_render_observation = wait_for_sequence_render_observation(
            state,
            label="Imported pUC19",
            expected_length=(
                sequence_snapshot.get("length")
                if isinstance(sequence_snapshot.get("length"), int)
                else None
            ),
            expected_feature_count=(
                sequence_snapshot.get("featureCount")
                if isinstance(sequence_snapshot.get("featureCount"), int)
                else None
            ),
        )
        steps.append(
            {
                "stage": "observe_imported_sequence_render",
                "status": "passed",
                "summary": "Observed the imported sequence tab render in the app.",
                "evidence": summarize_sequence_render_observation(
                    sequence_render_observation
                ),
            }
        )

        current_stage = "create_design"
        create_result = call_tool(
            state,
            "create_design",
            {"name": design_name, "assemblyMethod": "gibson"},
        )
        design_id = create_result.get("designId")
        if not isinstance(design_id, str) or not design_id:
            raise_workflow_failure(
                "create_design",
                "design_create_failed",
                f"create_design did not return a design id: {create_result}",
            )
        state.last_design_id = design_id
        state.last_design_name = design_name
        create_verdict = verify_design_mutation_claim(
            state,
            create_result,
            expected_effect="created_design",
            expected={
                "name": design_name,
                "assemblyMethod": "gibson",
                "regionCount": 0,
            },
        )
        ledger.append(create_verdict)
        require_ledger_verdict(create_verdict, stage="create_design")
        steps.append(
            {
                "stage": "create_design",
                "status": "passed",
                "summary": f'Created design "{design_name}".',
                "evidence": {
                    "design_id": design_id,
                    "opened": create_result.get("opened"),
                    "assembly_method": create_result.get("assemblyMethod"),
                },
            }
        )

        added_regions: list[dict[str, Any]] = []
        for expected_region_count, query in enumerate(
            ("AmpR promoter", "lacZ-alpha"), start=1
        ):
            current_stage = "find_feature"
            search_result = call_tool(
                state,
                "find_features",
                {"path": source_path, "query": query},
            )
            feature = first_feature_with_coordinates(search_result, query)
            steps.append(
                {
                    "stage": "find_feature",
                    "status": "passed",
                    "summary": f'Found source feature "{feature.get("name", query)}".',
                    "evidence": {
                        "query": query,
                        "match_count": search_result.get("matchCount"),
                        "feature": {
                            "name": feature.get("name"),
                            "start": feature.get("start"),
                            "end": feature.get("end"),
                        },
                    },
                }
            )
            current_stage = "add_design_region"
            add_result = call_tool(
                state,
                "add_design_region",
                {
                    "designId": design_id,
                    "path": source_path,
                    "start": feature["start"],
                    "end": feature["end"],
                    "label": feature.get("name", query),
                },
            )
            if add_result.get("regionCount") != expected_region_count:
                raise_workflow_failure(
                    "add_design_region",
                    "region_add_failed",
                    (
                        "add_design_region did not return the expected region "
                        f"count {expected_region_count}: {add_result}"
                    ),
                )
            add_verdict = verify_design_mutation_claim(
                state,
                add_result,
                expected_effect="added_design_region",
                expected={
                    "regionCount": expected_region_count,
                    "regionId": add_result.get("regionId"),
                    "length": add_result.get("length"),
                },
            )
            ledger.append(add_verdict)
            require_ledger_verdict(add_verdict, stage="add_design_region")
            added_regions.append(add_result)
            steps.append(
                {
                    "stage": "add_design_region",
                    "status": "passed",
                    "summary": (
                        f'Added "{feature.get("name", query)}" to the design '
                        f"as region {expected_region_count}."
                    ),
                    "evidence": {
                        "region_id": add_result.get("regionId"),
                        "length": add_result.get("length"),
                        "region_count": add_result.get("regionCount"),
                    },
                }
            )

        current_stage = "draft_design_assembly"
        draft_result = call_tool(
            state, "draft_design_assembly", {"designId": design_id}
        )
        if draft_result.get("validationErrorCount", 0) > 0:
            raise_workflow_failure(
                "draft_design_assembly",
                "assembly_validation_failed",
                f"draft_design_assembly reported validation errors: {draft_result}",
            )
        if (
            draft_result.get("assemblyState") != "ready"
            or draft_result.get("primerPairCount", 0) <= 0
        ):
            raise_workflow_failure(
                "draft_design_assembly",
                "assembly_draft_failed",
                f"draft_design_assembly did not produce a ready draft: {draft_result}",
            )
        draft_verdict = verify_design_mutation_claim(
            state,
            draft_result,
            expected_effect="drafted_design_assembly",
            expected={
                "assemblyState": "ready",
                "regionCount": 2,
                "validationErrorCount": 0,
                "primerPairCountMin": 1,
            },
        )
        ledger.append(draft_verdict)
        require_ledger_verdict(draft_verdict, stage="draft_design_assembly")
        steps.append(
            {
                "stage": "draft_design_assembly",
                "status": "passed",
                "summary": "Drafted assembly primers and junctions.",
                "evidence": {
                    "assembly_state": draft_result.get("assemblyState"),
                    "primer_pair_count": draft_result.get("primerPairCount"),
                    "homology_region_count": draft_result.get("homologyRegionCount"),
                    "validation_error_count": draft_result.get("validationErrorCount"),
                },
            }
        )

        current_stage = "observe_design_state"
        observation = observe_current_ui(state, design_name)
        design_state = observation.get("designState")
        if not isinstance(design_state, dict):
            raise_workflow_failure(
                "observe_design_state",
                "observer_gap",
                f"observer did not return design state: {observation}",
            )
        if (
            design_state.get("regionCount") != 2
            or design_state.get("assemblyState") != "ready"
            or design_state.get("primerPairCount", 0) <= 0
        ):
            raise_workflow_failure(
                "observe_design_state",
                "design_not_observable",
                f"observed design state did not match the workflow result: {design_state}",
            )
        steps.append(
            {
                "stage": "observe_design_state",
                "status": "passed",
                "summary": "Observed the resulting design state through the app bridge.",
                "evidence": {
                    "dom_visible": observation.get("target", {}).get("domVisible"),
                    "store_present": observation.get("target", {}).get("storePresent"),
                    "region_count": design_state.get("regionCount"),
                    "assembly_state": design_state.get("assemblyState"),
                    "primer_pair_count": design_state.get("primerPairCount"),
                    "validation_error_count": design_state.get("validationErrorCount"),
                },
            }
        )

        current_stage = "verify_action_resources"
        action_resource_summary = verify_command_lifecycle_resources(state)
        steps.append(
            {
                "stage": "verify_action_resources",
                "status": "passed",
                "summary": "Verified command action resources through MCP.",
                "evidence": action_resource_summary,
            }
        )

        return {
            "workflow": WORKFLOW_MINI_DERIVATIVE_DESIGN,
            "outcome": "passed",
            "classification": "passed",
            "failed_stage": None,
            "summary": (
                "Imported pUC19 into the workspace, created a derivative design, "
                "added AmpR promoter and lacZ-alpha regions, drafted assembly, "
                "and observed the ready design state through the app bridge."
            ),
            "duration_ms": elapsed_ms(started),
            "design": {
                "id": design_id,
                "name": design_name,
                "source_path": source_path,
                "regions_added": len(added_regions),
            },
            "ledger": ledger,
            "steps": steps,
            "command_lifecycle": state.command_lifecycle,
            "next_actions": [
                "Use this report to judge whether the workflow vocabulary is useful.",
                "If it is not useful enough, tighten the MCP tool names, arguments, or observations next.",
            ],
        }
    except WorkflowFailure as exc:
        steps.append(
            {
                "stage": exc.stage,
                "status": "failed",
                "summary": exc.message,
                "evidence": {"classification": exc.classification},
            }
        )
        return build_failed_workflow_report(
            started=started,
            steps=steps,
            ledger=ledger,
            classification=exc.classification,
            failed_stage=exc.stage,
            message=exc.message,
            command_lifecycle=state.command_lifecycle,
        )
    except Exception as exc:
        return build_failed_workflow_report(
            started=started,
            steps=steps,
            ledger=ledger,
            classification="tool_call_failed",
            failed_stage=current_stage,
            message=str(exc),
            command_lifecycle=state.command_lifecycle,
        )


def run_ncbi_import_smoke_workflow(state: ConsoleState) -> dict[str, Any]:
    steps: list[dict[str, Any]] = []
    ledger: list[dict[str, Any]] = []
    started = datetime.now(tz=UTC)
    current_stage = "import_sequence"
    try:
        import_result = call_tool(
            state,
            "import_sequence",
            {
                "source": {"kind": "ncbi", "accession": NCBI_SMOKE_ACCESSION},
                "targetPath": NCBI_SMOKE_IMPORTED_SEQUENCE_PATH,
                "label": NCBI_SMOKE_LABEL,
                "overwrite": True,
            },
        )
        if import_result.get("imported") is not True:
            raise_workflow_failure(
                "import_sequence",
                "sequence_import_failed",
                f"import_sequence did not import the NCBI record: {import_result}",
            )
        imported_source = import_result.get("source")
        if (
            not isinstance(imported_source, dict)
            or imported_source.get("kind") != "ncbi"
        ):
            raise_workflow_failure(
                "import_sequence",
                "sequence_import_failed",
                f"import_sequence did not preserve the NCBI source: {import_result}",
            )
        resource_uri = import_result.get("resourceUri")
        if not isinstance(resource_uri, str) or not resource_uri.startswith(
            "waypoint://sequence/"
        ):
            raise_workflow_failure(
                "import_sequence",
                "sequence_import_failed",
                f"import_sequence did not return a sequence resource URI: {import_result}",
            )

        current_stage = "read_sequence_resource"
        sequence_snapshot = read_sequence_resource_snapshot(
            state, resource_uri=resource_uri
        )
        if sequence_snapshot.get("exists") is not True:
            raise_workflow_failure(
                "read_sequence_resource",
                "resource_read_failed",
                f"Imported NCBI sequence resource was not readable: {sequence_snapshot}",
            )
        sequence_length = sequence_snapshot.get("length")
        if not isinstance(sequence_length, int) or sequence_length <= 0:
            raise_workflow_failure(
                "read_sequence_resource",
                "resource_read_failed",
                f"Imported NCBI sequence did not expose a positive length: {sequence_snapshot}",
            )
        steps.append(
            {
                "stage": "import_sequence",
                "status": "passed",
                "summary": (
                    f"Imported NCBI accession {NCBI_SMOKE_ACCESSION} into the workspace."
                ),
                "evidence": {
                    "source": imported_source,
                    "path": import_result.get("path"),
                    "resource_uri": resource_uri,
                    "opened": import_result.get("opened"),
                    "length": sequence_length,
                    "feature_count": sequence_snapshot.get("featureCount"),
                },
            }
        )

        current_stage = "observe_imported_sequence_render"
        sequence_render_observation = wait_for_sequence_render_observation(
            state,
            label=NCBI_SMOKE_LABEL,
            expected_length=sequence_length,
            expected_feature_count=(
                sequence_snapshot.get("featureCount")
                if isinstance(sequence_snapshot.get("featureCount"), int)
                else None
            ),
        )
        steps.append(
            {
                "stage": "observe_imported_sequence_render",
                "status": "passed",
                "summary": "Observed the imported NCBI sequence tab render in the app.",
                "evidence": summarize_sequence_render_observation(
                    sequence_render_observation
                ),
            }
        )

        current_stage = "verify_action_resources"
        action_resource_summary = verify_command_lifecycle_resources(state)
        steps.append(
            {
                "stage": "verify_action_resources",
                "status": "passed",
                "summary": "Verified command action resources through MCP.",
                "evidence": action_resource_summary,
            }
        )

        return {
            "workflow": WORKFLOW_NCBI_IMPORT_SMOKE,
            "outcome": "passed",
            "classification": "passed",
            "failed_stage": None,
            "summary": (
                f"Imported NCBI accession {NCBI_SMOKE_ACCESSION}, read the "
                "sequence resource, and observed the sequence render through "
                "the app bridge."
            ),
            "duration_ms": elapsed_ms(started),
            "design": None,
            "ledger": ledger,
            "steps": steps,
            "command_lifecycle": state.command_lifecycle,
            "next_actions": [
                "Use this as the narrow external-source smoke before composing external imports into design workflows.",
                "If this fails, classify whether the break is NCBI fetch, import parsing, workspace write, or UI render observation.",
            ],
        }
    except WorkflowFailure as exc:
        steps.append(
            {
                "stage": exc.stage,
                "status": "failed",
                "summary": exc.message,
                "evidence": {"classification": exc.classification},
            }
        )
        return build_failed_workflow_report(
            workflow=WORKFLOW_NCBI_IMPORT_SMOKE,
            started=started,
            steps=steps,
            ledger=ledger,
            classification=exc.classification,
            failed_stage=exc.stage,
            message=exc.message,
            command_lifecycle=state.command_lifecycle,
        )
    except Exception as exc:
        return build_failed_workflow_report(
            workflow=WORKFLOW_NCBI_IMPORT_SMOKE,
            started=started,
            steps=steps,
            ledger=ledger,
            classification="tool_call_failed",
            failed_stage=current_stage,
            message=str(exc),
            command_lifecycle=state.command_lifecycle,
        )


def run_ncbi_derivative_design_workflow(state: ConsoleState) -> dict[str, Any]:
    steps: list[dict[str, Any]] = []
    ledger: list[dict[str, Any]] = []
    started = datetime.now(tz=UTC)
    current_stage = "import_sequence"
    design_name = NCBI_DERIVATIVE_DESIGN_NAME
    source_path = NCBI_DERIVATIVE_IMPORTED_SEQUENCE_PATH
    try:
        import_result = call_tool(
            state,
            "import_sequence",
            {
                "source": {"kind": "ncbi", "accession": NCBI_SMOKE_ACCESSION},
                "targetPath": NCBI_DERIVATIVE_IMPORTED_SEQUENCE_PATH,
                "label": NCBI_DERIVATIVE_LABEL,
                "overwrite": True,
            },
        )
        if import_result.get("imported") is not True:
            raise_workflow_failure(
                "import_sequence",
                "sequence_import_failed",
                f"import_sequence did not import the NCBI record: {import_result}",
            )
        resource_uri = import_result.get("resourceUri")
        if not isinstance(resource_uri, str) or not resource_uri.startswith(
            "waypoint://sequence/"
        ):
            raise_workflow_failure(
                "import_sequence",
                "sequence_import_failed",
                f"import_sequence did not return a sequence resource URI: {import_result}",
            )
        source_path = str(
            import_result.get("path") or NCBI_DERIVATIVE_IMPORTED_SEQUENCE_PATH
        )

        current_stage = "read_sequence_resource"
        sequence_snapshot = read_sequence_resource_snapshot(
            state, resource_uri=resource_uri
        )
        if sequence_snapshot.get("exists") is not True:
            raise_workflow_failure(
                "read_sequence_resource",
                "resource_read_failed",
                f"Imported NCBI sequence resource was not readable: {sequence_snapshot}",
            )
        sequence_length = sequence_snapshot.get("length")
        if not isinstance(sequence_length, int) or sequence_length <= 0:
            raise_workflow_failure(
                "read_sequence_resource",
                "resource_read_failed",
                f"Imported NCBI sequence did not expose a positive length: {sequence_snapshot}",
            )
        steps.append(
            {
                "stage": "import_sequence",
                "status": "passed",
                "summary": (
                    f"Imported NCBI accession {NCBI_SMOKE_ACCESSION} into the workspace."
                ),
                "evidence": {
                    "source": import_result.get("source"),
                    "path": source_path,
                    "resource_uri": resource_uri,
                    "opened": import_result.get("opened"),
                    "length": sequence_length,
                    "feature_count": sequence_snapshot.get("featureCount"),
                },
            }
        )

        current_stage = "observe_imported_sequence_render"
        sequence_render_observation = wait_for_sequence_render_observation(
            state,
            label=NCBI_DERIVATIVE_LABEL,
            expected_length=sequence_length,
            expected_feature_count=(
                sequence_snapshot.get("featureCount")
                if isinstance(sequence_snapshot.get("featureCount"), int)
                else None
            ),
        )
        steps.append(
            {
                "stage": "observe_imported_sequence_render",
                "status": "passed",
                "summary": "Observed the imported NCBI sequence tab render in the app.",
                "evidence": summarize_sequence_render_observation(
                    sequence_render_observation
                ),
            }
        )

        current_stage = "plan_design_regions"
        plan_result = call_tool(
            state,
            "plan_design_regions",
            {
                "path": source_path,
                "maxRegions": 2,
                "preferredRegionLength": 500,
                "includeFeatureBackedRegions": True,
            },
        )
        planned_regions = require_planned_design_regions(plan_result, expected_count=2)
        steps.append(
            {
                "stage": "plan_design_regions",
                "status": "passed",
                "summary": "Planned two source ranges for the NCBI derivative design.",
                "evidence": {
                    "strategy": plan_result.get("strategy"),
                    "region_count": plan_result.get("regionCount"),
                    "regions": planned_regions,
                },
            }
        )

        current_stage = "create_design"
        create_result = call_tool(
            state,
            "create_design",
            {"name": design_name, "assemblyMethod": "gibson"},
        )
        design_id = create_result.get("designId")
        if not isinstance(design_id, str) or not design_id:
            raise_workflow_failure(
                "create_design",
                "design_create_failed",
                f"create_design did not return a design id: {create_result}",
            )
        state.last_design_id = design_id
        state.last_design_name = design_name
        create_verdict = verify_design_mutation_claim(
            state,
            create_result,
            expected_effect="created_design",
            expected={
                "name": design_name,
                "assemblyMethod": "gibson",
                "regionCount": 0,
            },
        )
        ledger.append(create_verdict)
        require_ledger_verdict(create_verdict, stage="create_design")
        steps.append(
            {
                "stage": "create_design",
                "status": "passed",
                "summary": f'Created design "{design_name}".',
                "evidence": {
                    "design_id": design_id,
                    "opened": create_result.get("opened"),
                    "assembly_method": create_result.get("assemblyMethod"),
                },
            }
        )

        added_regions: list[dict[str, Any]] = []
        for expected_region_count, planned_region in enumerate(
            planned_regions, start=1
        ):
            current_stage = "add_design_region"
            add_result = call_tool(
                state,
                "add_design_region",
                {
                    "designId": design_id,
                    "path": source_path,
                    "start": planned_region["start"],
                    "end": planned_region["end"],
                    "label": planned_region["label"],
                },
            )
            expected_length = planned_region["end"] - planned_region["start"] + 1
            if add_result.get("regionCount") != expected_region_count:
                raise_workflow_failure(
                    "add_design_region",
                    "region_add_failed",
                    (
                        "add_design_region did not return the expected region "
                        f"count {expected_region_count}: {add_result}"
                    ),
                )
            if add_result.get("length") != expected_length:
                raise_workflow_failure(
                    "add_design_region",
                    "region_add_failed",
                    (
                        "add_design_region did not return the expected region "
                        f"length {expected_length}: {add_result}"
                    ),
                )
            add_verdict = verify_design_mutation_claim(
                state,
                add_result,
                expected_effect="added_design_region",
                expected={
                    "regionCount": expected_region_count,
                    "regionId": add_result.get("regionId"),
                    "length": expected_length,
                },
            )
            ledger.append(add_verdict)
            require_ledger_verdict(add_verdict, stage="add_design_region")
            added_regions.append(add_result)
            steps.append(
                {
                    "stage": "add_design_region",
                    "status": "passed",
                    "summary": (
                        f'Added "{planned_region["label"]}" to the design '
                        f"as region {expected_region_count}."
                    ),
                    "evidence": {
                        "region_id": add_result.get("regionId"),
                        "start": planned_region["start"],
                        "end": planned_region["end"],
                        "length": add_result.get("length"),
                        "region_count": add_result.get("regionCount"),
                    },
                }
            )

        current_stage = "draft_design_assembly"
        draft_result = call_tool(
            state, "draft_design_assembly", {"designId": design_id}
        )
        if draft_result.get("validationErrorCount", 0) > 0:
            raise_workflow_failure(
                "draft_design_assembly",
                "assembly_validation_failed",
                f"draft_design_assembly reported validation errors: {draft_result}",
            )
        if (
            draft_result.get("assemblyState") != "ready"
            or draft_result.get("primerPairCount", 0) <= 0
        ):
            raise_workflow_failure(
                "draft_design_assembly",
                "assembly_draft_failed",
                f"draft_design_assembly did not produce a ready draft: {draft_result}",
            )
        draft_verdict = verify_design_mutation_claim(
            state,
            draft_result,
            expected_effect="drafted_design_assembly",
            expected={
                "assemblyState": "ready",
                "regionCount": 2,
                "validationErrorCount": 0,
                "primerPairCountMin": 1,
            },
        )
        ledger.append(draft_verdict)
        require_ledger_verdict(draft_verdict, stage="draft_design_assembly")
        steps.append(
            {
                "stage": "draft_design_assembly",
                "status": "passed",
                "summary": "Drafted assembly primers and junctions.",
                "evidence": {
                    "assembly_state": draft_result.get("assemblyState"),
                    "primer_pair_count": draft_result.get("primerPairCount"),
                    "homology_region_count": draft_result.get("homologyRegionCount"),
                    "validation_error_count": draft_result.get("validationErrorCount"),
                },
            }
        )

        current_stage = "observe_design_state"
        observation = observe_current_ui(state, design_name)
        design_state = observation.get("designState")
        if not isinstance(design_state, dict):
            raise_workflow_failure(
                "observe_design_state",
                "observer_gap",
                f"observer did not return design state: {observation}",
            )
        if (
            design_state.get("regionCount") != 2
            or design_state.get("assemblyState") != "ready"
            or design_state.get("primerPairCount", 0) <= 0
        ):
            raise_workflow_failure(
                "observe_design_state",
                "design_not_observable",
                f"observed design state did not match the workflow result: {design_state}",
            )
        steps.append(
            {
                "stage": "observe_design_state",
                "status": "passed",
                "summary": "Observed the resulting design state through the app bridge.",
                "evidence": {
                    "dom_visible": observation.get("target", {}).get("domVisible"),
                    "store_present": observation.get("target", {}).get("storePresent"),
                    "region_count": design_state.get("regionCount"),
                    "assembly_state": design_state.get("assemblyState"),
                    "primer_pair_count": design_state.get("primerPairCount"),
                    "validation_error_count": design_state.get("validationErrorCount"),
                },
            }
        )

        current_stage = "verify_action_resources"
        action_resource_summary = verify_command_lifecycle_resources(state)
        steps.append(
            {
                "stage": "verify_action_resources",
                "status": "passed",
                "summary": "Verified command action resources through MCP.",
                "evidence": action_resource_summary,
            }
        )

        return {
            "workflow": WORKFLOW_NCBI_DERIVATIVE_DESIGN,
            "outcome": "passed",
            "classification": "passed",
            "failed_stage": None,
            "summary": (
                f"Imported NCBI accession {NCBI_SMOKE_ACCESSION}, created a "
                "derivative design from two source ranges, drafted assembly, "
                "and observed the ready design state through the app bridge."
            ),
            "duration_ms": elapsed_ms(started),
            "design": {
                "id": design_id,
                "name": design_name,
                "source_path": source_path,
                "regions_added": len(added_regions),
            },
            "ledger": ledger,
            "steps": steps,
            "command_lifecycle": state.command_lifecycle,
            "next_actions": [
                "Use this as the composed external-import design workflow while Addgene and richer annotation selection mature.",
                "If it is not biologically useful enough, improve imported annotation extraction or add an agent-facing source-region selection primitive next.",
            ],
        }
    except WorkflowFailure as exc:
        steps.append(
            {
                "stage": exc.stage,
                "status": "failed",
                "summary": exc.message,
                "evidence": {"classification": exc.classification},
            }
        )
        return build_failed_workflow_report(
            workflow=WORKFLOW_NCBI_DERIVATIVE_DESIGN,
            started=started,
            steps=steps,
            ledger=ledger,
            classification=exc.classification,
            failed_stage=exc.stage,
            message=exc.message,
            command_lifecycle=state.command_lifecycle,
        )
    except Exception as exc:
        return build_failed_workflow_report(
            workflow=WORKFLOW_NCBI_DERIVATIVE_DESIGN,
            started=started,
            steps=steps,
            ledger=ledger,
            classification="tool_call_failed",
            failed_stage=current_stage,
            message=str(exc),
            command_lifecycle=state.command_lifecycle,
        )


def require_planned_design_regions(
    plan_result: dict[str, Any], *, expected_count: int
) -> list[dict[str, Any]]:
    if plan_result.get("planned") is not True:
        raise_workflow_failure(
            "plan_design_regions",
            "region_plan_failed",
            f"plan_design_regions did not produce a region plan: {plan_result}",
        )
    raw_regions = plan_result.get("regions")
    if not isinstance(raw_regions, list) or len(raw_regions) < expected_count:
        raise_workflow_failure(
            "plan_design_regions",
            "region_plan_failed",
            f"plan_design_regions returned too few regions: {plan_result}",
        )

    planned_regions: list[dict[str, Any]] = []
    for region in raw_regions[:expected_count]:
        if not isinstance(region, dict):
            raise_workflow_failure(
                "plan_design_regions",
                "region_plan_failed",
                f"plan_design_regions returned a non-object region: {region}",
            )
        start = region.get("start")
        end = region.get("end")
        label = region.get("label")
        if (
            not isinstance(start, int)
            or not isinstance(end, int)
            or start < 1
            or end < start
        ):
            raise_workflow_failure(
                "plan_design_regions",
                "region_plan_failed",
                f"plan_design_regions returned invalid coordinates: {region}",
            )
        if not isinstance(label, str) or not label:
            raise_workflow_failure(
                "plan_design_regions",
                "region_plan_failed",
                f"plan_design_regions returned a region without a label: {region}",
            )
        planned_regions.append(region)
    return planned_regions


class WorkflowFailure(HarnessFailure):
    def __init__(self, stage: str, classification: str, message: str):
        super().__init__(message)
        self.stage = stage
        self.classification = classification
        self.message = message


def raise_workflow_failure(stage: str, classification: str, message: str) -> None:
    raise WorkflowFailure(stage, classification, message)


def build_failed_workflow_report(
    *,
    workflow: str = WORKFLOW_MINI_DERIVATIVE_DESIGN,
    started: datetime,
    steps: list[dict[str, Any]],
    ledger: list[dict[str, Any]],
    classification: str,
    failed_stage: str,
    message: str,
    command_lifecycle: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "workflow": workflow,
        "outcome": "failed",
        "classification": classification,
        "failed_stage": failed_stage,
        "summary": message,
        "duration_ms": elapsed_ms(started),
        "design": None,
        "ledger": ledger,
        "steps": steps,
        "command_lifecycle": command_lifecycle or [],
        "next_actions": next_actions_for_failure(classification),
    }


def next_actions_for_failure(classification: str) -> list[str]:
    actions = {
        "feature_not_found": [
            "Check whether the source sequence and feature naming are discoverable enough for agents.",
            "Consider adding a richer feature-search result with suggested close matches.",
        ],
        "sequence_import_failed": [
            "Inspect import_sequence source/target paths and workspace write permissions.",
            "Add a narrower import-only assay before composing the design workflow.",
        ],
        "design_create_failed": [
            "Inspect the create_design MCP result shape and renderer design-store write.",
            "Add a narrower primitive assay for design creation before composing workflows.",
        ],
        "region_add_failed": [
            "Inspect add_design_region arguments, coordinate handling, and design-store mutation.",
            "Add a smaller assay for one region add before retrying the full workflow.",
        ],
        "region_plan_failed": [
            "Inspect plan_design_regions output and source sequence readability.",
            "Fix the planning primitive before hard-coding ranges in the workflow.",
        ],
        "assembly_validation_failed": [
            "Surface validation errors in the report and decide whether the workflow should repair them.",
            "Add an agent-facing next-step primitive for fixing assembly validation failures.",
        ],
        "assembly_draft_failed": [
            "Inspect draft_design_assembly output and the app assembly dispatcher result.",
            "Decide whether the MCP should expose more detailed assembly planning state.",
        ],
        "design_not_observable": [
            "Compare the MCP mutation result to the independent app-state observer.",
            "Fix the app hook if the tool returned success without changing observable state.",
        ],
        "mutation_verification_failed": [
            "Compare the ledger claim to the observed design resource snapshot.",
            "Fix the tool contract or app mutation path before adding more workflow logic.",
        ],
        "resource_read_failed": [
            "Inspect MCP resources/read for waypoint://design/{id}.",
            "Fix canonical resource reads before trusting workflow-level reports.",
        ],
        "action_resource_mismatch": [
            "Compare the command timeline entry to its waypoint://action/{id} resource.",
            "Fix sidecar action persistence or the MCP action resource projection.",
        ],
        "observer_gap": [
            "Add or repair an independent observer before trusting this workflow.",
            "Do not treat tool success as proof until the observer sees the app state.",
        ],
        "tool_call_failed": [
            "Open the transcript and identify the last MCP tool call that failed.",
            "Classify the failure more narrowly before adding more workflow logic.",
        ],
    }
    return actions.get(
        classification,
        ["Open the transcript and classify the failure before changing the workflow."],
    )


def render_workflow_contract(workflow: str) -> str:
    contract = build_workflow_contract(workflow)
    demand = contract.get("demand") if isinstance(contract.get("demand"), dict) else {}
    lines = [
        f"# MCP Workflow Contract: {workflow}",
        "",
        f"Title: {contract.get('title', workflow)}",
        "",
        f"Mode: {contract.get('mode', 'unknown')}",
        "",
        f"Maturity: {contract.get('maturity', 'unknown')}",
        "",
        f"Demand: {demand.get('level', 'unknown')} - {demand.get('rationale', '')}",
        "",
        f"User goal: {contract['user_goal']}",
        "",
        f"First external tooling use case: {contract['first_external_tooling_use_case']}",
        "",
        f"Control surface: {contract['control_surface']}",
        "",
        "## Expected App Changes",
        "",
    ]
    for item in contract.get("expected_app_changes", []):
        lines.append(f"- {item}")
    lines.extend(["", "## Success Metrics", ""])
    for item in _dict_entries(contract.get("success_metrics")):
        lines.append(f"- {item.get('id')}: {item.get('description')}")
    lines.extend(["", "## Workflow Steps", ""])
    for item in _dict_entries(contract.get("steps")):
        label = item.get("id") or item.get("tool") or item.get("kind")
        lines.append(f"- {label} ({item.get('kind')}): {item.get('description')}")
    lines.extend(["", "## Required MCP Primitives", ""])
    for item in contract.get("required_primitives", []):
        lines.append(f"- {item}")
    lines.extend(["", "## Verification Channels", ""])
    for item in contract.get("verification_channels", []):
        lines.append(f"- {item}")
    lines.extend(["", "## Next MCP Gaps", ""])
    for item in contract.get("next_mcp_gaps", []):
        lines.append(f"- {item}")
    lines.append("")
    return "\n".join(lines)


def elapsed_ms(started: datetime) -> int:
    return round((datetime.now(tz=UTC) - started).total_seconds() * 1000)


def verify_design_mutation_claim(
    state: ConsoleState,
    tool_result: dict[str, Any],
    *,
    expected_effect: str,
    expected: dict[str, Any],
) -> dict[str, Any]:
    claim = tool_result.get("mutation")
    if not isinstance(claim, dict):
        return failed_ledger_entry(
            "missing_mutation_claim",
            "Tool result did not include a mutation claim.",
            claim,
        )

    operation_id = claim.get("operationId")
    target = claim.get("target")
    resource_uri = claim.get("resourceUri")
    effect = claim.get("effect")
    if not isinstance(operation_id, str) or not operation_id:
        return failed_ledger_entry(
            "invalid_mutation_claim",
            "Mutation claim is missing operationId.",
            claim,
        )
    if not isinstance(target, dict) or target.get("type") != "design":
        return failed_ledger_entry(
            "invalid_mutation_claim",
            "Mutation claim target is not a design.",
            claim,
        )
    design_id = target.get("id")
    if not isinstance(design_id, str) or not design_id:
        return failed_ledger_entry(
            "invalid_mutation_claim",
            "Mutation claim target is missing design id.",
            claim,
        )
    expected_resource_uri = design_resource_uri(design_id)
    if resource_uri != expected_resource_uri:
        return failed_ledger_entry(
            "resource_uri_mismatch",
            f"Mutation claim resource URI did not match target id: {resource_uri}",
            claim,
        )
    if effect != expected_effect:
        return failed_ledger_entry(
            "effect_mismatch",
            f"Mutation claim effect {effect} did not match {expected_effect}.",
            claim,
        )

    snapshot = read_design_resource_snapshot(
        state,
        resource_uri=resource_uri,
        design_id=design_id,
    )
    checks = build_design_mutation_checks(
        claim=claim,
        snapshot=snapshot,
        expected_effect=expected_effect,
        expected=expected,
    )
    verdict = "passed" if all(check["passed"] for check in checks) else "failed"
    return {
        "operation_id": operation_id,
        "tool": claim.get("toolName"),
        "effect": effect,
        "target": target,
        "resource_uri": resource_uri,
        "claim": {
            "before_version": claim.get("beforeVersion"),
            "after_version": claim.get("afterVersion"),
            "changed": claim.get("changed"),
        },
        "observed": snapshot,
        "checks": checks,
        "verdict": verdict,
    }


def failed_ledger_entry(
    code: str, message: str, claim: Any | None = None
) -> dict[str, Any]:
    return {
        "operation_id": None,
        "tool": None,
        "effect": None,
        "target": None,
        "resource_uri": None,
        "claim": claim,
        "observed": None,
        "checks": [{"name": code, "passed": False, "message": message}],
        "verdict": "failed",
    }


def require_ledger_verdict(entry: dict[str, Any], *, stage: str) -> None:
    if entry.get("verdict") == "passed":
        return
    failed_checks = [
        item
        for item in entry.get("checks", [])
        if isinstance(item, dict) and item.get("passed") is not True
    ]
    summary = "; ".join(
        str(item.get("message", item.get("name", "unknown failure")))
        for item in failed_checks
    )
    raise_workflow_failure(
        stage,
        "mutation_verification_failed",
        summary or "Mutation claim did not match observed app state.",
    )


def read_design_resource_snapshot(
    state: ConsoleState, *, resource_uri: str, design_id: str
) -> dict[str, Any]:
    response = state.client.request("resources/read", {"uri": resource_uri})
    if "error" in response:
        raise_workflow_failure(
            "read_design_resource",
            "resource_read_failed",
            f"resources/read failed for {resource_uri}: {response['error']}",
        )
    resource = parse_single_json_resource(response.get("result", {}), resource_uri)
    write_transcript(
        state.transcript_path,
        "resource_snapshot",
        {"resourceUri": resource_uri, "resource": resource},
    )
    return normalize_design_resource_snapshot(resource, design_id=design_id)


def read_sequence_resource_snapshot(
    state: ConsoleState, *, resource_uri: str
) -> dict[str, Any]:
    response = state.client.request("resources/read", {"uri": resource_uri})
    if "error" in response:
        raise_workflow_failure(
            "read_sequence_resource",
            "resource_read_failed",
            f"resources/read failed for {resource_uri}: {response['error']}",
        )
    resource = parse_single_json_resource(response.get("result", {}), resource_uri)
    write_transcript(
        state.transcript_path,
        "resource_snapshot",
        {"resourceUri": resource_uri, "resource": resource},
    )
    return resource


def read_action_resource_snapshot(
    state: ConsoleState, *, resource_uri: str
) -> dict[str, Any]:
    response = state.client.request("resources/read", {"uri": resource_uri})
    if "error" in response:
        raise_workflow_failure(
            "read_action_resource",
            "resource_read_failed",
            f"resources/read failed for {resource_uri}: {response['error']}",
        )
    resource = parse_single_json_resource(response.get("result", {}), resource_uri)
    write_transcript(
        state.transcript_path,
        "action_resource_snapshot",
        {"resourceUri": resource_uri, "resource": resource},
    )
    return resource


def verify_command_lifecycle_resources(state: ConsoleState) -> dict[str, Any]:
    verified: list[dict[str, Any]] = []
    for entry in state.command_lifecycle:
        resource_uri = entry.get("action_resource_uri")
        if not isinstance(resource_uri, str) or not resource_uri:
            continue
        resource = read_action_resource_snapshot(state, resource_uri=resource_uri)
        checks = build_action_resource_checks(entry, resource)
        failed = [
            check
            for check in checks
            if isinstance(check, dict) and check.get("passed") is not True
        ]
        if failed:
            summary = "; ".join(
                str(check.get("message", check.get("name", "unknown failure")))
                for check in failed
            )
            raise_workflow_failure(
                "verify_action_resources",
                "action_resource_mismatch",
                summary or "Action resource did not match the command lifecycle.",
            )
        verified.append(
            {
                "tool": entry.get("tool"),
                "action_id": entry.get("action_id"),
                "resource_uri": resource_uri,
                "audit_record_count": len(resource.get("auditRecords", [])),
            }
        )

    return {
        "verified_action_count": len(verified),
        "actions": verified,
    }


def build_action_resource_checks(
    entry: dict[str, Any], resource: dict[str, Any]
) -> list[dict[str, Any]]:
    action = resource.get("action")
    if not isinstance(action, dict):
        action = {}
    audit_records = resource.get("auditRecords")
    if not isinstance(audit_records, list):
        audit_records = []
    audit_ids = {
        audit.get("id")
        for audit in audit_records
        if isinstance(audit, dict) and isinstance(audit.get("id"), str)
    }

    expected_audit_id = entry.get("renderer_audit_id")
    require_audit_match = isinstance(expected_audit_id, str) and bool(expected_audit_id)
    return [
        check(
            "action_resource_exists",
            resource.get("exists") is True,
            "Action resource exists.",
        ),
        check(
            "action_resource_uri_matches",
            resource.get("resourceUri") == entry.get("action_resource_uri"),
            "Action resource URI matches the command lifecycle entry.",
        ),
        check(
            "action_id_matches",
            action.get("id") == entry.get("action_id"),
            "Action id matches the command lifecycle entry.",
        ),
        check(
            "tool_name_matches",
            action.get("toolName") == entry.get("tool"),
            "Action tool name matches the command lifecycle entry.",
        ),
        check(
            "action_completed",
            entry.get("status") != "completed" or bool(action.get("completedAt")),
            "Completed command has a completed action record.",
        ),
        check(
            "renderer_audit_matches",
            not require_audit_match or expected_audit_id in audit_ids,
            "Renderer audit id is present in the action resource.",
        ),
    ]


def parse_single_json_resource(result: dict[str, Any], uri: str) -> dict[str, Any]:
    contents = result.get("contents")
    if not isinstance(contents, list) or len(contents) != 1:
        raise_workflow_failure(
            "read_design_resource",
            "resource_read_failed",
            f"resources/read did not return exactly one content item for {uri}: {result}",
        )
    content = contents[0]
    if not isinstance(content, dict) or content.get("uri") != uri:
        raise_workflow_failure(
            "read_design_resource",
            "resource_read_failed",
            f"resources/read returned the wrong URI for {uri}: {content}",
        )
    text = content.get("text")
    if not isinstance(text, str):
        raise_workflow_failure(
            "read_design_resource",
            "resource_read_failed",
            f"resources/read returned non-text content for {uri}: {content}",
        )
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise WorkflowFailure(
            "read_design_resource",
            "resource_read_failed",
            f"resources/read returned invalid JSON for {uri}: {exc.msg}",
        ) from exc
    if not isinstance(parsed, dict):
        raise_workflow_failure(
            "read_design_resource",
            "resource_read_failed",
            f"resources/read returned non-object JSON for {uri}: {parsed}",
        )
    return parsed


def normalize_design_resource_snapshot(
    resource: dict[str, Any], *, design_id: str
) -> dict[str, Any]:
    if resource.get("exists") is not True:
        return {
            "exists": False,
            "id": design_id,
            "resourceUri": resource.get("resourceUri"),
            "error": resource.get("error"),
        }
    return {
        "exists": True,
        "id": resource.get("designId"),
        "resourceUri": resource.get("resourceUri"),
        "name": resource.get("name"),
        "assemblyMethod": resource.get("assemblyMethod"),
        "assemblyState": resource.get("assemblyState"),
        "version": resource.get("version"),
        "regionCount": resource.get("regionCount"),
        "primerPairCount": resource.get("primerPairCount"),
        "validationErrorCount": resource.get("validationErrorCount"),
        "regions": resource.get("regions", []),
    }


def design_resource_uri(design_id: str) -> str:
    return f"waypoint://design/{quote(design_id, safe='')}"


def build_design_mutation_checks(
    *,
    claim: dict[str, Any],
    snapshot: dict[str, Any],
    expected_effect: str,
    expected: dict[str, Any],
) -> list[dict[str, Any]]:
    checks = [
        check(
            "target_exists", snapshot.get("exists") is True, "Design resource exists."
        ),
        check(
            "target_id_matches",
            snapshot.get("id") == claim.get("target", {}).get("id"),
            "Observed design id matches mutation target.",
        ),
    ]
    after_version = claim.get("afterVersion")
    before_version = claim.get("beforeVersion")
    if isinstance(after_version, int):
        checks.append(
            check(
                "after_version_matches",
                snapshot.get("version") == after_version,
                "Observed design version matches mutation claim.",
            )
        )
    if isinstance(before_version, int) and isinstance(after_version, int):
        checks.append(
            check(
                "version_did_not_rewind",
                after_version >= before_version,
                "Design version did not rewind.",
            )
        )

    if expected_effect == "created_design":
        checks.extend(
            [
                check(
                    "name_matches",
                    snapshot.get("name") == expected.get("name"),
                    "Observed design name matches requested name.",
                ),
                check(
                    "assembly_method_matches",
                    snapshot.get("assemblyMethod") == expected.get("assemblyMethod"),
                    "Observed assembly method matches requested method.",
                ),
                check(
                    "region_count_matches",
                    snapshot.get("regionCount") == expected.get("regionCount"),
                    "Created design starts with expected region count.",
                ),
            ]
        )
    elif expected_effect == "added_design_region":
        expected_region_id = expected.get("regionId")
        regions = (
            snapshot.get("regions") if isinstance(snapshot.get("regions"), list) else []
        )
        matching_region = next(
            (
                region
                for region in regions
                if isinstance(region, dict) and region.get("id") == expected_region_id
            ),
            None,
        )
        checks.extend(
            [
                check(
                    "region_count_matches",
                    snapshot.get("regionCount") == expected.get("regionCount"),
                    "Observed region count matches the add-region claim.",
                ),
                check(
                    "added_region_exists",
                    matching_region is not None,
                    "Observed regions include the claimed region id.",
                ),
                check(
                    "added_region_length_matches",
                    isinstance(matching_region, dict)
                    and matching_region.get("length") == expected.get("length"),
                    "Observed region length matches the source slice.",
                ),
            ]
        )
    elif expected_effect == "drafted_design_assembly":
        checks.extend(
            [
                check(
                    "assembly_state_matches",
                    snapshot.get("assemblyState") == expected.get("assemblyState"),
                    "Observed assembly state matches expected draft state.",
                ),
                check(
                    "region_count_matches",
                    snapshot.get("regionCount") == expected.get("regionCount"),
                    "Observed region count stayed stable after drafting.",
                ),
                check(
                    "validation_clean",
                    snapshot.get("validationErrorCount")
                    == expected.get("validationErrorCount"),
                    "Observed validation error count matches expected count.",
                ),
                check(
                    "primers_created",
                    isinstance(snapshot.get("primerPairCount"), int)
                    and snapshot.get("primerPairCount")
                    >= expected.get("primerPairCountMin", 1),
                    "Observed primer pairs were created.",
                ),
            ]
        )
    return checks


def check(name: str, passed: bool, message: str) -> dict[str, Any]:
    return {"name": name, "passed": passed, "message": message}


def render_workflow_report(report: dict[str, Any]) -> str:
    lines = [
        f"# MCP Workflow Report: {report['workflow']}",
        "",
        f"Outcome: {report['outcome']}",
        f"Classification: {report['classification']}",
    ]
    if report.get("failed_stage"):
        lines.append(f"Failed stage: {report['failed_stage']}")
    lines.extend(
        [
            f"Duration: {report.get('duration_ms')} ms",
            f"Transcript: {report.get('transcript_path', '(not written yet)')}",
            f"Report: {report.get('report_path', '(not written yet)')}",
            f"Workflow ledger: {report.get('workflow_ledger_path', '(not written yet)')}",
            "",
        ]
    )

    contract = report.get("workflow_contract")
    if isinstance(contract, dict):
        demand = (
            contract.get("demand") if isinstance(contract.get("demand"), dict) else {}
        )
        lines.extend(
            [
                "## Workflow Contract",
                "",
                f"- Title: {contract.get('title')}",
                f"- Mode: {contract.get('mode')}",
                f"- Maturity: {contract.get('maturity')}",
                f"- Demand: {demand.get('level')} - {demand.get('rationale')}",
                f"- User goal: {contract.get('user_goal')}",
                f"- First external tooling use case: {contract.get('first_external_tooling_use_case')}",
                f"- Control surface: {contract.get('control_surface')}",
                "",
            ]
        )
        expected_changes = contract.get("expected_app_changes")
        if isinstance(expected_changes, list):
            lines.append("Expected app changes:")
            for item in expected_changes:
                lines.append(f"- {item}")
            lines.append("")

    metrics = summarize_workflow_run_metrics(report)
    lines.extend(
        [
            "## Workflow Metrics",
            "",
            f"- Successful tool flows: {metrics['successful_tool_flows']}",
            f"- Failed tool flows: {metrics['failed_tool_flows']}",
            f"- Runtime steps passed/failed: {metrics['passed_steps']}/{metrics['failed_steps']}",
            f"- Observer steps: {metrics['observer_steps']}",
            f"- Mutation claims passed/failed: {metrics['passed_mutation_claims']}/{metrics['failed_mutation_claims']}",
            "",
        ]
    )

    lines.extend(
        [
            "## Summary",
            "",
            str(report["summary"]),
            "",
            "## What Happened",
            "",
        ]
    )

    for step in report.get("steps", []):
        lines.append(
            f"- {step.get('status', 'unknown')}: {step.get('stage')} - {step.get('summary')}"
        )

    command_lifecycle = report.get("command_lifecycle")
    if isinstance(command_lifecycle, list) and command_lifecycle:
        lines.extend(["", "## Command Timeline", ""])
        for entry in command_lifecycle:
            if isinstance(entry, dict):
                lines.append(format_command_lifecycle_line(entry))

    render_steps = [
        step
        for step in report.get("steps", [])
        if isinstance(step, dict)
        and step.get("stage") == "observe_imported_sequence_render"
    ]
    if render_steps:
        lines.extend(["", "## Render Evidence", ""])
        for step in render_steps:
            evidence = step.get("evidence")
            if not isinstance(evidence, dict):
                continue
            loaded = evidence.get("loaded_sequence")
            loaded_label = ""
            if isinstance(loaded, dict):
                loaded_label = (
                    f", loaded {loaded.get('length')} bp / "
                    f"{loaded.get('annotation_count')} annotations"
                )
            lines.append(
                "- Imported sequence tab: "
                f"rendered={evidence.get('rendered')}, "
                f"minimap={evidence.get('minimap_type')}, "
                f"visible_canvases={evidence.get('visible_canvas_count')}, "
                f"webgl_ready={evidence.get('webgl_ready')}, "
                f"matching_webgl_instances={evidence.get('webgl_matching_instance_count')}"
                f"{loaded_label}"
            )

    action_resource_steps = [
        step
        for step in report.get("steps", [])
        if isinstance(step, dict) and step.get("stage") == "verify_action_resources"
    ]
    if action_resource_steps:
        lines.extend(["", "## Action Resource Evidence", ""])
        for step in action_resource_steps:
            evidence = step.get("evidence")
            if not isinstance(evidence, dict):
                continue
            lines.append(
                "- Verified "
                f"{evidence.get('verified_action_count', 0)} command action "
                "resources through MCP resources/read."
            )

    ledger = report.get("ledger")
    if isinstance(ledger, list):
        lines.extend(["", "## Agent Run Ledger", ""])
        for entry in ledger:
            if not isinstance(entry, dict):
                continue
            lines.append(
                f"- {entry.get('verdict', 'unknown')}: {entry.get('effect')} "
                f"on {entry.get('resource_uri')}"
            )
            failed_checks = [
                item
                for item in entry.get("checks", [])
                if isinstance(item, dict) and item.get("passed") is not True
            ]
            for failed_check in failed_checks:
                lines.append(
                    f"  - failed check: {failed_check.get('name')} - {failed_check.get('message')}"
                )

    design = report.get("design")
    if isinstance(design, dict):
        lines.extend(
            [
                "",
                "## Resulting Design",
                "",
                f"- Name: {design.get('name')}",
                f"- ID: {design.get('id')}",
                f"- Source: {design.get('source_path')}",
                f"- Regions added: {design.get('regions_added')}",
            ]
        )

    lines.extend(["", "## Next Actions", ""])
    for action in report.get("next_actions", []):
        lines.append(f"- {action}")
    lines.append("")
    return "\n".join(lines)


def run_mini_design_recipe(state: ConsoleState) -> None:
    run_workflow_and_report(
        state,
        WORKFLOW_MINI_DERIVATIVE_DESIGN,
        report_path=state.transcript_path.with_name("workflow-report.md"),
        raise_on_failure=False,
    )


def first_feature_with_coordinates(
    search_result: dict[str, Any], query: str
) -> dict[str, Any]:
    for feature in search_result.get("features", []):
        if (
            isinstance(feature, dict)
            and isinstance(feature.get("start"), int)
            and isinstance(feature.get("end"), int)
        ):
            return feature
    raise_workflow_failure(
        "find_feature",
        "feature_not_found",
        f"find_features did not return coordinates for {query}: {search_result}",
    )


def sequence_render_observer_passed(
    observation: dict[str, Any],
    *,
    expected_length: int | None = None,
    expected_feature_count: int | None = None,
) -> bool:
    render = observation.get("sequenceRender")
    if not isinstance(render, dict) or render.get("rendered") is not True:
        return False

    loaded_sequence = render.get("loadedSequence")
    if not isinstance(loaded_sequence, dict):
        return False
    if expected_length is not None and loaded_sequence.get("length") != expected_length:
        return False
    if (
        expected_feature_count is not None
        and loaded_sequence.get("annotationCount") != expected_feature_count
    ):
        return False

    minimap_type = render.get("minimapType")
    if minimap_type == "webgl":
        webgl = render.get("webgl")
        return (
            isinstance(webgl, dict)
            and webgl.get("ready") is True
            and isinstance(webgl.get("matchingInstanceCount"), int)
            and webgl["matchingInstanceCount"] > 0
        )
    return (
        isinstance(render.get("visibleCanvasCount"), int)
        and render["visibleCanvasCount"] > 0
    )


def summarize_sequence_render_observation(
    observation: dict[str, Any],
) -> dict[str, Any]:
    render = observation.get("sequenceRender")
    if not isinstance(render, dict):
        return {"rendered": False, "reason": "sequence_render_observation_missing"}
    webgl = render.get("webgl") if isinstance(render.get("webgl"), dict) else {}
    loaded_sequence = (
        render.get("loadedSequence")
        if isinstance(render.get("loadedSequence"), dict)
        else {}
    )
    return {
        "rendered": render.get("rendered"),
        "reason": render.get("reason"),
        "tab_id": render.get("tabId"),
        "entity_id": render.get("entityId"),
        "loaded_sequence": {
            "path": loaded_sequence.get("path"),
            "name": loaded_sequence.get("name"),
            "length": loaded_sequence.get("length"),
            "annotation_count": loaded_sequence.get("annotationCount"),
        },
        "minimap_type": render.get("minimapType"),
        "visible_canvas_count": render.get("visibleCanvasCount"),
        "webgl_ready": webgl.get("ready"),
        "webgl_matching_instance_count": webgl.get("matchingInstanceCount"),
    }


def wait_for_sequence_render_observation(
    state: ConsoleState,
    *,
    label: str,
    expected_length: int | None = None,
    expected_feature_count: int | None = None,
    timeout: float = 10.0,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    attempts = 0
    last_observation: dict[str, Any] | None = None

    while True:
        attempts += 1
        observation = observe_desktop_ui(
            renderer_port=state.renderer_port,
            renderer_token=state.renderer_token,
            label=label,
        )
        last_observation = observation
        if sequence_render_observer_passed(
            observation,
            expected_length=expected_length,
            expected_feature_count=expected_feature_count,
        ):
            write_transcript(
                state.transcript_path,
                "sequence_render_observation",
                {
                    "label": label,
                    "attempts": attempts,
                    "observation": observation,
                },
            )
            return observation
        if time.monotonic() >= deadline:
            break
        time.sleep(0.25)

    summary = (
        summarize_sequence_render_observation(last_observation or {})
        if last_observation
        else {"rendered": False, "reason": "observer_not_called"}
    )
    write_transcript(
        state.transcript_path,
        "sequence_render_observation",
        {
            "label": label,
            "attempts": attempts,
            "observation": last_observation,
            "summary": summary,
        },
    )
    raise_workflow_failure(
        "observe_imported_sequence_render",
        "observer_gap",
        f"Imported sequence tab did not produce render evidence: {summary}",
    )


def observe_current_ui(state: ConsoleState, label: str) -> dict[str, Any]:
    observation = observe_desktop_ui(
        renderer_port=state.renderer_port,
        renderer_token=state.renderer_token,
        label=label,
        design_id=state.last_design_id if label == state.last_design_name else None,
    )
    write_transcript(
        state.transcript_path,
        "ui_observation",
        {"label": label, "observation": observation},
    )
    target = observation.get("target", {})
    if state.echo_tools:
        print(
            f"Observed {label}: "
            f"domVisible={target.get('domVisible')} "
            f"storePresent={target.get('storePresent')}"
        )
    design_state = observation.get("designState")
    if state.echo_tools and isinstance(design_state, dict):
        print(
            "Design state: "
            f"{design_state.get('regionCount')} regions, "
            f"{design_state.get('primerPairCount')} primer pairs, "
            f"assembly state {design_state.get('assemblyState')}"
        )
    return observation


def print_compact_result(name: str, result: dict[str, Any]) -> None:
    if name == "find_features":
        features = result.get("features", [])
        names = [
            feature.get("name")
            for feature in features[:5]
            if isinstance(feature, dict) and feature.get("name")
        ]
        print(f"{name}: {result.get('matchCount', 0)} matches {names}")
        return
    if name == "get_workspace":
        panels = result.get("panels", [])
        labels: list[str] = []
        for panel in panels:
            if isinstance(panel, dict):
                labels.extend(
                    tab.get("label")
                    for tab in panel.get("tabs", [])
                    if isinstance(tab, dict) and tab.get("label")
                )
        print(f"{name}: tabs={labels}")
        return
    if name == "workspace.gitStatus":
        changed = [
            entry.get("path")
            for entry in result.get("changedFiles", [])
            if isinstance(entry, dict)
        ]
        print(f"{name}: changed_files={changed}")
        return
    if name == "create_design":
        print(
            f"{name}: opened={result.get('opened')} "
            f"designId={result.get('designId')}"
        )
        return
    if name == "add_design_region":
        print(
            f"{name}: regionCount={result.get('regionCount')} "
            f"length={result.get('length')}"
        )
        return
    if name == "plan_design_regions":
        labels = [
            region.get("label")
            for region in result.get("regions", [])[:5]
            if isinstance(region, dict) and region.get("label")
        ]
        print(f"{name}: regionCount={result.get('regionCount')} regions={labels}")
        return
    if name == "draft_design_assembly":
        print(
            f"{name}: assemblyState={result.get('assemblyState')} "
            f"primerPairCount={result.get('primerPairCount')} "
            f"validationErrorCount={result.get('validationErrorCount')}"
        )
        return
    print(f"{name}: {json.dumps(result, sort_keys=True)}")


def print_command_lifecycle_hint(entry: dict[str, Any]) -> None:
    resource_uri = entry.get("action_resource_uri")
    if not isinstance(resource_uri, str) or not resource_uri:
        return
    audit_id = entry.get("renderer_audit_id")
    audit_suffix = f" audit={audit_id}" if isinstance(audit_id, str) else ""
    print(f"Action: {resource_uri}{audit_suffix}")


def write_transcript(path: Path, event: str, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "timestamp": datetime.now(tz=UTC).isoformat(),
        "event": event,
        **payload,
    }
    with path.open("a") as handle:
        handle.write(json.dumps(record, sort_keys=True) + "\n")


if __name__ == "__main__":
    raise SystemExit(main())
