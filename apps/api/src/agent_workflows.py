"""Shared  agent workflow manifest and run ledger helpers."""

from __future__ import annotations

import json
import shlex
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import quote

from .agent_manifest_paths import agent_tool_manifest_path
from .control_plane import get_control_plane_store

REPO_ROOT = Path(__file__).resolve().parents[3]
WORKFLOW_MANIFEST_PATH = agent_tool_manifest_path("workflow-manifest.json")
DEFAULT_RUNS_ROOT = Path.home() / ".waypoint-test" / "agent-workflow-runs"
KNOWN_EXECUTION_BOUNDARIES = {
    "shell_native",
    "external_provider",
    "app_service",
    "mcp_resource",
    "ui_bridge",
    "human_decision",
}


def load_workflow_manifest(
    path: Path = WORKFLOW_MANIFEST_PATH,
) -> dict[str, Any]:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != 1:
        raise RuntimeError(f"unsupported workflow manifest schema: {path}")
    workflows = manifest.get("workflows")
    if not isinstance(workflows, list) or not workflows:
        raise RuntimeError(f"workflow manifest has no workflows: {path}")
    seen: set[str] = set()
    for workflow in workflows:
        if not isinstance(workflow, dict):
            raise RuntimeError(f"workflow manifest contains a non-object entry: {path}")
        workflow_id = workflow.get("id")
        if not isinstance(workflow_id, str) or not workflow_id:
            raise RuntimeError(f"workflow manifest entry is missing id: {path}")
        if workflow_id in seen:
            raise RuntimeError(f"duplicate workflow id in manifest: {workflow_id}")
        seen.add(workflow_id)
        for step in dict_entries(workflow.get("steps")):
            boundary = step.get("execution_boundary")
            if (
                not isinstance(boundary, str)
                or boundary not in KNOWN_EXECUTION_BOUNDARIES
            ):
                raise RuntimeError(
                    "workflow manifest step has invalid execution_boundary: "
                    f"{workflow_id}/{step.get('id')}"
                )
    return manifest


def load_workflow_contracts(
    path: Path = WORKFLOW_MANIFEST_PATH,
) -> dict[str, dict[str, Any]]:
    manifest = load_workflow_manifest(path)
    return {
        workflow["id"]: workflow
        for workflow in manifest["workflows"]
        if isinstance(workflow, dict)
    }


def build_workflow_contract(workflow: str) -> dict[str, Any]:
    contracts = load_workflow_contracts()
    try:
        contract = contracts[workflow]
    except KeyError as exc:
        raise RuntimeError(f"unknown workflow contract: {workflow}") from exc
    return json.loads(json.dumps(contract))


def workflow_resource_uri(workflow_id: str) -> str:
    return f"waypoint://workflow/{quote(workflow_id, safe='')}"


def workflow_run_latest_resource_uri(workflow_id: str) -> str:
    return f"waypoint://workflow-runs/latest/{quote(workflow_id, safe='')}"


def workflow_resources_from_manifest(
    manifest: dict[str, Any] | None = None,
) -> list[dict[str, str]]:
    if manifest is None:
        manifest = load_workflow_manifest()
    resources = [
        {
            "uri": "waypoint://workflow/manifest",
            "name": "DNAForge workflow manifest",
            "description": "All registered agent workflow contracts.",
            "mimeType": "application/json",
        },
        {
            "uri": "waypoint://workflow-runs/summary",
            "name": "DNAForge workflow run summary",
            "description": "Aggregated outcomes from prior workflow-ledger.json files.",
            "mimeType": "application/json",
        },
    ]
    for workflow in dict_entries(manifest.get("workflows")):
        workflow_id = workflow.get("id")
        if not isinstance(workflow_id, str) or not workflow_id:
            continue
        resources.append(
            {
                "uri": workflow_resource_uri(workflow_id),
                "name": str(workflow.get("title") or workflow_id),
                "description": str(
                    workflow.get("user_goal") or "Agent workflow contract."
                ),
                "mimeType": "application/json",
            }
        )
    return resources


def workflow_manifest_resource() -> dict[str, Any]:
    manifest = load_workflow_manifest()
    return {
        "exists": True,
        "resourceUri": "waypoint://workflow/manifest",
        "manifest": manifest,
        "resources": workflow_resources_from_manifest(manifest),
    }


def workflow_contract_resource(workflow_id: str) -> dict[str, Any]:
    contract = build_workflow_contract(workflow_id)
    return {
        "exists": True,
        "resourceUri": workflow_resource_uri(workflow_id),
        "workflow": contract,
    }


