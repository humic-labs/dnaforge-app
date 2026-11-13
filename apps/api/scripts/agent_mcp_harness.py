#!/usr/bin/env python3
""" live MCP harness.

This is intentionally a smoke harness, not a unit test. By default it starts
the API sidecar as a subprocess, starts a fake renderer bridge as a second
subprocess, starts the dnaforge-mcp stdio companion as a third subprocess, then
drives MCP-framed tool calls through the live companion -> sidecar -> renderer
path. For local desktop assays, --renderer-mode desktop launches the built
Electron app and drives the same MCP companion through Electron's real sidecar
and renderer bridge.

Usage:
    python scripts/agent_mcp_harness.py
    python scripts/agent_mcp_harness.py --keep-artifacts
    python scripts/agent_mcp_harness.py --renderer-mode desktop
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from src.agent_workflow_harness.assay_summaries import (
    build_design_tool_smoke_assay,
    build_desktop_agent_workflow_assay,
    build_fake_renderer_contract_assay,
    build_mini_design_workflow_assay,
    build_ui_effect_smoke_assay,
)
from src.agent_workflow_harness.closed_loop import (
    build_closed_loop_add_design_region_assay,
    build_closed_loop_create_design_assay,
    build_closed_loop_draft_design_assembly_assay,
    build_closed_loop_import_sequence_assay,
    build_closed_loop_open_tab_assay,
)
from src.agent_workflow_harness.contract_smoke import (
    RETAINED_RENDERER_TOOLS,
    run_mcp_contract_smoke,
    run_mcp_security_rejection_checks,
)
from src.agent_workflow_harness.desktop_workflows import (
    check_desktop_closed_loop_create_design_flow,
    check_desktop_closed_loop_import_sequence_flow,
    check_desktop_closed_loop_open_tab_flow,
    check_desktop_design_tool_workflow,
    check_desktop_reference_workflow,
    check_desktop_sequence_changes,
    check_workspace_git_status,
    observe_desktop_ui,
)
from src.agent_workflow_harness.fake_renderer import start_fake_renderer
from src.agent_workflow_harness.runtime import (
    DESKTOP_BUILD_HINT,
    HarnessFailure,
    copy_artifacts,
    create_desktop_git_workspace,
    dump_process_logs,
    find_free_port,
    local_http_target,
    node_tool_env,
    prepare_startup_fixtures,
    read_audit_summary,
    read_renderer_calls,
    request_json,
    require,
    restore_desktop_build_env,
    run_command,
    start_api_sidecar,
    start_desktop_app,
    terminate_process,
    terminate_process_group,
    wait_for_health,
    write_desktop_build_env,
)
from src.agent_workflow_harness.stdio_client import (
    MCPClientFailure,
    start_mcp_companion,
)
from src.agent_workflow_harness.stdio_client import (
    MCPStdioClient as SharedMCPStdioClient,
)

__all__ = [
    "DESKTOP_BUILD_HINT",
    "HarnessFailure",
    "MCPStdioClient",
    "create_desktop_git_workspace",
    "find_free_port",
    "local_http_target",
    "node_tool_env",
    "observe_desktop_ui",
    "prepare_startup_fixtures",
    "request_json",
    "require",
    "restore_desktop_build_env",
    "run_command",
    "start_desktop_app",
    "start_mcp_companion",
    "terminate_process",
    "terminate_process_group",
    "wait_for_health",
    "write_desktop_build_env",
]


class MCPStdioClient(SharedMCPStdioClient):
    """Shared stdio client that preserves this harness's failure boundary."""

    def request(
        self, method: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        try:
            return super().request(method, params)
        except MCPClientFailure as exc:
            raise HarnessFailure(str(exc)) from exc

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        try:
            super().notify(method, params)
        except MCPClientFailure as exc:
            raise HarnessFailure(str(exc)) from exc


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-port", type=int, default=0)
    parser.add_argument("--renderer-port", type=int, default=0)
    parser.add_argument(
        "--renderer-mode",
        choices=["fake", "desktop"],
        default="fake",
        help="Use the fake renderer bridge or launch the built Electron desktop app.",
    )
    parser.add_argument(
        "--desktop-main",
        type=Path,
        default=None,
        help="Path to the built Electron main entry for --renderer-mode desktop.",
    )
    parser.add_argument("--timeout", type=float, default=20.0)
    parser.add_argument("--keep-artifacts", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument(
        "--include-external-assays",
        action="store_true",
        help=(
            ": run the 4 external_resources assays (external_fetch_smoke, "
            "external_xref_smoke, cache_invalidation_smoke, "
            "dna98_resolver_chain_via_sidecar_smoke) against REAL UniProt. "
            "Off by default — keeps the default harness run hermetic; the "
            "live-probe nightly suite sets this flag."
        ),
    )

    args = parser.parse_args()

    try:
        summary = run_harness(args)
    except HarnessFailure as exc:
        print(f"[dnaforge-agent-harness] FAIL: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


def run_harness(args: argparse.Namespace) -> dict[str, Any]:
    api_dir = Path(__file__).resolve().parents[1]
    desktop_dir = api_dir.parent / "desktop"
    api_port = args.api_port or find_free_port()
    renderer_port = args.renderer_port or find_free_port()
    mcp_token = "harness-mcp-session"
    renderer_token = "harness-renderer-session"

    with tempfile.TemporaryDirectory(prefix="dnaforge-agent-harness-") as tmp:
        temp_dir = Path(tmp)
        db_path = temp_dir / "control-plane.sqlite3"
        renderer_log = temp_dir / "renderer-calls.jsonl"
        api_log = temp_dir / "api.log"
        fake_renderer_log = temp_dir / "fake-renderer.log"
        data_dir = temp_dir / "data"
        binaries_dir = temp_dir / "binaries"
        prepare_startup_fixtures(data_dir, binaries_dir)

        processes: list[subprocess.Popen[Any]] = []
        desktop_env_backup: tuple[Path, bytes | None] | None = None
        desktop_user_data_dir: Path | None = None
        desktop_workspace_dir: Path | None = None
        try:
            api_url = f"http://127.0.0.1:{api_port}"
            renderer_call_log: Path | None = renderer_log
            renderer_url: str | None = f"http://127.0.0.1:{renderer_port}"

            if args.renderer_mode == "desktop":
                desktop_workspace_dir = create_desktop_git_workspace()
                (
                    desktop_proc,
                    desktop_env_backup,
                    desktop_user_data_dir,
                ) = start_desktop_app(
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
                    stdout_log=temp_dir / "desktop.log",
                )
                processes.append(desktop_proc)
                renderer_call_log = None
                renderer_url = None
                wait_for_health(f"{api_url}/health", args.timeout)
            else:
                renderer_proc = start_fake_renderer(
                    renderer_port=renderer_port,
                    renderer_token=renderer_token,
                    renderer_log=renderer_log,
                    stdout_log=fake_renderer_log,
                )
                processes.append(renderer_proc)
                wait_for_health(
                    f"http://127.0.0.1:{renderer_port}/health", args.timeout
                )

                api_proc = start_api_sidecar(
                    api_dir=api_dir,
                    api_port=api_port,
                    renderer_port=renderer_port,
                    renderer_token=renderer_token,
                    mcp_token=mcp_token,
                    db_path=db_path,
                    data_dir=data_dir,
                    binaries_dir=binaries_dir,
                    stdout_log=api_log,
                )
                processes.append(api_proc)
                wait_for_health(f"{api_url}/health", args.timeout)

            checks, audit_summary, renderer_calls, assays = run_mcp_checks(
                api_url=api_url,
                renderer_port=renderer_port,
                mcp_token=mcp_token,
                renderer_token=renderer_token,
                renderer_call_log=renderer_call_log,
                db_path=db_path,
                desktop_workspace_dir=desktop_workspace_dir,
                desktop_user_data_dir=desktop_user_data_dir,
                temp_dir=temp_dir,
                processes=processes,
                timeout=args.timeout,
                include_external_assays=args.include_external_assays,
            )

            summary = {
                "ok": True,
                "renderer_mode": args.renderer_mode,
                "checks": checks,
                "api_url": api_url,
                "audit": audit_summary,
                "assays": assays,
            }
            if renderer_url:
                summary["renderer_url"] = renderer_url
            if renderer_calls is not None:
                summary["renderer_calls"] = renderer_calls
            if args.keep_artifacts:
                kept = Path(tempfile.mkdtemp(prefix="dnaforge-agent-harness-kept-"))
                copy_artifacts(temp_dir, kept)
                summary["artifacts"] = str(kept)
            if args.verbose:
                summary["api_log"] = api_log.read_text(errors="replace")
                summary["renderer_log"] = fake_renderer_log.read_text(errors="replace")
                desktop_log = temp_dir / "desktop.log"
                if desktop_log.exists():
                    summary["desktop_log"] = desktop_log.read_text(errors="replace")
            return summary
        except Exception as exc:
            if args.keep_artifacts:
                kept = Path(tempfile.mkdtemp(prefix="dnaforge-agent-harness-failed-"))
                copy_artifacts(temp_dir, kept)
                print(f"[dnaforge-agent-harness] kept artifacts at {kept}", file=sys.stderr)
            dump_process_logs(api_log, fake_renderer_log, temp_dir / "desktop.log")
            if isinstance(exc, HarnessFailure):
                raise
            raise HarnessFailure(str(exc)) from exc
        finally:
            for proc in reversed(processes):
                terminate_process(proc)
            if desktop_env_backup:
                restore_desktop_build_env(desktop_env_backup)
            if desktop_user_data_dir:
                shutil.rmtree(desktop_user_data_dir, ignore_errors=True)
            if desktop_workspace_dir:
                shutil.rmtree(desktop_workspace_dir, ignore_errors=True)

    raise HarnessFailure(
        "temporary harness workspace closed before summary was returned"
    )


def run_mcp_checks(
    *,
    api_url: str,
    renderer_port: int,
    mcp_token: str,
    renderer_token: str,
    renderer_call_log: Path | None,
    db_path: Path,
    desktop_workspace_dir: Path | None,
    desktop_user_data_dir: Path | None,
    temp_dir: Path,
    processes: list[subprocess.Popen[Any]],
    timeout: float,
    include_external_assays: bool = False,
) -> tuple[list[str], dict[str, Any], int | None, list[dict[str, Any]]]:
    checks: list[str] = []
    assays: list[dict[str, Any]] = []

    contract = run_mcp_contract_smoke(
        api_url=api_url,
        mcp_token=mcp_token,
        renderer_token=renderer_token,
        renderer_call_log=renderer_call_log,
        temp_dir=temp_dir,
        processes=processes,
        timeout=timeout,
        client_class=MCPStdioClient,
    )
    checks.extend(contract.checks)

    if renderer_call_log is None:
        require(
            desktop_workspace_dir is not None,
            "desktop renderer mode did not create a workspace fixture",
        )
        require(
            desktop_user_data_dir is not None,
            "desktop renderer mode did not create a user data directory",
        )
        require(
            isinstance(contract.renderer_audit_id, str),
            "real renderer bridge did not return a renderer audit id",
        )
        git_status_evidence = check_workspace_git_status(
            contract.client, timeout=timeout
        )
        checks.append("real desktop renderer bridge reads git status from workspace")
        reference_evidence = check_desktop_reference_workflow(
            api_url=api_url,
            renderer_port=renderer_port,
            renderer_token=renderer_token,
            mcp_token=mcp_token,
            desktop_workspace_dir=desktop_workspace_dir,
            desktop_user_data_dir=desktop_user_data_dir,
            temp_dir=temp_dir,
            processes=processes,
            timeout=timeout,
        )
        checks.append("real desktop renderer bridge completes reference workflow")
        sequence_change_evidence = check_desktop_sequence_changes(
            api_url=api_url,
            mcp_token=mcp_token,
            temp_dir=temp_dir,
            processes=processes,
            timeout=timeout,
        )
        checks.append("real desktop renderer bridge reads sequence-level git changes")
        closed_loop_evidence = check_desktop_closed_loop_create_design_flow(
            api_url=api_url,
            mcp_token=mcp_token,
            temp_dir=temp_dir,
            processes=processes,
            timeout=timeout,
        )
        checks.append(
            "real desktop MCP closed-loop create_design flow is app-state verified"
        )
        import_sequence_evidence = check_desktop_closed_loop_import_sequence_flow(
            api_url=api_url,
            mcp_token=mcp_token,
            desktop_workspace_dir=desktop_workspace_dir,
            temp_dir=temp_dir,
            processes=processes,
            timeout=timeout,
        )
        checks.append(
            "real desktop MCP closed-loop import_sequence flow is app-state verified"
        )
        open_tab_evidence = check_desktop_closed_loop_open_tab_flow(
            api_url=api_url,
            mcp_token=mcp_token,
            desktop_workspace_dir=desktop_workspace_dir,
            temp_dir=temp_dir,
            processes=processes,
            timeout=timeout,
        )
        checks.append(
            "real desktop MCP closed-loop open_tab flow is app-state verified"
        )
        design_tool_evidence = check_desktop_design_tool_workflow(
            api_url=api_url,
            renderer_port=renderer_port,
            renderer_token=renderer_token,
            mcp_token=mcp_token,
            temp_dir=temp_dir,
            processes=processes,
            timeout=timeout,
        )
        checks.append("real desktop renderer bridge drafts observable design assembly")
        checks.append(
            "real desktop MCP closed-loop add_design_region flow is app-state verified"
        )
        checks.append(
            "real desktop MCP closed-loop draft_design_assembly flow is app-state verified"
        )
        checks.append("real desktop MCP resource reads return canonical open app state")
        assays.append(
            build_desktop_agent_workflow_assay(
                renderer_audit_id=contract.renderer_audit_id,
                git_status=git_status_evidence,
                reference_workflow=reference_evidence,
                sequence_changes=sequence_change_evidence,
            )
        )
        assays.append(build_ui_effect_smoke_assay(reference_evidence["tab"]))
        assays.append(build_closed_loop_create_design_assay(closed_loop_evidence))
        assays.append(build_closed_loop_import_sequence_assay(import_sequence_evidence))
        assays.append(build_closed_loop_open_tab_assay(open_tab_evidence))
        assays.append(
            build_closed_loop_add_design_region_assay(
                design_tool_evidence["closed_loop_add_region"]
            )
        )
        assays.append(
            build_closed_loop_draft_design_assembly_assay(
                design_tool_evidence["closed_loop_draft_assembly"]
            )
        )
        assays.append(build_design_tool_smoke_assay(design_tool_evidence))
        assays.append(build_mini_design_workflow_assay(design_tool_evidence))

    checks.extend(
        run_mcp_security_rejection_checks(
            api_url=api_url,
            mcp_token=mcp_token,
            renderer_call_log=renderer_call_log,
            temp_dir=temp_dir,
            processes=processes,
            timeout=timeout,
            client_class=MCPStdioClient,
        )
    )

    audit_summary = read_audit_summary(db_path)
    require(audit_summary["agent_actions"] >= 2, "expected agent action rows")
    require(audit_summary["audit_records"] >= 2, "expected audit records")
    require(
        "granted" in audit_summary["capability_reasons"],
        "missing granted audit record",
    )
    require(
        "insufficient_scope" in audit_summary["capability_reasons"],
        "missing insufficient_scope audit record",
    )
    checks.append("sidecar control-plane audit records success and rejection")
    if desktop_workspace_dir is not None:
        require(
            audit_summary["actor_counts"].get("renderer", 0) >= 1,
            "missing durable renderer audit record",
        )
        checks.append("sidecar control-plane stores durable renderer audit records")

    renderer_calls = (
        len(read_renderer_calls(renderer_call_log))
        if renderer_call_log is not None
        else None
    )
    if renderer_call_log is not None:
        assays.append(
            build_fake_renderer_contract_assay(
                listed_tools=sorted(contract.tool_names),
                retained_renderer_tools=RETAINED_RENDERER_TOOLS,
                forwarded_scope=contract.forwarded_scope,
                renderer_calls=renderer_calls,
                workflow_resource=contract.workflow_resource,
                workflow_prepare=contract.workflow_prepare,
                artifact_register=contract.artifact_register,
                analysis_run=contract.analysis_run,
                resource_link=contract.resource_link,
            )
        )

    if include_external_assays:
        from src.agent_workflow_harness.external_resources_assays import (
            run_external_resources_assays,
        )

        external_results = run_external_resources_assays(
            sidecar_url=api_url,
            db_path=db_path,
            session_token=mcp_token,
        )
        assays.extend(external_results)
        for result in external_results:
            checks.append(
                f"external_resources assay {result['name']}: {result['outcome']}"
            )

    return checks, audit_summary, renderer_calls, assays


if __name__ == "__main__":
    raise SystemExit(main())
