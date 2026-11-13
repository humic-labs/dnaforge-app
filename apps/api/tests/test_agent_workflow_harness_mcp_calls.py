"""Tests for shared MCP call helpers."""

from __future__ import annotations

import json

import pytest

from src.agent_workflow_harness.mcp_calls import (
    MCPCallFailure,
    call_renderer_tool,
    mcp_tool_error,
    read_mcp_json_resource,
)


class FakeClient:
    def __init__(self, response: dict):
        self.response = response
        self.requests: list[tuple[str, dict]] = []

    def request(self, method: str, params: dict | None = None) -> dict:
        self.requests.append((method, params or {}))
        return self.response


def test_call_renderer_tool_returns_renderer_result():
    client = FakeClient(
        {
            "result": {
                "isError": False,
                "structuredContent": {
                    "ok": True,
                    "result": {"tabId": "tab-1"},
                    "audit_id": "renderer-audit-1",
                },
                "_meta": {
                    "com.dnaforge/job": {
                        "jobId": "action-1",
                        "toolName": "open_tab",
                        "status": "completed",
                        "pool": "cpu_fast",
                    }
                },
            }
        }
    )

    assert call_renderer_tool(client, "open_tab", {"path": "pUC19.gb"}) == {
        "tabId": "tab-1"
    }
    assert client.requests == [
        ("tools/call", {"name": "open_tab", "arguments": {"path": "pUC19.gb"}})
    ]


def test_call_renderer_tool_rejects_mcp_tool_error():
    client = FakeClient(
        {
            "result": {
                "isError": True,
                "content": [
                    {
                        "type": "text",
                        "text": json.dumps(
                            {
                                "ok": False,
                                "error": {
                                    "code": "BAD_INPUT",
                                    "message": "bad input",
                                },
                            }
                        ),
                    }
                ],
            }
        }
    )

    with pytest.raises(MCPCallFailure, match="returned MCP error"):
        call_renderer_tool(client, "open_tab", {})


def test_mcp_tool_error_reads_exact_code_from_typed_text_envelope():
    tool_result = {
        "isError": True,
        "content": [
            {
                "type": "text",
                "text": json.dumps(
                    {
                        "ok": False,
                        "status": "failed",
                        "error": {
                            "code": "INSUFFICIENT_SCOPE",
                            "message": "scope rejected",
                            "retriable": False,
                        },
                    }
                ),
            }
        ],
    }

    assert mcp_tool_error(tool_result, name="get_workspace") == {
        "code": "INSUFFICIENT_SCOPE",
        "message": "scope rejected",
        "retriable": False,
    }


def test_mcp_tool_error_rejects_removed_structured_error_shape():
    with pytest.raises(MCPCallFailure, match="no MCP error content"):
        mcp_tool_error(
            {
                "isError": True,
                "structuredContent": {"error": {"code": "INSUFFICIENT_SCOPE"}},
            },
            name="get_workspace",
        )


def test_read_mcp_json_resource_returns_object_payload():
    client = FakeClient(
        {
            "result": {
                "contents": [
                    {"uri": "waypoint://workflow/manifest", "text": '{"ok": true}'}
                ]
            }
        }
    )

    assert read_mcp_json_resource(client, "waypoint://workflow/manifest") == {
        "ok": True
    }


def test_read_mcp_json_resource_uses_caller_failure_type():
    class CustomFailure(RuntimeError):
        pass

    client = FakeClient({"error": {"code": "missing"}})

    with pytest.raises(CustomFailure, match="JSON-RPC error"):
        read_mcp_json_resource(
            client,
            "waypoint://workflow/manifest",
            failure_type=CustomFailure,
        )
