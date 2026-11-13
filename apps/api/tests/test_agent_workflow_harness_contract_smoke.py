"""Tests for  MCP contract smoke helpers."""

from __future__ import annotations

import json
from typing import Any

import pytest

from src.agent_workflow_harness.contract_smoke import (
    RETAINED_RENDERER_TOOLS,
    check_renderer_bridge,
    check_tool_catalog,
    check_workflow_prepare,
)
from src.agent_workflow_harness.runtime import HarnessFailure


class FakeClient:
    def __init__(self, responses: dict[str, dict[str, Any]]):
        self.responses = responses
        self.requests: list[tuple[str, dict[str, Any] | None]] = []

    def request(
        self, method: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        self.requests.append((method, params))
        response_key = method
        if method == "tools/call" and params:
            response_key = f"tools/call:{params.get('name')}"
        return self.responses[response_key]


def test_check_tool_catalog_accepts_retained_renderer_tools():
    client = FakeClient(
        {
            "tools/list": {
                "result": {
                    "tools": [
                        {"name": tool_name}
                        for tool_name in [
                            *RETAINED_RENDERER_TOOLS,
                            "workflow.prepare_run",
                            "artifact.register",
                            "analysis_run.create",
                            "resource_link.create",
                        ]
                    ]
                }
            }
        }
    )

    tool_names = check_tool_catalog(client)

    assert "get_workspace" in tool_names
    assert "list_files" in tool_names
    assert "read_file" in tool_names
    assert "get_file_changes" in tool_names


def test_check_tool_catalog_rejects_missing_renderer_tool():
    client = FakeClient(
        {
            "tools/list": {
                "result": {
                    "tools": [
                        {"name": tool_name}
                        for tool_name in [
                            *[
                                name
                                for name in RETAINED_RENDERER_TOOLS
                                if name != "create_design"
                            ],
                            "workflow.prepare_run",
                            "artifact.register",
                            "analysis_run.create",
                            "resource_link.create",
                        ]
                    ]
                }
            }
        }
    )

    with pytest.raises(HarnessFailure, match="create_design not registered"):
        check_tool_catalog(client)


def test_check_workflow_prepare_returns_runnable_command_evidence():
    client = FakeClient(
        {
            "tools/call:workflow.prepare_run": {
                "result": {
                    "isError": False,
                    "structuredContent": {
                        "workflowId": "ncbi-derivative-design",
                        "resources": {
                            "contract": "waypoint://workflow/ncbi-derivative-design",
                            "latestRun": (
                                "waypoint://workflow-runs/latest/"
                                "ncbi-derivative-design"
                            ),
                        },
                        "command": {
                            "argv": [
                                "uv",
                                "run",
                                "python",
                                "scripts/agent_mcp_console.py",
                                "--workflow",
                                "ncbi-derivative-design",
                            ]
                        },
                    },
                }
            }
        }
    )

    evidence = check_workflow_prepare(client)

    assert evidence["workflow_id"] == "ncbi-derivative-design"
    assert evidence["contract_resource"] == "waypoint://workflow/ncbi-derivative-design"
    assert "--workflow" in evidence["command_argv"]


def test_check_renderer_bridge_validates_fake_renderer_forwarding(tmp_path):
    renderer_log = tmp_path / "renderer-calls.jsonl"
    renderer_log.write_text(
        json.dumps(
            {
                "headers": {
                    "x-dnaforge-session": "renderer-token",
                    "x-dnaforge-action-id": "job-1",
                    "x-dnaforge-agent-capabilities": json.dumps(["read-workspace"]),
                },
                "body": {"tool_name": "get_workspace", "action_id": "job-1"},
            }
        )
        + "\n"
    )
    client = FakeClient(
        {
            "tools/call:get_workspace": {
                "result": {
                    "isError": False,
                    "structuredContent": {
                        "ok": True,
                        "result": {"panels": [], "focusedPanelId": "main"},
                        "audit_id": "renderer-audit-1",
                    },
                    "_meta": {
                        "com.dnaforge/job": {
                            "jobId": "job-1",
                            "toolName": "get_workspace",
                            "status": "completed",
                            "pool": "cpu_fast",
                        },
                    },
                }
            },
            "resources/read": {
                "result": {
                    "contents": [
                        {
                            "uri": "waypoint://action/job-1",
                            "text": json.dumps(
                                {
                                    "exists": True,
                                    "resourceUri": "waypoint://action/job-1",
                                    "action": {
                                        "id": "job-1",
                                        "toolName": "get_workspace",
                                        "result": {
                                            "ok": True,
                                            "audit_id": "renderer-audit-1",
                                        },
                                    },
                                    "auditRecords": [
                                        {"id": "audit-1", "actionId": "job-1"}
                                    ],
                                }
                            ),
                        }
                    ]
                }
            },
        }
    )

    forwarded_scope, renderer_audit_id = check_renderer_bridge(
        client=client,
        renderer_call_log=renderer_log,
        renderer_token="renderer-token",
        expected_scope=["read-workspace"],
    )

    assert forwarded_scope == ["read-workspace"]
    assert renderer_audit_id == "renderer-audit-1"