def dict_entries(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def summarize_workflow_boundaries(contract: dict[str, Any]) -> dict[str, Any]:
    boundaries = {
        boundary: {"steps": 0, "step_ids": []}
        for boundary in sorted(KNOWN_EXECUTION_BOUNDARIES)
    }
    missing: list[str] = []
    for step in dict_entries(contract.get("steps")):
        step_id = str(step.get("id") or "unknown")
        boundary = step.get("execution_boundary")
        if not isinstance(boundary, str) or boundary not in boundaries:
            missing.append(step_id)
            continue
        boundaries[boundary]["steps"] += 1
        boundaries[boundary]["step_ids"].append(step_id)
    return {
        "boundaries": {
            key: value for key, value in boundaries.items() if value["steps"] > 0
        },
        "missing": missing,
    }


def summarize_workflow_run_metrics(report: dict[str, Any]) -> dict[str, Any]:
    command_lifecycle = dict_entries(report.get("command_lifecycle"))
    runtime_steps = dict_entries(report.get("steps"))
    mutation_ledger = dict_entries(report.get("ledger"))
    successful_tool_flows = sum(
        1 for entry in command_lifecycle if entry.get("status") == "completed"
    )
    failed_tool_flows = sum(
        1 for entry in command_lifecycle if entry.get("status") == "failed"
    )
    passed_steps = sum(1 for step in runtime_steps if step.get("status") == "passed")
    failed_steps = sum(1 for step in runtime_steps if step.get("status") == "failed")
    observer_steps = sum(
        1
        for step in runtime_steps
        if str(step.get("stage", "")).startswith(("observe_", "verify_"))
    )
    passed_mutations = sum(
        1 for entry in mutation_ledger if entry.get("verdict") == "passed"
    )
    failed_mutations = sum(
        1 for entry in mutation_ledger if entry.get("verdict") == "failed"
    )
    return {
        "success": report.get("outcome") == "passed",
        "successful_tool_flows": successful_tool_flows,
        "failed_tool_flows": failed_tool_flows,
        "total_tool_flows": successful_tool_flows + failed_tool_flows,
        "passed_steps": passed_steps,
        "failed_steps": failed_steps,
        "observer_steps": observer_steps,
        "passed_mutation_claims": passed_mutations,
        "failed_mutation_claims": failed_mutations,
    }


def build_workflow_progress(
    report: dict[str, Any], contract: dict[str, Any]
) -> list[dict[str, Any]]:
    command_lifecycle = dict_entries(report.get("command_lifecycle"))
    runtime_steps = dict_entries(report.get("steps"))
    mutation_ledger = dict_entries(report.get("ledger"))
    progress: list[dict[str, Any]] = []

    for manifest_step in dict_entries(contract.get("steps")):
        kind = str(manifest_step.get("kind", "unknown"))
        tool = manifest_step.get("tool")
        status = "not_measured"
        evidence: dict[str, Any] = {}

        if kind == "mcp_tool" and isinstance(tool, str):
            matching_calls = [
                entry for entry in command_lifecycle if entry.get("tool") == tool
            ]
            failed_calls = [
                entry for entry in matching_calls if entry.get("status") == "failed"
            ]
            completed_calls = [
                entry for entry in matching_calls if entry.get("status") == "completed"
            ]
            if failed_calls:
                status = "failed"
            elif completed_calls:
                status = "passed"
            else:
                status = "not_run"
            evidence = {
                "completed_calls": len(completed_calls),
                "failed_calls": len(failed_calls),
            }
        elif kind == "external_source":
            import_calls = [
                entry
                for entry in command_lifecycle
                if entry.get("tool") == "import_sequence"
            ]
            status = (
                "passed"
                if import_calls and report.get("outcome") == "passed"
                else "tracked"
            )
            evidence = {"import_sequence_calls": len(import_calls)}
        elif kind == "app_observer":
            observer_runtime_steps = [
                step
                for step in runtime_steps
                if str(step.get("stage", "")).startswith("observe_")
            ]
            failed_observers = [
                step
                for step in observer_runtime_steps
                if step.get("status") == "failed"
            ]
            passed_observers = [
                step
                for step in observer_runtime_steps
                if step.get("status") == "passed"
            ]
            if failed_observers:
                status = "failed"
            elif passed_observers:
                status = "passed"
            else:
                status = "not_run"
            evidence = {"observer_steps": len(observer_runtime_steps)}
        elif kind == "resource_read":
            resource_steps = [
                step
                for step in runtime_steps
                if "resource" in str(step.get("stage", ""))
            ]
            if resource_steps or mutation_ledger:
                status = "passed" if report.get("outcome") == "passed" else "tracked"
            else:
                status = "not_run"
            evidence = {
                "resource_steps": len(resource_steps),
                "mutation_claims": len(mutation_ledger),
            }
        elif kind == "artifact":
            status = "written" if report.get("workflow_ledger_path") else "not_run"
            evidence = {"workflow_ledger_path": report.get("workflow_ledger_path")}
        elif kind == "human_decision":
            status = "pending_feedback"

        progress.append(
            {
                "id": manifest_step.get("id"),
                "kind": kind,
                "execution_boundary": manifest_step.get("execution_boundary"),
                "status": status,
                "tool": tool,
                "description": manifest_step.get("description"),
                "evidence": evidence,
            }
        )

    return progress


def build_workflow_run_ledger(report: dict[str, Any]) -> dict[str, Any]:
    contract = report.get("workflow_contract")
    if not isinstance(contract, dict):
        contract = build_workflow_contract(str(report.get("workflow")))
    metrics = summarize_workflow_run_metrics(report)
    return {
        "schemaVersion": 1,
        "workflow": {
            "id": report.get("workflow"),
            "title": contract.get("title"),
            "mode": contract.get("mode"),
            "maturity": contract.get("maturity"),
            "demand": contract.get("demand"),
        },
        "outcome": report.get("outcome"),
        "classification": report.get("classification"),
        "failed_stage": report.get("failed_stage"),
        "duration_ms": report.get("duration_ms"),
        "success": metrics["success"],
        "metrics": metrics,
        "progress": build_workflow_progress(report, contract),
        "runtime_steps": dict_entries(report.get("steps")),
        "command_lifecycle": dict_entries(report.get("command_lifecycle")),
        "mutation_ledger": dict_entries(report.get("ledger")),
        "artifacts": {
            "transcript_path": report.get("transcript_path"),
            "report_path": report.get("report_path"),
            "workflow_ledger_path": report.get("workflow_ledger_path"),
        },
        "next_actions": report.get("next_actions", []),
    }


def discover_workflow_ledger_paths(root: Path) -> list[Path]:
    if root.is_file():
        return [root] if root.name == "workflow-ledger.json" else []
    if not root.exists():
        return []
    return sorted(root.glob("*/workflow-ledger.json"))


WorkflowLedgerFilter = Callable[[dict[str, Any]], bool]


def owned_workflow_ledger_filter(agent_identity_id: str) -> WorkflowLedgerFilter:
    """Resolve ledger ownership through its durable control-plane actions.

    Version-1 workflow ledgers do not carry an authoritative owner field. They
    do retain each admitted sidecar action id in ``command_lifecycle``; those
    action rows are the server-owned identity record. Missing, unresolved, or
    mixed-owner action references therefore fail closed on authenticated MCP
    surfaces while the unfiltered offline ledger tooling remains compatible.
    """

    store = get_control_plane_store()

    def is_owned(ledger: dict[str, Any]) -> bool:
        command_lifecycle = ledger.get("command_lifecycle")
        if not isinstance(command_lifecycle, list) or not command_lifecycle:
            return False
        action_ids: set[str] = set()
        for entry in command_lifecycle:
            if not isinstance(entry, dict):
                return False
            action_id = entry.get("action_id")
            if not isinstance(action_id, str) or not action_id.strip():
                return False
            action_ids.add(action_id.strip())
        for action_id in action_ids:
            action = store.get_agent_action(action_id)
            if action is None or action.get("agent_identity_id") != agent_identity_id:
                return False
        return True

    return is_owned


def load_workflow_run_ledgers(
    root: Path,
    *,
    ledger_filter: WorkflowLedgerFilter | None = None,
) -> list[dict[str, Any]]:
    ledgers: list[dict[str, Any]] = []
    for path in discover_workflow_ledger_paths(root):
        try:
            ledger = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        if ledger.get("schemaVersion") != 1:
            continue
        ledger["_path"] = str(path)
        if ledger_filter is not None and not ledger_filter(ledger):
            continue
        ledgers.append(ledger)
    return ledgers


def summarize_workflow_ledger_history(
    root: Path,
    *,
    ledger_filter: WorkflowLedgerFilter | None = None,
) -> dict[str, Any]:
    ledgers = load_workflow_run_ledgers(root, ledger_filter=ledger_filter)
    workflows: dict[str, dict[str, Any]] = {}
    demand: dict[str, dict[str, int]] = {}
    failures: list[dict[str, Any]] = []

    for ledger in ledgers:
        workflow = (
            ledger.get("workflow") if isinstance(ledger.get("workflow"), dict) else {}
        )
        workflow_id = str(workflow.get("id") or "unknown")
        demand_info = (
            workflow.get("demand") if isinstance(workflow.get("demand"), dict) else {}
        )
        demand_level = str(demand_info.get("level") or "unknown")
        metrics = (
            ledger.get("metrics") if isinstance(ledger.get("metrics"), dict) else {}
        )
        success = ledger.get("success") is True or ledger.get("outcome") == "passed"

        workflow_summary = workflows.setdefault(
            workflow_id,
            {
                "workflow": {
                    "id": workflow_id,
                    "title": workflow.get("title"),
                    "mode": workflow.get("mode"),
                    "maturity": workflow.get("maturity"),
                    "demand_level": demand_level,
                },
                "runs": 0,
                "passed_runs": 0,
                "failed_runs": 0,
                "successful_tool_flows": 0,
                "failed_tool_flows": 0,
                "latest": None,
            },
        )
        workflow_summary["runs"] += 1
        workflow_summary["passed_runs"] += 1 if success else 0
        workflow_summary["failed_runs"] += 0 if success else 1
        workflow_summary["successful_tool_flows"] += int(
            metrics.get("successful_tool_flows") or 0
        )
        workflow_summary["failed_tool_flows"] += int(
            metrics.get("failed_tool_flows") or 0
        )
        workflow_summary["latest"] = {
            "path": ledger.get("_path"),
            "outcome": ledger.get("outcome"),
            "classification": ledger.get("classification"),
            "failed_stage": ledger.get("failed_stage"),
            "duration_ms": ledger.get("duration_ms"),
        }

        demand_summary = demand.setdefault(
            demand_level,
            {"runs": 0, "passed_runs": 0, "failed_runs": 0},
        )
        demand_summary["runs"] += 1
        demand_summary["passed_runs"] += 1 if success else 0
        demand_summary["failed_runs"] += 0 if success else 1

        if not success:
            failures.append(
                {
                    "workflow_id": workflow_id,
                    "demand_level": demand_level,
                    "path": ledger.get("_path"),
                    "classification": ledger.get("classification"),
                    "failed_stage": ledger.get("failed_stage"),
                }
            )

    return {
        "root": str(root),
        "total_runs": len(ledgers),
        "workflows": workflows,
        "demand": demand,
        "failures": failures,
    }


def latest_workflow_ledger(
    root: Path,
    workflow_id: str | None = None,
    *,
    ledger_filter: WorkflowLedgerFilter | None = None,
) -> dict[str, Any] | None:
    ledgers = load_workflow_run_ledgers(root, ledger_filter=ledger_filter)
    if workflow_id is not None:
        ledgers = [
            ledger
            for ledger in ledgers
            if isinstance(ledger.get("workflow"), dict)
            and ledger["workflow"].get("id") == workflow_id
        ]
    if not ledgers:
        return None
    return ledgers[-1]


def workflow_run_summary_resource(
    root: Path = DEFAULT_RUNS_ROOT,
    *,
    ledger_filter: WorkflowLedgerFilter | None = None,
) -> dict[str, Any]:
    return {
        "exists": True,
        "resourceUri": "waypoint://workflow-runs/summary",
        "summary": summarize_workflow_ledger_history(
            root,
            ledger_filter=ledger_filter,
        ),
    }


def latest_workflow_run_resource(
    workflow_id: str,
    root: Path = DEFAULT_RUNS_ROOT,
    *,
    ledger_filter: WorkflowLedgerFilter | None = None,
) -> dict[str, Any]:
    ledger = latest_workflow_ledger(
        root,
        workflow_id,
        ledger_filter=ledger_filter,
    )
    return {
        "exists": ledger is not None,
        "resourceUri": workflow_run_latest_resource_uri(workflow_id),
        "workflowId": workflow_id,
        "ledger": ledger,
    }


def build_workflow_run_preparation(
    workflow_id: str,
    *,
    build_desktop: bool = True,
    timeout_seconds: int = 120,
    ledger_root: Path = DEFAULT_RUNS_ROOT,
    ledger_filter: WorkflowLedgerFilter | None = None,
) -> dict[str, Any]:
    contract = build_workflow_contract(workflow_id)
    timeout_seconds = max(1, int(timeout_seconds))
    api_dir = REPO_ROOT / "apps/api"
    argv = [
        "uv",
        "run",
        "python",
        "scripts/agent_mcp_console.py",
    ]
    if build_desktop:
        argv.append("--build")
    argv.extend(["--workflow", workflow_id, "--timeout", str(timeout_seconds)])

    summary = summarize_workflow_ledger_history(
        ledger_root,
        ledger_filter=ledger_filter,
    )
    workflow_summary = summary["workflows"].get(workflow_id)
    latest = latest_workflow_ledger(
        ledger_root,
        workflow_id,
        ledger_filter=ledger_filter,
    )
    latest_summary = None
    if latest is not None:
        latest_summary = {
            "outcome": latest.get("outcome"),
            "classification": latest.get("classification"),
            "failedStage": latest.get("failed_stage"),
            "durationMs": latest.get("duration_ms"),
            "path": latest.get("_path"),
            "nextActions": latest.get("next_actions", []),
        }

    return {
        "ok": True,
        "workflowId": workflow_id,
        "title": contract.get("title"),
        "mode": contract.get("mode"),
        "maturity": contract.get("maturity"),
        "demand": contract.get("demand"),
        "resources": {
            "manifest": "waypoint://workflow/manifest",
            "contract": workflow_resource_uri(workflow_id),
            "runSummary": "waypoint://workflow-runs/summary",
            "latestRun": workflow_run_latest_resource_uri(workflow_id),
        },
        "command": {
            "cwd": str(api_dir),
            "argv": argv,
            "shell": f"cd {shlex.quote(str(api_dir))} && {shlex.join(argv)}",
        },
        "expectedAppChanges": contract.get("expected_app_changes", []),
        "requiredPrimitives": contract.get("required_primitives", []),
        "verificationChannels": contract.get("verification_channels", []),
        "workflowSteps": contract.get("steps", []),
        "workflowBoundaries": summarize_workflow_boundaries(contract),
        "latestRun": latest_summary,
        "runHistory": workflow_summary
        or {
            "workflow": {
                "id": workflow_id,
                "title": contract.get("title"),
                "mode": contract.get("mode"),
                "maturity": contract.get("maturity"),
                "demand_level": (
                    contract.get("demand", {}).get("level")
                    if isinstance(contract.get("demand"), dict)
                    else "unknown"
                ),
            },
            "runs": 0,
            "passed_runs": 0,
            "failed_runs": 0,
            "successful_tool_flows": 0,
            "failed_tool_flows": 0,
            "latest": None,
        },
        "operatorNotes": [
            "This tool prepares a workflow run; it does not launch Electron.",
            "Run the command from the returned cwd, then inspect the workflow-runs resources.",
            "Use the latestRun and runHistory fields to decide whether to retry or narrow the failing layer first.",
        ],
    }


def render_workflow_ledger_summary(root: Path) -> str:
    summary = summarize_workflow_ledger_history(root)
    lines = [
        "# MCP Workflow Ledger Summary",
        "",
        f"Root: {summary['root']}",
        f"Runs: {summary['total_runs']}",
        "",
    ]

    if summary["total_runs"] == 0:
        lines.append("No workflow ledgers found.")
        return "\n".join(lines)

    lines.extend(["## Demand", ""])
    for level, demand_summary in sorted(summary["demand"].items()):
        lines.append(
            f"- {level}: {demand_summary['passed_runs']}/"
            f"{demand_summary['runs']} passed, "
            f"{demand_summary['failed_runs']} failed"
        )

    lines.extend(["", "## Workflows", ""])
    for workflow_id, workflow_summary in sorted(summary["workflows"].items()):
        workflow = workflow_summary["workflow"]
        runs = workflow_summary["runs"]
        passed = workflow_summary["passed_runs"]
        failed = workflow_summary["failed_runs"]
        successful_tool_flows = workflow_summary["successful_tool_flows"]
        failed_tool_flows = workflow_summary["failed_tool_flows"]
        latest = workflow_summary.get("latest") or {}
        lines.append(
            f"- {workflow_id} ({workflow.get('demand_level')}, "
            f"{workflow.get('mode')}, {workflow.get('maturity')}): "
            f"{passed}/{runs} passed, {failed} failed, "
            f"tool flows {successful_tool_flows} ok / {failed_tool_flows} failed, "
            f"latest={latest.get('outcome')} at {latest.get('path')}"
        )

    lines.extend(["", "## Recent Failures", ""])
    failures = (
        summary.get("failures") if isinstance(summary.get("failures"), list) else []
    )
    if not failures:
        lines.append("- None")
    else:
        for failure in failures[-10:]:
            lines.append(
                f"- {failure.get('workflow_id')} ({failure.get('demand_level')}): "
                f"{failure.get('classification')} at {failure.get('failed_stage')} "
                f"- {failure.get('path')}"
            )

    return "\n".join(lines)
