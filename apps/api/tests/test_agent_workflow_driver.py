"""Tests for the agent-facing  workflow driver."""

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

from scripts.agent_workflow_driver import (
    DriverConfig,
    DriverFailure,
    drive_workflow_with_client,
    parse_capabilities,
)

WORKFLOW_ID = "ncbi-derivative-design"


def config(tmp_path: Path, *, dry_run: bool = False) -> DriverConfig:
    return DriverConfig(
        workflow_id=WORKFLOW_ID,
        api_url="http://127.0.0.1:8000",
        session_token="session",
        agent_identity="test-agent",
        agent_capabilities=["read-workspace"],
        build_desktop=False,
        workflow_timeout_seconds=90,
        command_timeout_seconds=120,
        output_dir=tmp_path,
        dry_run=dry_run,
    )


class FakeMCPClient:
    def __init__(
        self,
        *,
        latest_resource: dict[str, Any] | None = None,
        prepared: dict[str, Any] | None = None,
    ):
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.notifications: list[tuple[str, dict[str, Any]]] = []
        self.latest_resource = latest_resource or latest_run_resource(success=True)
        self.prepared = prepared or prepared_workflow()

    def request(
        self, method: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        params = params or {}
        self.calls.append((method, params))
        if method == "initialize":
            return {
                "result": {
                    "serverInfo": {"name": "dnaforge-mcp"},
                    "protocolVersion": "2024-11-05",
                }
            }
        if method == "resources/read":
            uri = params["uri"]
            if uri == "waypoint://workflow/manifest":
                return resource_response(
                    uri,
                    {
                        "exists": True,
                        "manifest": {
                            "workflows": [
                                {"id": "mini-derivative-design"},
                                {"id": WORKFLOW_ID},
                            ]
                        },
                    },
                )
            if uri == "waypoint://workflow-runs/summary":
                return resource_response(
                    uri,
                    {"exists": True, "summary": {"total_runs": 2}},
                )
            if uri == f"waypoint://workflow-runs/latest/{WORKFLOW_ID}":
                return resource_response(uri, self.latest_resource)
        if method == "tools/call" and params.get("name") == "workflow.prepare_run":
            return {
                "result": {
                    "isError": False,
                    "structuredContent": self.prepared,
                }
            }
        raise AssertionError(f"unexpected MCP request: {method} {params}")

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        self.notifications.append((method, params or {}))


def resource_response(uri: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "result": {
            "contents": [
                {
                    "uri": uri,
                    "mimeType": "application/json",
                    "text": json.dumps(payload),
                }
            ]
        }
    }


def prepared_workflow() -> dict[str, Any]:
    return {
        "ok": True,
        "workflowId": WORKFLOW_ID,
        "resources": {
            "manifest": "waypoint://workflow/manifest",
            "runSummary": "waypoint://workflow-runs/summary",
            "latestRun": f"waypoint://workflow-runs/latest/{WORKFLOW_ID}",
        },
        "command": {
            "cwd": str(Path(__file__).resolve().parents[1]),
            "argv": [
                "uv",
                "run",
                "python",
                "scripts/agent_mcp_console.py",
                "--workflow",
                WORKFLOW_ID,
                "--timeout",
                "90",
            ],
            "shell": "uv run python scripts/agent_mcp_console.py --workflow ncbi-derivative-design",
        },
        "operatorNotes": ["Run the command, then inspect the latest ledger."],
    }


def latest_run_resource(
    *, success: bool, workflow_id: str = WORKFLOW_ID
) -> dict[str, Any]:
    return {
        "exists": True,
        "resourceUri": f"waypoint://workflow-runs/latest/{WORKFLOW_ID}",
        "workflowId": WORKFLOW_ID,
        "ledger": {
            "workflow": {"id": workflow_id},
            "success": success,
            "outcome": "passed" if success else "failed",
            "classification": None if success else "observer_gap",
            "metrics": {
                "successful_tool_flows": 5,
                "failed_tool_flows": 0 if success else 1,
            },
            "next_actions": [] if success else ["Repair the observer."],
        },
    }


def test_parse_capabilities_accepts_csv_and_json_list():
    assert parse_capabilities("read-workspace, mutate-design") == [
        "read-workspace",
        "mutate-design",
    ]
    assert parse_capabilities('["read-workspace", "mutate-design"]') == [
        "read-workspace",
        "mutate-design",
    ]


def test_driver_prepares_workflow_without_executing_command(tmp_path):
    client = FakeMCPClient()

    summary = drive_workflow_with_client(client, config(tmp_path, dry_run=True))

    assert summary["ok"] is True
    assert summary["status"] == "prepared"
    assert summary["workflowId"] == WORKFLOW_ID
    assert summary["preparedCommand"]["argv"][:4] == [
        "uv",
        "run",
        "python",
        "scripts/agent_mcp_console.py",
    ]
    assert client.notifications == [("notifications/initialized", {})]
    assert [call[0] for call in client.calls] == [
        "initialize",
        "resources/read",
        "resources/read",
        "tools/call",
    ]
    summary_path = tmp_path / "agent-workflow-driver-summary.json"
    assert json.loads(summary_path.read_text())["status"] == "prepared"


def test_driver_executes_prepared_command_and_reads_latest_ledger(tmp_path):
    client = FakeMCPClient()
    runner_calls: list[tuple[list[str], Path, int, Path, Path]] = []

    def fake_runner(
        argv: list[str],
        cwd: Path,
        timeout_seconds: int,
        stdout_path: Path,
        stderr_path: Path,
    ) -> subprocess.CompletedProcess[Any]:
        runner_calls.append((argv, cwd, timeout_seconds, stdout_path, stderr_path))
        stdout_path.write_text("workflow ok\n", encoding="utf-8")
        stderr_path.write_text("", encoding="utf-8")
        return subprocess.CompletedProcess(argv, 0)

    summary = drive_workflow_with_client(
        client,
        config(tmp_path),
        command_runner=fake_runner,
    )

    assert summary["ok"] is True
    assert summary["status"] == "completed"
    assert summary["execution"]["returncode"] == 0
    assert summary["latestRun"]["matchesWorkflow"] is True
    assert summary["latestRun"]["success"] is True
    assert summary["nextActions"] == []
    assert runner_calls[0][0][5] == WORKFLOW_ID
    assert runner_calls[0][2] == 120
    assert Path(summary["execution"]["stdoutPath"]).read_text() == "workflow ok\n"
    assert [call[0] for call in client.calls] == [
        "initialize",
        "resources/read",
        "resources/read",
        "tools/call",
        "resources/read",
    ]


def test_driver_keeps_failed_run_evidence_without_raising(tmp_path):
    client = FakeMCPClient(latest_resource=latest_run_resource(success=False))

    def fake_runner(
        argv: list[str],
        cwd: Path,
        timeout_seconds: int,
        stdout_path: Path,
        stderr_path: Path,
    ) -> subprocess.CompletedProcess[Any]:
        stdout_path.write_text("", encoding="utf-8")
        stderr_path.write_text("workflow failed\n", encoding="utf-8")
        return subprocess.CompletedProcess(argv, 1)

    summary = drive_workflow_with_client(
        client,
        config(tmp_path),
        command_runner=fake_runner,
    )

    assert summary["ok"] is False
    assert summary["execution"]["returncode"] == 1
    assert summary["latestRun"]["success"] is False
    assert summary["nextActions"] == ["Repair the observer."]
    assert {item["name"]: item["passed"] for item in summary["checks"]}[
        "latest_ledger_reports_success"
    ] is False


def test_driver_rejects_prepare_result_for_wrong_workflow(tmp_path):
    client = FakeMCPClient(
        prepared={**prepared_workflow(), "workflowId": "mini-derivative-design"}
    )

    with pytest.raises(DriverFailure, match="returned workflow"):
        drive_workflow_with_client(client, config(tmp_path, dry_run=True))
